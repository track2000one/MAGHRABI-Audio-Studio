# Security Policy

## Supported production line

The supported production line is the current `main` branch plus the immutable Docker image archive produced and runtime-tested by the V40 Production Readiness workflow for the exact candidate commit. Historical Creator routes are retained for rollback and evidence inspection, but security fixes target the current production line.

## Reporting a vulnerability

Do not publish credentials, access tokens, private media, exploit details, or sensitive logs in a public issue. Prefer a private GitHub Security Advisory for this repository when available. If that feature is unavailable, use a private communication channel with the repository owner before opening any public issue.

## Secrets

Production secrets belong in Railway/GitHub secret stores, never in Git:

- `ADMIN_PASSWORD`
- `AUTH_SECRET`
- `DATABASE_URL`
- `V31_GITHUB_TOKEN`
- deployment webhook tokens
- any future external signer/scanner credentials

`.env.example` contains placeholders only. A real secret committed to Git must be considered compromised and rotated immediately, even if the commit is later deleted.

## Production security controls

The production line implements:

- HttpOnly authenticated session cookies.
- Public FastAPI documentation disabled by default.
- CSP, anti-framing, content-type, referrer, permissions and cross-origin response headers.
- HSTS on HTTPS requests.
- `no-store` response caching for authentication and administration surfaces.
- Exact npm lock installation.
- SHA-256 hashed transitive Python dependency lock.
- Reproducible frontend build evidence.
- Syft CycloneDX SBOM generation.
- Trivy source/artifact/container vulnerability gates.
- GitHub OIDC provenance for release artifacts.
- V40 immutable container-archive SHA-256 policy and non-waivable Production gate.
- Verified control-plane backup/restore with SHA-256 integrity checking.

The current automated pipeline does **not** claim an external registry signature. A registry signing system may be added later only when it can be configured and independently verified. Railway deployment continues to build from the reviewed source Dockerfile.

## Dependency constraints

The CPU ML stack is intentionally pinned to `torch==2.0.1+cpu` and `torchaudio==2.0.2+cpu` for Demucs compatibility on the current Railway architecture. Python 3.10 is therefore an explicit compatibility constraint and must be reviewed before its runtime support window expires. Do not silently upgrade Torch/TorchAudio in a security-only change; create a compatibility migration with audio regression tests.

## Media and privacy

Uploaded media and generated output can contain confidential content. Production operators should:

- mount persistent storage intentionally and control access to it;
- avoid copying user media into GitHub Actions artifacts;
- keep logs free of raw media content and credentials;
- establish a retention period appropriate for the deployment;
- delete obsolete jobs/output from persistent storage according to that retention policy.

The V37 backup engine targets control-plane state and intentionally excludes transient `jobs`, cache, tools, and render directories by default.

## Release policy

A Production promotion must be bound to one candidate Git SHA and the SHA-256 identity of the exact tested container archive produced for that candidate. GitHub OIDC provenance is generated for that archive. Railway deployment health must then be verified independently after Railway builds the same source-controlled Dockerfile.
