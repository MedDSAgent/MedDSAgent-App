FROM python:3.11-slim

# ---------------------------------------------------------------------------
# Build-time flags for optional heavy dependencies
#   docker build -f backend.Dockerfile \
#       --build-arg INSTALL_R=true --build-arg INSTALL_DOCLING=true .
# ---------------------------------------------------------------------------
ARG INSTALL_R=false
ARG INSTALL_DOCLING=false

# System packages.
# R dev libs (libcurl4-openssl-dev, libssl-dev, libxml2-dev) allow
# R packages to compile from source when INSTALL_R=true.
# libgl1 / libglib2.0-0 are needed by Docling/OpenCV when INSTALL_DOCLING=true.
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

# Install MedDSAgent with the [server] extra (FastAPI + Uvicorn).
# Installed from the GitHub source since no PyPI release is required.
RUN pip install --no-cache-dir \
    "medds-agent[server] @ git+https://github.com/daviden1013/MedDSAgent.git"

# rpy2 bridges Python → R. r-base must already be installed (see above).
RUN if [ "$INSTALL_R" = "true" ]; then \
        pip install --no-cache-dir rpy2; \
    fi

# Docling for PDF / document ingestion. Pulls in PyTorch (~3 GB).
RUN if [ "$INSTALL_DOCLING" = "true" ]; then \
        pip install --no-cache-dir docling; \
    fi

ENV HOST=0.0.0.0
ENV PORT=5000
ENV WORK_DIR=/workspace
ENV PYTHONUNBUFFERED=1

RUN mkdir -p /workspace

EXPOSE 5000

CMD ["medds-server"]
