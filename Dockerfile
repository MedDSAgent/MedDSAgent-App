FROM python:3.11-slim

# Define the build argument (default to false)
ARG INSTALL_R=false

# Install system dependencies
# check the ARG; if true, add R dependencies to the install list.
# libgl1 and libglib2.0-0 are required by OpenCV (transitive dep of docling).
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libreadline-dev \
    git \
    libgl1 \
    libglib2.0-0 \
    # Conditional R installation logic
    $(if [ "$INSTALL_R" = "true" ]; then echo "r-base r-base-dev libopenblas-dev"; fi) \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Install PyTorch CPU-only FIRST to prevent pip from pulling the
# default CUDA-enabled wheels (~1.8 GB each for torch + torchvision).
# The CPU-only wheels are ~600 MB total, saving ~2.5 GB+ in image size.
RUN pip install --no-cache-dir \
    torch torchvision \
    --index-url https://download.pytorch.org/whl/cpu

# Install Python dependencies (excluding rpy2)
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# Install rpy2 ONLY if R was requested
# rpy2 compilation fails without R headers, so this must be separate.
RUN if [ "$INSTALL_R" = "true" ]; then \
        pip install --no-cache-dir rpy2>=3.5.0; \
    fi

# Copy application code
COPY analyst_agent /app/analyst_agent
COPY pyproject.toml /app/

# Install the package (use CPU torch index so docling doesn't pull CUDA wheels)
RUN pip install --no-cache-dir -e . --extra-index-url https://download.pytorch.org/whl/cpu

# =============================================================================
# Workspace Configuration
# =============================================================================
# Create the root workspace directory
RUN mkdir -p /workspace

# Set environment variables
ENV PYTHONUNBUFFERED=1
# Rename workdir -> workspace
ENV WORK_DIR=/workspace
ENV HOST=0.0.0.0
ENV PORT=8000
ENV TERM=xterm-256color

# Expose port for API server
EXPOSE 8000

# Default command
CMD ["python", "-m", "analyst_agent.server"]