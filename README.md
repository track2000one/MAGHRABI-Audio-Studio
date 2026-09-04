# MAGHRABI Studio

Professional web-based audio/video production studio with a production-grade release, security, reliability and artifact-verification pipeline.

## Current production line

The current control room is **Creator V40 – Final Production Readiness**.

- `#video` → Creator V40 final readiness
- `#video-v34` → Hermetic build/artifact evidence
- earlier `#video-vN` routes remain available for historical inspection and rollback
- `#tools` → audio tools

Production evidence is bound to one exact Git candidate SHA and one immutable tested Docker image archive identified by SHA-256. Railway still builds the service from the same source-controlled Dockerfile, so Railway deployment health is verified separately rather than inferred from GitHub.

## Application capabilities

The project evolved from audio stem separation into a broader media studio and production platform. Current code includes:

- Demucs 2-stem / 4-stem audio separation.
- FFmpeg audio trim, merge, enhancement and conversion tools.
- Multi-generation browser video editor with timeline, titles, subtitles, music, image overlays, PiP, transitions, filters, chroma key, privacy masks, speed ramps, reverse/freeze, silence detection, audio ducking and project persistence.
- Authentication, team/enterprise, review and secured administration surfaces.
- Reliability, observability, SLO/capacity, progressive-delivery and GitOps layers.
- Supply-chain, reproducible-build, SBOM, vulnerability and provenance gates.
- Verified backup/restore and disaster-recovery tooling.
- Final V40 non-waivable Production Readiness gate.

## Stack

- React 18 + Vite + TypeScript + Tailwind CSS
- FastAPI
- FFmpeg
- Demucs 4.0.1
- CPU PyTorch 2.0.1 / TorchAudio 2.0.2 compatibility stack
- Docker multi-stage production image
- SQLite fallback / optional PostgreSQL control-plane database
- GitHub Actions
- Railway deployment

## Dependency integrity

Frontend dependencies are installed with source-controlled `frontend/package-lock.json` and `npm ci`.

Python uses `backend/requirements.lock.txt`, a transitive lock generated with SHA-256 hashes. The Docker build installs it with `pip --require-hashes`. The protected CPU ML stack is part of the same lock.

## Production verification chain

The final release chain is:

```text
V31 GitOps
  ↓
V32 Supply Chain
  ↓
V33 Reproducible Build / Provenance
  ↓
V34 Hermetic Artifact Verification
  ↓
V35 Container Image Archive / SBOM / Vulnerability Gate / OIDC Provenance
  ↓
V36 Exact Artifact Runtime & E2E Smoke Verification
  ↓
V37 Backup / Restore / Disaster Recovery
  ↓
V38 Security & Privacy Hardening
  ↓
V39 Performance & Regression Quality
  ↓
V40 Final Production Readiness
  ↓
Production
```

V40 does not provide a waiver mechanism. Production is blocked when any required final stage does not succeed for the active candidate SHA. External registry signing is deliberately **not claimed** by the current pipeline; GitHub OIDC provenance is created for the immutable container archive instead.

## Railway deployment

Railway builds from the root `Dockerfile`. Add a persistent volume mounted at `/data` and configure strong authentication variables.

Minimum required variables:

```text
ADMIN_USERNAME=<production username>
ADMIN_PASSWORD=<strong secret>
AUTH_SECRET=<random secret of at least 32 characters>
DATA_DIR=/data
ENABLE_API_DOCS=0
```

Recommended production configuration is documented in `.env.example` and `docs/PRODUCTION_RUNBOOK.md`.

Health endpoint:

```text
GET /api/health
```

Final readiness endpoint:

```text
GET /api/video/v40/release/ready
```

A successful GitHub pipeline does **not** by itself prove that Railway is deployed and healthy. Railway health must be confirmed from the deployed service/public health endpoint.

## Local frontend development

```bash
cd frontend
npm ci
npm run dev
```

Vite proxies `/api` to the local backend during development.

## Local backend development

For compatibility with the production environment, use Python 3.10 and install from the hash lock:

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\\Scripts\\activate
python -m pip install --require-hashes \
  --index-url https://pypi.org/simple \
  --extra-index-url https://download.pytorch.org/whl/cpu \
  -r backend/requirements.lock.txt
uvicorn app.entry:app --app-dir backend --reload --port 8000
```

## Backup verification

```bash
python -m app.ops_backup_v37 create /data /path/to/control-plane.tar.gz
python -m app.ops_backup_v37 verify /path/to/control-plane.tar.gz
```

See the runbook before restoring production data.

## Documentation

- `docs/PRODUCTION_RUNBOOK.md` — deployment, release, rollback, incident and recovery operations.
- `docs/PROJECT_COMPLETION_CHECKLIST.md` — final acceptance criteria.
- `SECURITY.md` — vulnerability reporting and production security posture.

## Important compatibility note

Python 3.10 and the current Torch/TorchAudio pair are intentional compatibility pins for the Railway CPU Demucs stack. They should be migrated through a dedicated compatibility project with media regression tests rather than changed opportunistically.
