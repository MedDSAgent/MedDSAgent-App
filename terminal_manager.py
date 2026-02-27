"""
Manages PTY-backed bash processes for the integrated terminal panel.
Each terminal is an independent /bin/bash session connected to the browser
via WebSocket + xterm.js. Terminals are in-memory only — they are not
persisted across server restarts. After a WebSocket disconnect, a terminal
stays alive for RECONNECT_TIMEOUT_SECONDS to allow page-refresh reconnects.
"""

import os
import asyncio
import fcntl
import struct
import termios
import logging
from typing import Dict, Optional

logger = logging.getLogger(__name__)

RECONNECT_TIMEOUT_SECONDS = 300  # 5 minutes

# When set, terminals exec into this Docker container instead of running bash
# locally.  Set via the BACKEND_CONTAINER environment variable.
# Example: "meddsagent-app-backend-1"
BACKEND_CONTAINER = os.environ.get("BACKEND_CONTAINER", "")


class TerminalProcess:
    """A single PTY-backed terminal session."""

    def __init__(self, terminal_id: str, master_fd: int, proc: "asyncio.subprocess.Process"):
        self.terminal_id = terminal_id
        self.master_fd = master_fd
        self.proc = proc
        self.output_queue: asyncio.Queue = asyncio.Queue()
        self._destroy_task: Optional[asyncio.Task] = None
        self._loop = asyncio.get_running_loop()

    # ------------------------------------------------------------------
    # PTY I/O
    # ------------------------------------------------------------------

    def start_reading(self):
        """Register master_fd with the event loop so PTY output flows into the queue."""
        self.drain_queue()
        self._loop.add_reader(self.master_fd, self._on_readable)

    def stop_reading(self):
        """Unregister the master_fd reader (called on WebSocket disconnect)."""
        try:
            self._loop.remove_reader(self.master_fd)
        except Exception:
            pass

    def _on_readable(self):
        try:
            data = os.read(self.master_fd, 4096)
            self.output_queue.put_nowait(data)
        except OSError:
            # PTY closed (bash exited)
            self.output_queue.put_nowait(None)

    def drain_queue(self):
        """Discard buffered output — called when a new WebSocket connection attaches."""
        while not self.output_queue.empty():
            try:
                self.output_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

    def write(self, data: bytes):
        try:
            os.write(self.master_fd, data)
        except OSError:
            pass

    def resize(self, cols: int, rows: int):
        try:
            fcntl.ioctl(
                self.master_fd,
                termios.TIOCSWINSZ,
                struct.pack("HHHH", rows, cols, 0, 0),
            )
        except OSError:
            pass

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def cancel_destroy_timer(self):
        if self._destroy_task and not self._destroy_task.done():
            self._destroy_task.cancel()
            self._destroy_task = None

    def close(self):
        self.stop_reading()
        try:
            self.proc.kill()
        except (ProcessLookupError, OSError):
            pass
        try:
            os.close(self.master_fd)
        except OSError:
            pass


class TerminalManager:
    """Manages the lifecycle of all TerminalProcess instances."""

    def __init__(self):
        self.terminals: Dict[str, TerminalProcess] = {}

    async def create(self, terminal_id: str, work_dir: str) -> TerminalProcess:
        """Spawn a new bash process attached to a PTY."""
        if not os.path.isdir(work_dir):
            work_dir = os.path.expanduser("~")

        master_fd, slave_fd = os.openpty()

        # Set a sensible default terminal size
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        os.set_inheritable(slave_fd, True)

        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"

        if BACKEND_CONTAINER:
            # Run bash inside the backend container so the terminal shares the
            # same Python environment (pandas, matplotlib, pip-installed libs,
            # etc.) as the agent's Python tool.  The workspace volume is
            # mounted at the same path in both containers, so --workdir works
            # transparently.
            cmd = [
                "docker", "exec",
                "-it",
                f"--workdir={work_dir}",
                BACKEND_CONTAINER,
                "/bin/bash",
            ]
            subprocess_cwd = None   # cwd is irrelevant for the docker exec host process
        else:
            cmd = ["/bin/bash"]
            subprocess_cwd = work_dir

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            cwd=subprocess_cwd,
            env=env,
            close_fds=True,
            preexec_fn=os.setsid,
        )
        os.close(slave_fd)

        terminal = TerminalProcess(terminal_id, master_fd, proc)
        self.terminals[terminal_id] = terminal
        logger.info("Terminal %s created (pid=%s) cwd=%s", terminal_id, proc.pid, work_dir)
        return terminal

    async def destroy(self, terminal_id: str):
        """Kill the PTY process and remove the terminal entry."""
        terminal = self.terminals.pop(terminal_id, None)
        if terminal:
            terminal.cancel_destroy_timer()
            terminal.close()
            logger.info("Terminal %s destroyed", terminal_id)

    def schedule_destroy(self, terminal_id: str):
        """Start a countdown to auto-destroy a disconnected terminal after 5 minutes."""
        terminal = self.terminals.get(terminal_id)
        if not terminal:
            return

        terminal.cancel_destroy_timer()

        async def _delayed():
            try:
                await asyncio.sleep(RECONNECT_TIMEOUT_SECONDS)
                await self.destroy(terminal_id)
                logger.info(
                    "Terminal %s auto-destroyed after %ds idle",
                    terminal_id,
                    RECONNECT_TIMEOUT_SECONDS,
                )
            except asyncio.CancelledError:
                pass

        terminal._destroy_task = asyncio.ensure_future(_delayed())

    async def destroy_all(self):
        """Destroy all terminals — called on server shutdown."""
        for tid in list(self.terminals.keys()):
            await self.destroy(tid)