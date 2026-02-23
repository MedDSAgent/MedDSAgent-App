FROM python:3.11-slim

# Install system dependencies required by the PTY terminal backend.
# libgl1 / libglib2.0-0 are only needed if you later add docling/OpenCV;
# they are kept here to avoid a separate layer rebuild.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    libgl1 \
    libglib2.0-0 \
    # R runtime and compiler toolchain for installing R packages from source
    r-base \
    r-base-dev \
    libcurl4-openssl-dev \
    libssl-dev \
    libxml2-dev \
    && rm -rf /var/lib/apt/lists/*

# Working directory inside the container
WORKDIR /app

# Install Python dependencies first (layer-cache friendly)
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# Docling is installed separately — it pulls in PyTorch and is ~3 GB.
# Keeping it in its own layer preserves cache for the lighter deps above.
RUN pip install --no-cache-dir docling

# Copy application code
COPY server.py          /app/
COPY terminal_manager.py /app/
COPY frontend/          /app/frontend/

# =============================================================================
# Runtime configuration
# =============================================================================
# BACKEND_URL  — URL of the MedDSAgent REST API (set at runtime or via compose)
ENV BACKEND_URL=http://localhost:5000
# WORK_DIR     — shared workspace root; mount the same volume as the backend
ENV WORK_DIR=/workspace
ENV HOST=0.0.0.0
ENV PORT=8000
ENV PYTHONUNBUFFERED=1
ENV TERM=xterm-256color

# Create the default workspace directory
RUN mkdir -p /workspace

# Expose the frontend port
EXPOSE 8000

# Start the frontend server
CMD ["python", "server.py"]
