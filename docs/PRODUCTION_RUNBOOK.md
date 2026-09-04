# MAGHRABI Studio Production Runbook

## 1. Production architecture

MAGHRABI Studio is packaged as a single Railway service:

- React/Vite/TypeScript frontend compiled during the Docker build.
- FastAPI serves the API and the compiled frontend.
- FFmpeg provides media processing.
- Demucs runs on the pinned CPU Torch/TorchAudio stack.
- `/data` is the persistent runtime root.
- SQLite is the local fallback for control-plane state; PostgreSQL can be supplied with `DATABASE_URL`.
- GitHub Actions produces release evidence plus an immutable Docker image archive that is runtime-tested by SHA-256 before V40 can pass.

The evidence identity is **Git candidate SHA + tested container-archive SHA-256**. Railway then builds the same source-controlled Dockerfile; Railway health is an additional operational check, not inferred from GitHub.

## 2. Required Railway configuration

Create the Railway service from this repository and keep the root `Dockerfile`/`railway.json` configuration. Mount a persistent volume at `/data`.

Required variables:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `AUTH_SECRET` with at least 32 characters

Recommended variables:

- `DATA_DIR=/data`
- `MAX_UPLOAD_MB=250`
- `DEMUCS_MODEL=htdemucs`
- `MAX_WORKERS=1`
- `ENABLE_API_DOCS=0`
- `V31_GITHUB_REPOSITORY=track2000one/MAGHRABI-Audio-Studio`

Optional production integrations:

- `DATABASE_URL`
- `V31_GITHUB_TOKEN`
- `V31_DEPLOY_WEBHOOK_URL`
- `V31_DEPLOY_WEBHOOK_TOKEN`

Do not store real credentials in `.env.example` or GitHub source files.

## 3. Release workflow

1. Merge the intended code to `main`.
2. Wait for `Validate MAGHRABI Studio` to pass on the exact final SHA.
3. Wait for the V33/V34 evidence workflows to pass on that SHA.
4. Wait for `V40 Production Readiness` to finish successfully on that same SHA.
5. Confirm V35 produced `v35-container-image.tar`, a SHA-256 digest, CycloneDX SBOM, Trivy evidence and GitHub OIDC provenance.
6. Confirm V36 loaded the same archive after verifying that exact SHA-256 and passed runtime/HTTP smoke tests.
7. In the application, create/select the V31 Release with `candidateSha` equal to that SHA.
8. Open `#video` and confirm Creator V40 reports every stage as `SUCCESS` and Production as `READY`.
9. Promote through the existing release flow. The V40 middleware blocks Production if the final pipeline does not match the release candidate.
10. Confirm Railway reaches a healthy deployment and the public `/api/health` endpoint succeeds.

Never reuse evidence from a different SHA.

## 4. V35–V40 gates

### V35 — Container Artifact Trust

The final Docker image is built from the source-controlled Dockerfile, exported as an immutable Docker archive, identified by SHA-256, scanned by Trivy, assigned a CycloneDX SBOM, and given GitHub OIDC provenance. External registry signing is not claimed by the current pipeline.

The CPU ML dependency line is the matched `torch==2.6.0+cpu` / `torchaudio==2.6.0+cpu` pair. It replaced the older Torch line after V35 correctly blocked CVE-2025-32434. Do not weaken the CRITICAL vulnerability gate to restore an older image.

### V36 — Runtime & E2E Verification

The exact V35 archive is downloaded, SHA-256 verified, loaded with Docker, and executed. The pipeline validates the media/ML runtime, FastAPI health, authentication configuration, frontend availability, V40 liveness, security response headers, and that public FastAPI docs remain disabled by default. This is also the compatibility proof for the current PyTorch/TorchAudio/Demucs combination.

### V37 — Backup/Restore & Disaster Recovery

The backup engine creates a manifest containing SHA-256 for every included control-plane file. CI validates restore round-trip, exclusion of transient media/cache state, tamper rejection and path traversal rejection.

### V38 — Security & Privacy Hardening

Repository secret scanning and IaC critical checks run in CI. Production HTTP headers are installed, public API docs are disabled by default, and sensitive admin/auth surfaces are `no-store`.

### V39 — Performance & Regression Quality

Historical studio generations are route-level lazy chunks rather than one monolithic bundle. CI enforces maximum JavaScript chunk and total distribution budgets, TypeScript compilation, Python syntax and regression tests.

### V40 — Final Production Readiness

V40 is non-waivable. It requires every final-stage job to succeed for the same candidate SHA, a valid immutable container-archive SHA-256, GitHub provenance when available through the Attestations API, and a final evidence artifact.

## 5. Health checks

Railway health check:

- `GET /api/health`

Expected result includes `status: ok` and `worker: ready`.

Final gate liveness:

- `GET /api/video/v40/health/live`

Final release readiness:

- `GET /api/video/v40/release/ready`

This returns HTTP 200 only when an active release is ready; otherwise it returns 503 with blockers.

## 6. Backup and restore

Create a control-plane backup inside a running container or equivalent maintenance shell:

```bash
python -m app.ops_backup_v37 create /data /data-backups/control-plane.tar.gz
python -m app.ops_backup_v37 verify /data-backups/control-plane.tar.gz
```

Restore to a clean recovery directory first:

```bash
python -m app.ops_backup_v37 restore /data-backups/control-plane.tar.gz /recovery/data
```

Verify the restored state before replacing live data. By default the engine excludes `.cache`, `jobs`, `tools`, `video`, `tmp` and `temp` top-level directories.

For PostgreSQL deployments, database backups must also be performed using the managed PostgreSQL backup/snapshot mechanism. The filesystem backup does not replace a database-native backup.

## 7. Rollback

Rollback should identify the previous known-good Git SHA and its matching successful V40 evidence. Because Railway builds from source, rollback Railway to the deployment built from that known-good source revision and then verify `/api/health` again.

## 8. Incident response

For an availability incident:

1. Check Railway deployment health and `/api/health`.
2. Check persistent volume availability and free space.
3. Check active media worker/job state.
4. Compare the deployed source revision with the last successful V40 candidate SHA.
5. If the new revision is implicated, rollback Railway to the previous known-good revision.
6. Preserve logs/evidence before destructive cleanup.

For a suspected credential leak, rotate the credential immediately. Deleting a Git commit does not make a leaked secret trustworthy again.

## 9. Known production constraints

- Demucs is CPU-bound and intentionally configured with a low worker count on Railway.
- Very large or long media jobs can be slow and memory intensive.
- Python 3.10 and Torch 2.6.0/TorchAudio 2.6.0 are current compatibility/security pins. Future upgrades require the same locked-dependency, vulnerability, runtime and media-regression gates.
- V40 proves GitHub build/runtime evidence for an immutable image archive; it does not claim an external registry signature.
- Railway deployment state itself must still be confirmed from Railway/public health because this repository has no direct Railway control-plane connector.
