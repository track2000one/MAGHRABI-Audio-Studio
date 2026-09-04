from __future__ import annotations

import json
import urllib.error
import urllib.request

from fastapi import Request
from fastapi.responses import JSONResponse

from . import video_tools_v32 as base

router = base.router


def _patch_runtime() -> None:
    if getattr(base, "_v32_runtime_patched", False):
        return
    base._v32_runtime_patched = True

    original_gate = base.evaluate_gate
    original_send_deployment = base.v31._send_deployment

    def artifact_snapshot(release: dict) -> dict:
        items = base.store.artifacts(release["id"], 100)
        latest_by_environment: dict[str, dict] = {}
        for item in items:
            environment = str(item.get("environment") or "")
            if environment and environment not in latest_by_environment:
                latest_by_environment[environment] = item
        latest = items[0] if items else None
        return {
            "available": bool(latest),
            "latest": latest,
            "latestByEnvironment": latest_by_environment,
            "items": items,
        }

    def provenance(release: dict, sbom: dict, artifact: dict) -> dict:
        latest_by_env = artifact.get("latestByEnvironment") if isinstance(artifact.get("latestByEnvironment"), dict) else {}
        pinned = latest_by_env.get("production") or artifact.get("latest")
        subjects = [{"name": release["repository"], "digest": {"gitCommit": release["candidateSha"]}}]
        if isinstance(pinned, dict) and pinned.get("digestSha256"):
            subjects.append({
                "name": str(pinned.get("name") or "deployment-artifact"),
                "digest": {"sha256": str(pinned["digestSha256"])},
            })
        statement = {
            "_type": "https://in-toto.io/Statement/v1",
            "predicateType": "https://slsa.dev/provenance/v1",
            "subject": subjects,
            "predicate": {
                "buildDefinition": {
                    "buildType": "https://maghrabi.local/v32/git-release",
                    "externalParameters": {
                        "releaseId": release["id"],
                        "candidateRef": release.get("candidateRef"),
                        "candidateGitCommit": release["candidateSha"],
                    },
                    "resolvedDependencies": [
                        {"uri": path, "digest": {"sha256": digest}}
                        for path, digest in (sbom.get("materials") or {}).items()
                    ],
                },
                "runDetails": {
                    "builder": {"id": "MAGHRABI-Creator-V32"},
                    "metadata": {"invocationId": release["id"], "startedOn": base._now()},
                },
                "artifact": pinned,
            },
        }
        return {
            "statement": statement,
            "signature": {
                "scheme": "MAGHRABI-HMAC-SHA256",
                "value": base._hmac(statement),
                "valid": True,
            },
            "slsaInspired": True,
            "slsaConformant": False,
            "note": "Internal HMAC-signed provenance. Git source uses its native Git commit identifier; only artifact/material bytes are labeled SHA-256.",
        }

    def reclassify_licenses(licenses: dict, policy: dict) -> dict:
        result = dict(licenses or {})
        items = list(result.get("items") or [])
        denied: list[dict] = []
        warned: list[dict] = []
        unknown: list[dict] = []
        deny = [str(x).lower() for x in (policy.get("deniedLicenses") or [])]
        warn = [str(x).lower() for x in (policy.get("warnLicenses") or [])]
        for item in items:
            lic = str(item.get("license") or "UNKNOWN")
            low = lic.lower()
            if lic == "UNKNOWN":
                unknown.append(item)
            if any(x and x in low for x in deny):
                denied.append(item)
            elif any(x and x in low for x in warn):
                warned.append(item)
        result["denied"] = denied
        result["warned"] = warned
        result["unknown"] = unknown
        result["summary"] = {
            "total": len(items), "denied": len(denied),
            "warned": len(warned), "unknown": len(unknown),
        }
        return result

    def current_policy_gate(scan: dict, release: dict, environment: str) -> dict:
        policy = base.store.policy()
        staged = dict(scan)
        staged["policy"] = policy
        staged["licenses"] = reclassify_licenses(scan.get("licenses") or {}, policy)

        artifact = dict(scan.get("artifact") or {})
        latest_by_env = artifact.get("latestByEnvironment") if isinstance(artifact.get("latestByEnvironment"), dict) else {}
        if not latest_by_env:
            for item in artifact.get("items") or []:
                env = str(item.get("environment") or "")
                if env and env not in latest_by_env:
                    latest_by_env[env] = item
        artifact["latestByEnvironment"] = latest_by_env
        if environment in {"staging", "production"}:
            artifact["latest"] = latest_by_env.get(environment)
        staged["artifact"] = artifact

        # Ruleset listings are useful evidence, but a list alone does not prove that
        # a specific candidate branch is covered by that ruleset. The gate therefore
        # accepts branch protection only when the branch-protection endpoint confirms it.
        rules = dict(scan.get("rules") or {})
        rulesets = dict(rules.get("rulesets") or {})
        reported_ruleset_count = int(rulesets.get("count") or 0)
        rulesets["reportedCount"] = reported_ruleset_count
        rulesets["count"] = 0
        rulesets["applicabilityVerified"] = False
        rules["rulesets"] = rulesets
        staged["rules"] = rules

        gate = original_gate(staged, release, environment)
        gate["policyCurrent"] = True
        if reported_ruleset_count and not bool((rules.get("protection") or {}).get("protected")):
            gate.setdefault("warnings", []).append(
                f"{reported_ruleset_count} GitHub ruleset(s) were listed, but applicability to this candidate branch was not independently proven."
            )
        return gate

    def send_deployment_with_artifact(release: dict, *, action: str, environment: str, target_sha: str) -> dict:
        artifact = base.store.latest_artifact(release["id"], environment)
        if not artifact or not base.v31.DEPLOY_WEBHOOK_URL:
            result = original_send_deployment(release, action=action, environment=environment, target_sha=target_sha)
            if isinstance(result, dict) and artifact:
                result = {**result, "artifactDigestSha256": artifact.get("digestSha256"), "artifactName": artifact.get("name")}
            return result

        if not base.v31.DEPLOY_WEBHOOK_URL.startswith("https://"):
            raise RuntimeError("V31_DEPLOY_WEBHOOK_URL must use HTTPS.")
        payload = json.dumps({
            "releaseId": release["id"],
            "releaseName": release["name"],
            "repository": release["repository"],
            "action": action,
            "environment": environment,
            "targetSha": target_sha,
            "candidateRef": release.get("candidateRef"),
            "baseSha": release.get("baseSha"),
            "artifactDigestSha256": artifact.get("digestSha256"),
            "artifactName": artifact.get("name"),
            "artifactSizeBytes": artifact.get("sizeBytes"),
            "artifactId": artifact.get("id"),
            "requestedAt": base.v31._now(),
        }).encode("utf-8")
        headers = {"Content-Type": "application/json", "User-Agent": "MAGHRABI-V32/1.0"}
        if base.v31.DEPLOY_WEBHOOK_TOKEN:
            headers["X-V31-Token"] = base.v31.DEPLOY_WEBHOOK_TOKEN
        request = urllib.request.Request(base.v31.DEPLOY_WEBHOOK_URL, data=payload, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                raw = response.read(128 * 1024)
                status = int(getattr(response, "status", 200))
            if status < 200 or status >= 300:
                raise RuntimeError(f"Deployment controller returned HTTP {status}.")
            data = {}
            if raw:
                try:
                    data = json.loads(raw.decode("utf-8"))
                except Exception:
                    data = {"raw": raw.decode("utf-8", errors="replace")[:2000]}
            return {
                "ok": True, "external": True, "mode": "external-webhook",
                "environment": environment, "targetSha": target_sha,
                "artifactDigestSha256": artifact.get("digestSha256"),
                "artifactName": artifact.get("name"), "response": data,
            }
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"Deployment controller HTTP {exc.code}.") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Deployment controller unavailable: {exc.reason}") from exc

    base._artifact = artifact_snapshot
    base._provenance = provenance
    base.evaluate_gate = current_policy_gate
    base.v31._send_deployment = send_deployment_with_artifact


def install_v32(app) -> None:
    _patch_runtime()
    if getattr(app.state, "v32_supply_chain_guard_installed", False):
        return
    app.state.v32_supply_chain_guard_installed = True

    @app.middleware("http")
    async def v32_supply_chain_promotion_guard(request: Request, call_next):
        path = request.url.path
        method = request.method.upper()
        if method == "POST" and path.startswith("/api/video/v31/admin/releases/") and path.endswith("/promote"):
            target = request.headers.get("x-v31-target-environment", "").strip().lower()
            if target in {"staging", "production"}:
                parts = [part for part in path.split("/") if part]
                release_id = parts[-2] if len(parts) >= 2 else ""
                release = base.v31.store.get_release(release_id)
                if not release:
                    return JSONResponse({"detail": "V31 Release غير موجودة."}, status_code=404)
                scan = base.store.latest_scan(release_id, str(release.get("candidateSha") or ""))
                if not scan:
                    return JSONResponse({
                        "detail": "Creator V32 supply-chain scan مطلوب قبل Promotion إلى Staging/Production.",
                        "code": "V32_SCAN_REQUIRED", "releaseId": release_id,
                        "candidateSha": release.get("candidateSha"), "targetEnvironment": target,
                    }, status_code=428)
                gate = base.evaluate_gate(scan, release, target)
                if not gate.get("ready"):
                    return JSONResponse({
                        "detail": "Creator V32 Supply-Chain Gate منع Promotion.",
                        "code": "V32_SUPPLY_CHAIN_BLOCKED", "gate": gate,
                    }, status_code=412)
        return await call_next(request)
