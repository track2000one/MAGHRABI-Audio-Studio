# MAGHRABI Audio Studio

AI-powered web studio for separating audio into independent stems such as vocals, drums, bass and other instruments.

## Stack

- React + Vite + TypeScript
- Tailwind CSS
- FastAPI
- Demucs + FFmpeg
- Docker
- GitHub + Railway

## V1 features

- Upload MP3, WAV, FLAC, M4A, AAC or OGG
- Two-stem separation: Vocals / Instrumental
- Four-stem separation: Vocals / Drums / Bass / Other
- Processing status and progress polling
- Independent audio preview for each stem
- Download every separated stem as WAV
- Responsive dark studio interface

## Railway deployment

V1 is intentionally packaged as one Railway service. The Docker image builds the React frontend and FastAPI serves both the API and compiled frontend. Audio processing runs in the same service so the frontend, API and generated audio do not need cross-service file transfer.

1. Create a Railway project from this GitHub repository.
2. Railway detects the root `Dockerfile` and `railway.json`.
3. Add a persistent Railway Volume mounted at `/data`.
4. Generate a public domain.
5. Optional variables:
   - `DATA_DIR=/data`
   - `MAX_UPLOAD_MB=250`
   - `DEMUCS_MODEL=htdemucs`
   - `MAX_WORKERS=1`

Demucs runs on CPU in this first Railway version. A dedicated GPU worker can be introduced later without replacing the React application.

## Local development

Backend:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Vite proxies `/api` to `http://localhost:8000` during local development.
