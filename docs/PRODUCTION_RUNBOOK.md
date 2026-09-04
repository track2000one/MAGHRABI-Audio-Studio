# MAGHRABI Studio Production Runbook

## 1. Production architecture

MAGHRABI Studio is packaged as a single Railway service:

- React/Vite/TypeScript frontend compiled during the Docker build.
- FastAPI serves the API and the compiled frontend.
- FFmpeg provides media processing.
- Demucs runs on the pinned CPU Torch/TorchAudio stack.
- `/data` is the persistent runtime root.
- SQLite is the local fallback for control-plane state; PostgreSQL can be supplied with `DATABASE_URL`.
- GitHub Actions produces the release evidence and immutable OCI image used by the final gate.

The deployment identity is **Git candidate SHA + OCI SHA-256 digest**. A mutable image tag is never sufficient evidence for Production.

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
5. Confirm the V40 workflow produced an immutable image of the form:
   `ghcr.io/track2000one/maghrabi-audio-studio@sha256:<digest>`.
6. In the application, create/select the V31 Release with `candidateSha` equal to that SHA.
7. Open `#video` and confirm Creator V40 reports every stage as `SUCCESS` and Production as `READY`.
8. Promote through the existing release flow. The V40 middleware blocks Production if the final pipeline does not match the release candidate.

Never reuse evidence from a different SHA.

## 4. V35–V40 gates

### V35 — OCI Trust & Signed Image

The final Docker image is built from the source-controlled Dockerfile, pushed to GHCR by digest, scanned, assigned a CycloneDX SBOM, signed with keyless Sigstore/Cosign identity, verified, and given GitHub OIDC build provenance.

### V36 — Runtime & E2E Verification

The exact OCI digest is pulled and executed. The pipeline verifies the media/ML runtime, FastAPI health, authentication configuration, frontend availability, and HTTP security response headers.

### V37 — Backup/Restore & Disaster Recovery

The backup engine creates a manifest containing SHA-256 for every included control-plane file. CI validates restore round-trip, exclusion of transient media/cache state, tamper rejection and path traversal rejection.

### V38 — Security & Privacy Hardening

The repository/image are scanned for high-impact security findings. Production HTTP headers are installed, public API docs are disabled by default, and sensitive admin/auth surfaces are `no-store`.

### V39 — Performance & Regression Quality

Historical studio generations are route-level lazy chunks rather than one monolithic bundle. CI enforces maximum JavaScript chunk and total distribution budgets, TypeScript compilation, Python syntax and regression tests.

### V40 — Final Production Readiness

V40 is non-waivable. It requires every prior final-stage job to succeed for the same candidate SHA and requires an immutable image digest plus final evidence artifact.

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

Rollback should identify both:

- the previous known-good Git SHA; and
- the previous known-good OCI digest.

Do not rollback by moving a mutable `latest` tag alone. Re-run readiness evidence if a rollback candidate is re-promoted through the application release system.

## 8. Incident response

For an availability incident:

1. Check Railway deployment health and `/api/health`.
2. Check persistent volume availability and free space.
3. Check active media worker/job state.
4. Check the exact deployed SHA/image digest against the last successful V40 evidence.
5. If the new image is implicated, rollback to the previous immutable digest.
6. Preserve logs/evidence before destructive cleanup.

For a suspected credential leak, rotate the credential immediately. Deleting a Git commit does not make a leaked secret trustworthy again.

## 9. Known production constraints

- Demucs is CPU-bound and intentionally configured with a low worker count on Railway.
- Very large or long media jobs can be slow and memory intensive.
- Python 3.10 and Torch 2.0.1/TorchAudio 2.0.2 are compatibility pins and require a planned migration rather than an automatic major upgrade.
- V40 can prove GitHub build/runtime evidence, but Railway deployment state itself must still be confirmed from Railway because this repository has no direct Railway control-plane connector.
