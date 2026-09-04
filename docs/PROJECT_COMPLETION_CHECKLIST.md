# Final Project Completion Checklist

A build is considered production-ready only when all items below are true for the **same Git candidate SHA**.

## Source and dependency integrity

- [ ] `frontend/package-lock.json` exists and `npm ci` succeeds.
- [ ] `backend/requirements.lock.txt` exists and every resolved Python package is protected by SHA-256 hashes.
- [ ] Torch/TorchAudio remain the validated CPU compatibility pair unless a dedicated migration is completed.
- [ ] TypeScript build passes.
- [ ] Python syntax validation passes.
- [ ] Unit/regression tests pass.

## Build and artifact integrity

- [ ] V33 reproducibility evidence passes.
- [ ] V34 cross-run Ubuntu 22/24 artifact comparison passes.
- [ ] Syft CycloneDX artifact SBOM is generated.
- [ ] Trivy artifact CRITICAL gate passes.
- [ ] GitHub OIDC provenance is generated.

## V35 OCI release

- [ ] Production Docker image builds from the final SHA.
- [ ] Image is pushed to GHCR.
- [ ] Deployment identity uses `image@sha256:<digest>`.
- [ ] OCI SBOM is generated.
- [ ] OCI vulnerability CRITICAL gate passes.
- [ ] Keyless Cosign signature is created and successfully verified.
- [ ] GitHub OCI provenance attestation succeeds.

## V36 runtime verification

- [ ] The exact image digest can be pulled.
- [ ] `torch`, `torchaudio`, `demucs`, `ffmpeg`, and `ffprobe` are available in the final image.
- [ ] `/api/health` returns healthy status.
- [ ] `/api/auth/status` reports authentication configured in the smoke environment.
- [ ] Login endpoint accepts valid smoke credentials.
- [ ] Frontend root is served.
- [ ] Security headers are present.
- [ ] Public FastAPI docs are disabled by default.

## V37 disaster recovery

- [ ] Backup creation succeeds.
- [ ] Backup SHA-256 verification succeeds.
- [ ] Restore round-trip succeeds.
- [ ] Tampered backup is rejected.
- [ ] Path traversal archive is rejected.
- [ ] Transient job/cache directories are excluded by default.

## V38 security and privacy

- [ ] Repository security scan completes without blocking high-impact findings.
- [ ] Production image security scan completes without blocking CRITICAL findings.
- [ ] Secrets remain outside Git.
- [ ] Admin/auth responses are no-store.
- [ ] CSP / anti-framing / HSTS-on-HTTPS policy is active.

## V39 performance and quality

- [ ] Historical studio versions are lazy-loaded route chunks.
- [ ] Largest JavaScript chunk stays within the CI budget.
- [ ] Total frontend distribution stays within the CI budget.
- [ ] Node 22 build succeeds.

## V40 final acceptance

- [ ] `V40 Production Readiness` workflow succeeds.
- [ ] Final evidence artifact exists for the exact candidate SHA.
- [ ] Creator V40 reports all six final stages successful.
- [ ] Production gate reports `READY`.
- [ ] Production promotion is rejected if V40 is not ready.
- [ ] Railway deployment reaches a healthy state and `/api/health` succeeds on the public domain.

The last Railway item is operational evidence outside GitHub. The project must not claim that Railway is healthy solely because GitHub Actions passed.
