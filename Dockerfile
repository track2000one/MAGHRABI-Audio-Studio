FROM node:20-alpine AS frontend-builder
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.10-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    TORCH_HOME=/data/.cache/torch \
    XDG_CACHE_HOME=/data/.cache \
    PORT=8000

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       libsndfile1 \
       build-essential \
       fontconfig \
       fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.lock.txt ./requirements.lock.txt

# Creator V34 installs the complete Python graph from the source-controlled
# SHA-256 lock. The protected CPU Torch stack is part of this same lock.
RUN python -m pip install --no-cache-dir --upgrade pip setuptools wheel \
    && python -m pip install --no-cache-dir --require-hashes \
       --index-url https://pypi.org/simple \
       --extra-index-url https://download.pytorch.org/whl/cpu \
       -r requirements.lock.txt

COPY backend/app ./app
COPY --from=frontend-builder /frontend/dist ./static
RUN mkdir -p /data/.cache/torch /data/tools /data/video

EXPOSE 8000
CMD ["sh", "-c", "python -m app.prestart && uvicorn app.entry:app --host 0.0.0.0 --port ${PORT:-8000}"]
