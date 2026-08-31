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
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt ./requirements.txt

# Railway is CPU-only. Pin a mutually compatible PyTorch / TorchAudio / TorchCodec
# stack from the official CPU wheel index so Demucs can save WAV stems reliably.
RUN pip install --no-cache-dir \
      torch==2.8.0 \
      torchaudio==2.8.0 \
      torchcodec==0.7.0 \
      --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY --from=frontend-builder /frontend/dist ./static
RUN mkdir -p /data/.cache/torch

EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
