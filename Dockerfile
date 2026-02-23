FROM python:3.11-slim

# ---------------------------------------------------------------------------
# Build-time flags for optional heavy dependencies
#   docker build --build-arg INSTALL_R=true --build-arg INSTALL_DOCLING=true
# ---------------------------------------------------------------------------
ARG INSTALL_R=false
ARG INSTALL_DOCLING=false

# System dependencies.
# libgl1 / libglib2.0-0 are required by Docling/OpenCV when INSTALL_DOCLING=true.
# R dev libs (libcurl4-openssl-dev, libssl-dev, libxml2-dev) let R packages
# compile from source when INSTALL_R=true.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    libgl1 \
    libglib2.0-0 \
    && if [ "$INSTALL_R" = "true" ]; then \
        apt-get install -y --no-install-recommends \
            r-base \
            r-base-dev \
            libcurl4-openssl-dev \
            libssl-dev \
            libxml2-dev; \
    fi \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python dependencies (layer-cache friendly — only rebuilds when requirements change)
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# Docling is installed in its own layer because it pulls in PyTorch (~3 GB).
# Keeping it separate preserves the cache for the lighter layers above.
RUN if [ "$INSTALL_DOCLING" = "true" ]; then \
        pip install --no-cache-dir docling; \
    fi

COPY server.py           /app/
COPY terminal_manager.py /app/
COPY frontend/           /app/frontend/

# =============================================================================
# Runtime configuration (all overridable via environment / docker-compose)
# =============================================================================
ENV BACKEND_URL=http://localhost:5000
ENV WORK_DIR=/workspace
ENV HOST=0.0.0.0
ENV PORT=8000
ENV PYTHONUNBUFFERED=1
ENV TERM=xterm-256color

RUN mkdir -p /workspace

EXPOSE 8000

CMD ["python", "server.py"]
