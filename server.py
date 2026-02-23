"""
Frontend server for MedDSAgent-App.

Responsibilities:
  1. Serve the web UI (HTML / CSS / JS) at GET /
  2. WebSocket terminal support via PTY-backed bash sessions
  3. Reverse-proxy all other HTTP requests to the MedDSAgent REST API backend

Configuration (environment variables):
  BACKEND_URL   URL of the MedDSAgent backend  (default: http://localhost:5000)
  HOST          Bind address                    (default: 0.0.0.0)
  PORT          HTTP listen port                (default: 8000)
  WORK_DIR      Shared workspace root           (default: ./workspace)
  RELOAD        Enable uvicorn auto-reload      (default: false)
"""

import os
import json
import asyncio
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Query
from fastapi.responses import HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from terminal_manager import TerminalManager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# =============================================================================
# Configuration
# =============================================================================

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:5000").rstrip("/")
HOST        = os.environ.get("HOST", "0.0.0.0")
PORT        = int(os.environ.get("PORT", 8000))
WORK_DIR    = os.environ.get("WORK_DIR", "./workspace")

# =============================================================================
# Application lifespan
# =============================================================================

terminal_manager = TerminalManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("MedDSAgent-App frontend server starting")
    logger.info("  Backend : %s", BACKEND_URL)
    logger.info("  Work dir: %s", os.path.abspath(WORK_DIR))
    yield
    await terminal_manager.destroy_all()
    logger.info("MedDSAgent-App server shut down")


app = FastAPI(title="MedDSAgent-App", lifespan=lifespan)

# =============================================================================
# Static files & HTML template
# =============================================================================

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app.mount(
    "/static",
    StaticFiles(directory=os.path.join(_BASE_DIR, "frontend", "static")),
    name="static",
)

templates = Jinja2Templates(
    directory=os.path.join(_BASE_DIR, "frontend", "templates")
)


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


# =============================================================================
# WebSocket terminal  ─  /ws/terminal/{terminal_id}?session_id=...
# =============================================================================

@app.websocket("/ws/terminal/{terminal_id}")
async def terminal_ws(
    websocket: WebSocket,
    terminal_id: str,
    session_id: str = Query(default=""),
):
    await websocket.accept()

    # Resolve the working directory for this terminal.
    # Mirror the directory layout used by the MedDSAgent SessionManager:
    #   {WORK_DIR}/sessions/{session_id}/
    if session_id:
        work_dir = os.path.join(WORK_DIR, "sessions", session_id)
    else:
        work_dir = WORK_DIR
    work_dir = os.path.abspath(work_dir)

    # Get an existing terminal (reconnect) or create a fresh one.
    terminal = terminal_manager.terminals.get(terminal_id)
    if terminal is None:
        terminal = await terminal_manager.create(terminal_id, work_dir)
    else:
        terminal.cancel_destroy_timer()

    terminal.start_reading()

    async def _forward_output():
        """Stream PTY output to the WebSocket client."""
        while True:
            data = await terminal.output_queue.get()
            if data is None:          # bash exited
                try:
                    await websocket.close()
                except Exception:
                    pass
                break
            try:
                await websocket.send_bytes(data)
            except Exception:
                break

    send_task = asyncio.create_task(_forward_output())

    try:
        while True:
            msg = await websocket.receive()
            if msg.get("bytes"):
                terminal.write(msg["bytes"])
            elif msg.get("text"):
                try:
                    payload = json.loads(msg["text"])
                    if payload.get("type") == "resize":
                        terminal.resize(
                            int(payload.get("cols", 80)),
                            int(payload.get("rows", 24)),
                        )
                except (json.JSONDecodeError, ValueError, TypeError):
                    pass
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("Terminal WS error for %s: %s", terminal_id, exc)
    finally:
        send_task.cancel()
        terminal.stop_reading()
        terminal_manager.schedule_destroy(terminal_id)


# =============================================================================
# Terminal DELETE  ─  /terminal/{terminal_id}
# (called by app.js when a terminal tab is explicitly closed)
# =============================================================================

@app.delete("/terminal/{terminal_id}")
async def delete_terminal(terminal_id: str):
    await terminal_manager.destroy(terminal_id)
    return {"status": "destroyed", "terminal_id": terminal_id}


# =============================================================================
# Reverse proxy → MedDSAgent REST API backend
# =============================================================================

# Generous timeouts: chat SSE streams can run for minutes.
_PROXY_TIMEOUT = httpx.Timeout(connect=10.0, read=300.0, write=60.0, pool=10.0)

# HTTP/1.1 hop-by-hop headers must not be forwarded.
_HOP_BY_HOP = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
})


def _forward_headers(request: Request) -> dict:
    """Return request headers suitable for forwarding (drop hop-by-hop + Host)."""
    return {
        k: v
        for k, v in request.headers.items()
        if k.lower() not in _HOP_BY_HOP and k.lower() != "host"
    }


@app.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
)
async def proxy(request: Request, path: str):
    """Forward any unmatched request to the MedDSAgent backend."""
    qs = request.url.query
    target = f"{BACKEND_URL}/{path}" + (f"?{qs}" if qs else "")
    headers = _forward_headers(request)

    # SSE streaming (chat endpoint) — pipe bytes as they arrive.
    if "text/event-stream" in request.headers.get("accept", ""):
        body = await request.body()

        async def _sse_generator():
            async with httpx.AsyncClient(timeout=_PROXY_TIMEOUT) as client:
                try:
                    async with client.stream(
                        request.method, target, headers=headers, content=body
                    ) as resp:
                        async for chunk in resp.aiter_bytes():
                            yield chunk
                except httpx.ConnectError:
                    yield b'data: {"type":"error","data":"Backend unreachable"}\n\n'
                except httpx.TimeoutException:
                    yield b'data: {"type":"error","data":"Backend request timed out"}\n\n'

        return StreamingResponse(
            _sse_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
        )

    # Standard (buffered) requests.
    body = await request.body()
    async with httpx.AsyncClient(timeout=_PROXY_TIMEOUT) as client:
        try:
            resp = await client.request(
                method=request.method,
                url=target,
                headers=headers,
                content=body,
            )
        except httpx.ConnectError:
            return Response(
                content=json.dumps({
                    "detail": "Backend unreachable. Is the MedDSAgent server running?"
                }),
                status_code=503,
                media_type="application/json",
            )
        except httpx.TimeoutException:
            return Response(
                content=json.dumps({"detail": "Backend request timed out."}),
                status_code=504,
                media_type="application/json",
            )

    # Strip hop-by-hop headers from the backend response before forwarding.
    resp_headers = {
        k: v
        for k, v in resp.headers.items()
        if k.lower() not in _HOP_BY_HOP
    }

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers=resp_headers,
        media_type=resp.headers.get("content-type"),
    )


# =============================================================================
# Entry point
# =============================================================================

def main():
    import uvicorn
    reload = os.environ.get("RELOAD", "false").lower() in ("true", "1", "yes")
    uvicorn.run("server:app", host=HOST, port=PORT, reload=reload)


if __name__ == "__main__":
    main()