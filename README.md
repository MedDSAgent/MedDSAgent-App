# MedDSAgent App

**MedDSAgent** is a Medical Data Science Agent — an AI-powered web application that helps you analyze medical and clinical datasets through a conversational interface. It pairs a backend reasoning engine with a browser-based frontend that includes a chat interface and an integrated terminal, so you can explore data, run code, and review results all in one place.

## Architecture

| Service | Description | Port |
|---------|-------------|------|
| `backend` | MedDSAgent REST API / AI engine | 7842 |
| `app` | Web UI + WebSocket terminal + reverse proxy | 8000 |

Both services share a persistent `workspace` volume so files written by the agent are immediately accessible in the terminal.

---

## Installation

### Option 1 — Download and run with Docker Compose

1. Download the compose file:

```bash
curl -O https://raw.githubusercontent.com/daviden1013/MedDSAgent-App/main/docker-compose.hub.yml
```

2. Start the application:

```bash
docker compose -f docker-compose.hub.yml up
```

3. Open your browser and navigate to [http://localhost:8000](http://localhost:8000).

---

### Option 2 — One-liner (download and run in a single command)

```bash
curl -fsSL https://raw.githubusercontent.com/daviden1013/MedDSAgent-App/main/docker-compose.hub.yml | docker compose -f - up
```

Then open [http://localhost:8000](http://localhost:8000).

---

## Persisting Session Data to a Local Directory

By default, the agent stores session files inside a Docker named volume (`workspace`), which is managed by Docker and not directly accessible on your host. To store session data in a local directory instead, set the `LOCAL_WORKSPACE` environment variable to an absolute path before starting the stack.

**macOS / Linux**

```bash
LOCAL_WORKSPACE=/path/to/local/dir docker compose -f docker-compose.hub.yml up
```

Or export it first:

```bash
export LOCAL_WORKSPACE=/home/user/medds-workspace
docker compose -f docker-compose.hub.yml up
```

**Windows (Command Prompt)**

```cmd
set LOCAL_WORKSPACE=C:\Users\user\medds-workspace
docker compose -f docker-compose.hub.yml up
```

**Windows (PowerShell)**

```powershell
$env:LOCAL_WORKSPACE = "C:\Users\user\medds-workspace"
docker compose -f docker-compose.hub.yml up
```

The directory will be created automatically if it doesn't exist. Files written by the agent (datasets, results, scripts, etc.) will then be directly accessible on your host at that path.

> **Note:** When `LOCAL_WORKSPACE` is not set, the named Docker volume `workspace` is used and data persists across container restarts until you run `docker compose down -v`.

---

## Stopping the Application

```bash
docker compose -f docker-compose.hub.yml down
```

To also remove the shared workspace volume:

```bash
docker compose -f docker-compose.hub.yml down -v
```

---

## For Developers

### Running Locally (without Docker)

Both repos must be cloned side-by-side. The backend runs first, then the frontend points at it.

**Prerequisites:** Python ≥ 3.10

---

**1. Start the backend (MedDSAgent-Core)**

```bash
cd MedDSAgent-Core
pip install -e ".[server]"
medds-server
```

The backend listens on **http://localhost:7842** by default.

---

**2. Start the frontend (MedDSAgent-App)**

In a second terminal:

```bash
cd MedDSAgent-App
pip install -r requirements.txt
BACKEND_URL=http://localhost:7842 python server.py
```

Then open **http://localhost:8000** in your browser.

---

**Environment variables (frontend)**

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKEND_URL` | `http://localhost:5000` | URL of the MedDSAgent backend |
| `PORT` | `8000` | Port the frontend listens on |
| `WORK_DIR` | `./workspace` | Shared workspace directory |
| `RELOAD` | `false` | Enable uvicorn auto-reload |

**Environment variables (backend)**

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7842` | Port the backend listens on |
| `WORK_DIR` | `./workspace` | Workspace root for session files |
| `RELOAD` | `false` | Enable uvicorn auto-reload |

---

### Publishing images to Docker Hub

After making changes, build the images with Docker Compose and then tag and push them to Docker Hub.

**1. Build**

```bash
docker compose build
```

**2. Tag**

```bash
docker tag meddsagent-app-backend daviden1013/meddsagent-backend:0.1.0
docker tag meddsagent-app-backend daviden1013/meddsagent-backend:latest
docker tag meddsagent-app-app     daviden1013/meddsagent-app:0.1.0
docker tag meddsagent-app-app     daviden1013/meddsagent-app:latest
```

**3. Push**

```bash
docker push daviden1013/meddsagent-backend:0.1.0
docker push daviden1013/meddsagent-backend:latest
docker push daviden1013/meddsagent-app:0.1.0
docker push daviden1013/meddsagent-app:latest
```

---

## Requirements

- [Docker](https://docs.docker.com/get-docker/) with the Compose plugin (v2+)
