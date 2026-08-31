FROM node:20-alpine AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm install
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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt ./requirements.txt

# Demucs 4.0.1 requires torchaudio < 2.1. Use the matching official CPU
# PyTorch stack. TorchAudio 2.0.2 predates the TorchCodec save dependency.
RUN python -m pip install --no-cache-dir --upgrade pip setuptools wheel \
    && python -m pip install --no-cache-dir \
       torch==2.0.1+cpu \
       torchaudio==2.0.2+cpu \
       --index-url https://download.pytorch.org/whl/cpu \
    && python -m pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY --from=frontend-builder /frontend/dist ./static
RUN mkdir -p /data/.cache/torch /data/tools

EXPOSE 8000
CMD ["sh", "-c", "python -m app.prestart && uvicorn app.entry:app --host 0.0.0.0 --port ${PORT:-8000}"]
