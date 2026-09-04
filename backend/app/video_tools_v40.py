from __future__ import annotations

import re
import urllib.parse
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from . import video_tools_v24 as v24
from . import video_tools_v31 as v31

router = APIRouter(prefix="/api/video/v40", tags=["video-studio-v40"])
WORKFLOW_PATH = "v40-production-readiness.yml"
FINAL_ARTIFACT_PREFIX = "v40-final-"
REQUIRED_JOBS = {
    "v35-oci": "V35 Container Artifact Trust",
    "v36-runtime": "V36 Runtime & E2E Verification",
    "v37-dr": "V37 Backup/Restore & Disaster Recovery",
    "v38-security": "V38 Security & Privacy Hardening",
    "v39-quality": "V39 Performance & Regression Quality",
    "v40-final": "V40 Final Production Readiness",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _active_release() -> dict | None:
    return v31.store.active_release()


def _step_summary(job: dict) -> list[dict]:
    out = []
    for step in job.get("steps") or []:
        if not isinstance(step, dict):
            continue
        out.append(
            {
                "name": step.get("name"),
                "status": step.get("status"),
                "conclusion": step.get("conclusion"),
                "number": step.get("number"),
            }
        )
    return out


def _attestation_presence(release: dict, digest_hex: str | None) -> dict:
    if not digest_hex or not re.fullmatch(r"[0-9a-f]{64}", digest_hex):
        return {"available": False, "present": False, "reason": "container_artifact_digest_missing"}
    try:
        data = v31._github_get(
            release["repository"],
            f"attestations/sha256:{digest_hex}?per_page=100",
        )
        items = data.get("attestations", []) if isinstance(data, dict) else []
        return {
            "available": True,
            "present": bool(items),
            "count": len(items),
            "subjectDigest": f"sha256:{digest_hex}",
        }
    except Exception as exc:
        return {
            "available": False,
            "present": False,
            "subjectDigest": f"sha256:{digest_hex}",
            "reason": "github_attestation_api_unavailable",
            "error": str(exc)[:500],
        }


def _pipeline(release: dict) -> dict:
    base = {
        "available": False,
        "success": False,
        "runId": None,
        "runUrl": None,
        "jobs": {},
        "finalArtifact": None,
        "containerArtifactSha256": None,
        "containerArtifactName": "v35-container-image.tar",
    }
    try:
        data = v31._github_get(
            release["repository"],
            f"actions/runs?head_sha={urllib.parse.quote(release['candidateSha'], safe='')}&per_page=100",
        )
        runs = data.get("workflow_runs", []) if isinstance(data, dict) else []
        matches = [run for run in runs if str(run.get("path") or "").endswith(WORKFLOW_PATH)]
        if not matches:
            return {**base, "reason": "final_pipeline_not_run_for_candidate"}
        run = sorted(matches, key=lambda item: str(item.get("created_at") or ""), reverse=True)[0]
        run_id = int(run["id"])
        jobs_data = v31._github_get(release["repository"], f"actions/runs/{run_id}/jobs?per_page=100")
        jobs = jobs_data.get("jobs", []) if isinstance(jobs_data, dict) else []
        job_map: dict[str, dict] = {}
        for job in jobs:
            name = str(job.get("name") or "")
            if name in REQUIRED_JOBS:
                job_map[name] = {
                    "name": name,
                    "label": REQUIRED_JOBS[name],
                    "status": job.get("status"),
                    "conclusion": job.get("conclusion"),
                    "startedAt": job.get("started_at"),
                    "completedAt": job.get("completed_at"),
                    "htmlUrl": job.get("html_url"),
                    "steps": _step_summary(job),
                }
        artifacts_data = v31._github_get(release["repository"], f"actions/runs/{run_id}/artifacts?per_page=100")
        artifacts = artifacts_data.get("artifacts", []) if isinstance(artifacts_data, dict) else []
        prefix = f"{FINAL_ARTIFACT_PREFIX}{release['candidateSha']}-"
        final_artifact = next((item for item in artifacts if str(item.get("name") or "").startswith(prefix)), None)
        digest_hex = None
        if final_artifact:
            match = re.search(r"-([0-9a-f]{64})$", str(final_artifact.get("name") or ""))
            digest_hex = match.group(1) if match else None
        all_jobs = all((job_map.get(name) or {}).get("conclusion") == "success" for name in REQUIRED_JOBS)
        success = (
            run.get("status") == "completed"
            and run.get("conclusion") == "success"
            and all_jobs
            and bool(final_artifact)
            and bool(digest_hex)
        )
        return {
            **base,
            "available": True,
            "success": success,
            "runId": run_id,
            "runUrl": run.get("html_url"),
            "status": run.get("status"),
            "conclusion": run.get("conclusion"),
            "createdAt": run.get("created_at"),
            "updatedAt": run.get("updated_at"),
            "jobs": job_map,
            "finalArtifact": {
                "id": final_artifact.get("id") if final_artifact else None,
                "name": final_artifact.get("name") if final_artifact else None,
                "sizeBytes": final_artifact.get("size_in_bytes") if final_artifact else None,
                "archiveDigest": final_artifact.get("digest") if final_artifact else None,
                "expired": final_artifact.get("expired") if final_artifact else None,
            }
            if final_artifact
            else None,
            "containerArtifactSha256": digest_hex,
            "immutableArtifact": f"docker-archive://v35-container-image.tar@sha256:{digest_hex}" if digest_hex else None,
        }
    except Exception as exc:
        return {**base, "reason": "github_pipeline_evidence_unavailable", "error": str(exc)[:700]}


def final_readiness(release: dict) -> dict:
    pipeline = _pipeline(release)
    blockers: list[dict] = []
    warnings: list[str] = []
    if not pipeline.get("available"):
        blockers.append({"code": "pipeline_missing", "message": "V40 final production pipeline has not run for this Candidate SHA."})
    for job_name, label in REQUIRED_JOBS.items():
        job = (pipeline.get("jobs") or {}).get(job_name) or {}
        if job.get("conclusion") != "success":
            blockers.append({"code": f"{job_name}_failed", "message": f"{label} is not successful for this Candidate SHA."})
    digest = str(pipeline.get("containerArtifactSha256") or "")
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        blockers.append({"code": "immutable_container_artifact_missing", "message": "Immutable container artifact SHA-256 evidence is missing."})
    if not pipeline.get("finalArtifact"):
        blockers.append({"code": "final_evidence_missing", "message": "V40 final evidence artifact is missing."})
    attestation = _attestation_presence(release, digest if digest else None)
    if attestation.get("available") and not attestation.get("present"):
        blockers.append({"code": "container_attestation_missing", "message": "GitHub Attestations API did not confirm provenance for the immutable container artifact SHA-256."})
    elif not attestation.get("available"):
        warnings.append("GitHub Attestations API could not be independently queried; the V35 pipeline still requires a successful GitHub OIDC provenance step for the same container archive.")
    warnings.append("Registry signing is intentionally not claimed. Railway builds from the source Dockerfile; the final GitHub evidence proves an immutable container archive and runtime verification, while Railway deployment health is verified separately.")
    ready = pipeline.get("success") is True and not blockers
    return {
        "ready": ready,
        "version": "40",
        "releaseId": release.get("id"),
        "releaseName": release.get("name"),
        "repository": release.get("repository"),
        "candidateSha": release.get("candidateSha"),
        "evaluatedAt": _now(),
        "blockers": blockers,
        "warnings": warnings,
        "pipeline": pipeline,
        "attestation": attestation,
        "policy": {
            "waiversAllowed": False,
            "immutableContainerArtifactRequired": True,
            "registrySignatureClaimed": False,
            "allStagesRequired": list(REQUIRED_JOBS),
            "productionPromotionBlockedOnFailure": True,
        },
    }


@router.get("/health/live")
async def health_v40() -> dict:
    return {"live": True, "version": "40", "finalGate": True}


@router.get("/admin/overview")
async def overview_v40(admin: dict = Depends(v24.require_admin)) -> dict:
    release = _active_release()
    if not release:
        return {"version": "40", "generatedAt": _now(), "activeRelease": None, "readiness": None, "stages": REQUIRED_JOBS}
    return {
        "version": "40",
        "generatedAt": _now(),
        "activeRelease": release,
        "readiness": final_readiness(release),
        "stages": REQUIRED_JOBS,
    }


@router.get("/release/ready")
async def ready_v40() -> JSONResponse:
    release = _active_release()
    if not release:
        return JSONResponse({"ready": True, "state": "no-active-release", "version": "40"})
    result = final_readiness(release)
    return JSONResponse(result, status_code=200 if result["ready"] else 503)
