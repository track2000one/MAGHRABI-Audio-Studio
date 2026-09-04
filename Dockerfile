FROM node:22-alpine AS frontend-builder
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.10-slim AS python-builder
ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && python -m venv "$VIRTUAL_ENV"

WORKDIR /build
COPY backend/requirements.lock.txt ./requirements.lock.txt

# Install the complete Python graph from the source-controlled SHA-256 lock.
# The protected Railway CPU Torch/TorchAudio stack is part of this same lock.
RUN python -m pip install --no-cache-dir --upgrade pip setuptools wheel \
    && python -m pip install --no-cache-dir --require-hashes \
       --index-url https://pypi.org/simple \
       --extra-index-url https://download.pytorch.org/whl/cpu \
       -r requirements.lock.txt

FROM python:3.10-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    TORCH_HOME=/data/.cache/torch \
    XDG_CACHE_HOME=/data/.cache \
    PORT=8000 \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       libsndfile1 \
       fontconfig \
       fonts-dejavu-core \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=python-builder /opt/venv /opt/venv
COPY backend/app ./app
COPY --from=frontend-builder /frontend/dist ./static
RUN mkdir -p /data/.cache/torch /data/tools /data/video

EXPOSE 8000
CMD ["sh", "-c", "python -m app.prestart && uvicorn app.entry:app --host 0.0.0.0 --port ${PORT:-8000} --no-server-header"]
