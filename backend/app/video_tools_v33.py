from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import re
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from . import supply_chain_store_v33 as store
from . import video_tools_v24 as v24
from . import video_tools_v31 as v31
from . import video_tools_v32 as v32
from .main import AUTH_SECRET, DATA_DIR

router = APIRouter(prefix="/api/video/v33", tags=["video-studio-v33"])

SIGNER_URL = os.getenv("V33_SIGNER_URL", "").strip()
SIGNER_TOKEN = os.getenv("V33_SIGNER_TOKEN", "").strip()
OPA_URL = os.getenv("V33_OPA_URL", "").strip()
OPA_TOKEN = os.getenv("V33_OPA_TOKEN", "").strip()
OCI_VERIFY_URL = os.getenv("V33_OCI_VERIFY_URL", "").strip()
OCI_VERIFY_TOKEN = os.getenv("V33_OCI_VERIFY_TOKEN", "").strip()
ATTESTATION_TOKEN = os.getenv("V33_ATTESTATION_TOKEN", "").strip()
EVIDENCE_DIR = DATA_DIR / "video_supply_chain" / "v33_evidence"
EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)

SAMPLE_REGO = '''package maghrabi.release

default allow := false

allow if {
  input.v32.ready == true
  input.locks.frontend.status == "locked"
  input.locks.frontend.integrityMissing == 0
  input.locks.backend.exactPins == true
  input.build.reproducible == true
}
'''


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_ts(value: str | None) -> float | None:
    if not value: return None
    try: return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except Exception: return None


def _canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _sha(value: bytes | str) -> str:
    data = value.encode("utf-8") if isinstance(value, str) else value
    return hashlib.sha256(data).hexdigest()


def _hmac(value) -> str:
    secret = (AUTH_SECRET or "").encode("utf-8")
    if len(secret) < 32:
        raise HTTPException(status_code=503, detail="AUTH_SECRET يجب أن يكون 32 حرفًا على الأقل لتشغيل V33 attestation.")
    return hmac.new(secret, _canonical(value), hashlib.sha256).hexdigest()


def _active_release(release_id: str | None = None) -> dict:
    release = v31.store.get_release(release_id) if release_id else v31.store.active_release()
    if not release:
        raise HTTPException(status_code=404, detail="لا توجد V31 Release نشطة.")
    return release


def _github_text(repository: str, path: str, sha: str) -> str | None:
    return v32._github_text(repository, path, sha)


def _manifest_root(package_json: dict) -> dict:
    return {
        "dependencies": package_json.get("dependencies") or {},
        "devDependencies": package_json.get("devDependencies") or {},
    }


def _lock_analysis(release: dict) -> dict:
    repo = release["repository"]; sha = release["candidateSha"]
    package_text = _github_text(repo, "frontend/package.json", sha)
    lock_text = _github_text(repo, "frontend/package-lock.json", sha)
    req_text = _github_text(repo, "backend/requirements.txt", sha)
    docker_text = _github_text(repo, "Dockerfile", sha)

    frontend = {"status":"missing","available":False,"integrityMissing":None,"packageCount":0,"rootMatchesManifest":False}
    if package_text and lock_text:
        try:
            package = json.loads(package_text); lock = json.loads(lock_text)
            packages = lock.get("packages") or {}; root = packages.get("") or {}
            entries = [(k,v) for k,v in packages.items() if k and isinstance(v,dict)]
            integrity_missing = 0
            resolved_count = 0
            for _, item in entries:
                resolved = str(item.get("resolved") or "")
                if resolved.startswith(("http://","https://")):
                    resolved_count += 1
                    if not item.get("integrity"): integrity_missing += 1
            manifest_root = _manifest_root(package)
            lock_root = {"dependencies":root.get("dependencies") or {},"devDependencies":root.get("devDependencies") or {}}
            root_matches = manifest_root == lock_root
            frontend = {
                "status":"locked" if root_matches and int(lock.get("lockfileVersion") or 0) >= 3 else "invalid",
                "available":True,"lockfileVersion":lock.get("lockfileVersion"),"sha256":_sha(lock_text),
                "packageJsonSha256":_sha(package_text),"packageCount":len(entries),"resolvedCount":resolved_count,
                "integrityMissing":integrity_missing,"rootMatchesManifest":root_matches,
            }
        except Exception as exc:
            frontend = {"status":"invalid","available":True,"error":str(exc)[:300],"integrityMissing":None,"packageCount":0,"rootMatchesManifest":False}

    req_lines=[]; unpinned=[]
    if req_text:
        for raw in req_text.splitlines():
            line=raw.strip()
            if not line or line.startswith("#"): continue
            req_lines.append(line)
            if "==" not in line or line.startswith(("git+","http://","https://")): unpinned.append(line)
    backend = {
        "available":bool(req_text),"sha256":_sha(req_text) if req_text else None,
        "requirementCount":len(req_lines),"exactPins":bool(req_text) and not unpinned,"unpinned":unpinned[:40],
        "transitiveLock":False,
        "note":"requirements.txt pins direct Python requirements; transitive wheel hashes are not source-controlled yet.",
    }

    materials = {
        "frontend/package.json": _sha(package_text) if package_text else None,
        "frontend/package-lock.json": _sha(lock_text) if lock_text else None,
        "backend/requirements.txt": _sha(req_text) if req_text else None,
        "Dockerfile": _sha(docker_text) if docker_text else None,
    }
    materials_digest = _sha(_canonical(materials))

    drift = {"baseAvailable":False,"frontendLockChanged":None,"backendRequirementsChanged":None,"dependencyMaterialChanged":None}
    base_sha = str(release.get("baseSha") or "").strip()
    if base_sha:
        base_lock = _github_text(repo,"frontend/package-lock.json",base_sha)
        base_req = _github_text(repo,"backend/requirements.txt",base_sha)
        if base_lock or base_req:
            drift = {
                "baseAvailable":True,
                "frontendLockChanged": (_sha(base_lock) != _sha(lock_text)) if base_lock is not None and lock_text is not None else base_lock != lock_text,
                "backendRequirementsChanged": (_sha(base_req) != _sha(req_text)) if base_req is not None and req_text is not None else base_req != req_text,
            }
            drift["dependencyMaterialChanged"] = bool(drift["frontendLockChanged"] or drift["backendRequirementsChanged"])

    return {"frontend":frontend,"backend":backend,"materials":materials,"materialsDigestSha256":materials_digest,"drift":drift}


def _build_evidence(release: dict) -> dict:
    repo=release["repository"]; sha=release["candidateSha"]
    result={"available":False,"reproducible":False,"workflow":".github/workflows/reproducible-build.yml","githubOidcAttestation":"unknown"}
    try:
        data=v31._github_get(repo,f"actions/runs?head_sha={sha}&per_page=50")
        runs=data.get("workflow_runs",[]) if isinstance(data,dict) else []
        matches=[r for r in runs if str(r.get("path") or "").endswith("reproducible-build.yml")]
        if not matches: return {**result,"reason":"no_v33_workflow_run_for_candidate_sha"}
        run=sorted(matches,key=lambda x:str(x.get("created_at") or ""),reverse=True)[0]
        run_id=int(run["id"])
        jobs_data=v31._github_get(repo,f"actions/runs/{run_id}/jobs?per_page=100")
        jobs=jobs_data.get("jobs",[]) if isinstance(jobs_data,dict) else []
        steps=[]
        for job in jobs:
            if isinstance(job,dict): steps.extend(job.get("steps") or [])
        compare=next((s for s in steps if s.get("name")=="Fingerprint candidate B and compare"),None)
        attest=next((s for s in steps if s.get("name")=="GitHub OIDC build provenance"),None)
        artifacts_data=v31._github_get(repo,f"actions/runs/{run_id}/artifacts?per_page=100")
        artifacts=artifacts_data.get("artifacts",[]) if isinstance(artifacts_data,dict) else []
        artifact=next((a for a in artifacts if str(a.get("name") or "").startswith("v33-repro-evidence-")),None)
        reproducible=bool(run.get("conclusion")=="success" and compare and compare.get("conclusion")=="success")
        oidc=(attest or {}).get("conclusion") or "unknown"
        return {
            "available":True,"runId":run_id,"runUrl":run.get("html_url"),"status":run.get("status"),"conclusion":run.get("conclusion"),
            "reproducible":reproducible,"compareStep":(compare or {}).get("conclusion"),"githubOidcAttestation":oidc,
            "artifact":{"available":bool(artifact),"id":artifact.get("id") if artifact else None,"name":artifact.get("name") if artifact else None,
                        "sizeBytes":artifact.get("size_in_bytes") if artifact else None,"digest":artifact.get("digest") if artifact else None,
                        "expired":artifact.get("expired") if artifact else None},
            "workflow":run.get("path"),"createdAt":run.get("created_at"),
        }
    except Exception as exc:
        return {**result,"error":str(exc)[:500],"reason":"github_build_evidence_unavailable"}


def _v32_gate(release: dict) -> dict:
    scan=v32.store.latest_scan(release["id"],release["candidateSha"])
    if not scan: return {"ready":False,"available":False,"reason":"v32_scan_required"}
    gate=v32.evaluate_gate(scan,release,"production")
    return {"available":True,"scanId":scan["id"],**gate}


def _artifact_sbom(release: dict) -> dict:
    scan=v32.store.latest_scan(release["id"],release["candidateSha"])
    artifact=v32.store.latest_artifact(release["id"],"production")
    if not scan:
        return {"available":False,"reason":"v32_scan_required","binaryInspected":False}
    source_sbom=scan.get("sbom") or {}
    components=source_sbom.get("components") or []
    result={
        "bomFormat":"CycloneDX","specVersion":"1.5","version":1,
        "metadata":{"timestamp":_now(),"component":{"type":"application","name":artifact.get("name") if artifact else release["repository"],"version":release["candidateSha"]}},
        "components":components,"componentCount":len(components),"binaryInspected":False,
        "source":"V32 manifest SBOM bound to V33 artifact identity; not Syft binary inspection.",
        "artifact":artifact,
    }
    if artifact and artifact.get("digestSha256"):
        result["metadata"]["component"]["hashes"]=[{"alg":"SHA-256","content":artifact["digestSha256"]}]
    result["available"]=True
    return result


def _latest_attestation(release: dict) -> dict:
    items=store.attestations(release["id"],release["candidateSha"],20)
    external=next((x for x in items if x.get("mode") in {"sigstore","external","github-oidc"}),None)
    return {"available":bool(items),"latest":items[0] if items else None,"external":external,"count":len(items)}


def _latest_oci(release: dict) -> dict:
    item=store.latest_oci(release["id"],release["candidateSha"])
    return {"available":bool(item),"latest":item,"verified":bool(item and item.get("status")=="verified")}


def _post_json(url: str, token: str, payload: dict, *, timeout: int=20) -> dict:
    if not url.startswith("https://"):
        raise RuntimeError("External security adapters must use HTTPS.")
    headers={"Content-Type":"application/json","User-Agent":"MAGHRABI-V33/1.0"}
    if token: headers["Authorization"]=f"Bearer {token}"
    req=urllib.request.Request(url,data=json.dumps(payload).encode("utf-8"),headers=headers,method="POST")
    with urllib.request.urlopen(req,timeout=timeout) as response:
        raw=response.read(2*1024*1024)
        status=int(getattr(response,"status",200))
    if status<200 or status>=300: raise RuntimeError(f"Adapter returned HTTP {status}")
    return json.loads(raw.decode("utf-8")) if raw else {}


def _policy_decision(facts: dict, preliminary_blockers: list[str]) -> dict:
    if OPA_URL:
        try:
            data=_post_json(OPA_URL,OPA_TOKEN,{"input":facts})
            raw=data.get("result") if isinstance(data,dict) else None
            allow=bool(raw.get("allow")) if isinstance(raw,dict) else bool(raw)
            return {"available":True,"engine":"external-opa","allow":allow,"result":raw,"urlConfigured":True}
        except Exception as exc:
            return {"available":False,"engine":"external-opa","allow":False,"error":str(exc)[:500],"urlConfigured":True}
    return {"available":True,"engine":"internal-policy-equivalent","allow":not preliminary_blockers,"regoReference":SAMPLE_REGO,"urlConfigured":False,
            "note":"OPA endpoint is not configured; this is an internal deterministic policy decision, not an OPA evaluation."}


def _current_gate(assessment: dict, release: dict, environment: str="production") -> dict:
    policy=store.policy(); blockers=[]; warnings=[]
    locks=assessment.get("locks") or {}; frontend=locks.get("frontend") or {}; backend=locks.get("backend") or {}
    build=assessment.get("build") or {}; att=_latest_attestation(release); oci=_latest_oci(release); v32gate=_v32_gate(release)

    if policy.get("requireFrontendLock") and frontend.get("status")!="locked": blockers.append("Source-controlled frontend/package-lock.json is required and must match package.json.")
    if policy.get("requireLockIntegrity") and int(frontend.get("integrityMissing") or 0)>0: blockers.append("npm lockfile contains resolved packages without integrity hashes.")
    if policy.get("requireExactBackendPins") and not backend.get("exactPins"): blockers.append("Backend direct requirements must be exactly pinned with ==.")
    if policy.get("blockDependencyLockDrift") and (locks.get("drift") or {}).get("dependencyMaterialChanged"): blockers.append("Dependency lock drift detected against V31 base SHA.")
    if policy.get("requireV32ProductionGate") and not v32gate.get("ready"): blockers.append("Creator V32 production supply-chain gate is not ready.")

    if environment=="production":
        if policy.get("requireBuildEvidenceForProduction") and not build.get("available"): blockers.append("V33 GitHub Actions build evidence is required for Production.")
        if policy.get("requireReproducibleBuildForProduction") and not build.get("reproducible"): blockers.append("Candidate did not prove a reproducible frontend build.")
        if policy.get("requireGithubOidcAttestationForProduction") and build.get("githubOidcAttestation")!="success": blockers.append("GitHub OIDC build provenance attestation is required for Production.")
        if policy.get("requireExternalAttestationForProduction") and not att.get("external"): blockers.append("External/Sigstore attestation is required for Production.")
        if policy.get("requireOciDigestForProduction") and not oci.get("verified"): blockers.append("Verified OCI image digest evidence is required for Production.")

    created=_parse_ts(assessment.get("createdAt")); max_age=max(5,int(policy.get("maxAssessmentAgeMinutes",120) or 120))*60
    if created is None or time.time()-created>max_age: blockers.append("V33 assessment is stale; run a new assessment for this candidate SHA.")
    if assessment.get("candidateSha")!=release.get("candidateSha"): blockers.append("V33 assessment candidate SHA does not match the active V31 candidate.")

    facts={"release":{"id":release["id"],"candidateSha":release["candidateSha"],"environment":environment},"locks":locks,"build":build,"v32":v32gate,"attestation":att,"oci":oci}
    opa=_policy_decision(facts,blockers)
    if environment=="production" and policy.get("requireOpaAllowForProduction") and not opa.get("allow"): blockers.append("Policy-as-code decision denied Production promotion.")
    if not backend.get("transitiveLock"): warnings.append("Python transitive dependency graph is not hash-locked yet; direct requirements are pinned only.")
    if (locks.get("drift") or {}).get("dependencyMaterialChanged"): warnings.append("Dependency material changed from the V31 base SHA; review the lock diff before promotion.")
    if build.get("githubOidcAttestation")=="failure": warnings.append("GitHub OIDC provenance step was unavailable or failed; reproducibility comparison may still have passed.")
    return {"ready":not blockers,"environment":environment,"blockers":blockers,"warnings":warnings,"evaluatedAt":_now(),"assessmentId":assessment.get("id"),"candidateSha":release.get("candidateSha"),"opa":opa,"v32":v32gate,"attestation":att,"oci":oci}


def _assess(release: dict) -> dict:
    locks=_lock_analysis(release); build=_build_evidence(release); artifact_sbom=_artifact_sbom(release); oci=_latest_oci(release); att=_latest_attestation(release)
    policy=store.policy()
    draft={"id":None,"releaseId":release["id"],"candidateSha":release["candidateSha"],"locks":locks,"build":build,"artifactSbom":artifact_sbom,
           "oci":oci,"attestation":att,"opa":{},"policy":policy,"createdAt":_now()}
    gate=_current_gate(draft,release,"production")
    opa=gate.get("opa") or {}
    return store.create_assessment(release_id=release["id"],candidate_sha=release["candidateSha"],locks=locks,build=build,artifact_sbom=artifact_sbom,
                                   oci=oci,attestation=att,opa=opa,policy_value=policy,gate=gate)


def _statement(release: dict, assessment: dict, subject_name: str, digest: str, environment: str) -> dict:
    return {
        "_type":"https://in-toto.io/Statement/v1",
        "subject":[{"name":subject_name,"digest":{"sha256":digest}}],
        "predicateType":"https://slsa.dev/provenance/v1",
        "predicate":{
            "buildDefinition":{"buildType":"https://maghrabi.local/v33/reproducible-release","externalParameters":{"releaseId":release["id"],"environment":environment,"gitSha":release["candidateSha"]},
                               "resolvedDependencies":[{"uri":k,"digest":{"sha256":v}} for k,v in (assessment.get("locks") or {}).get("materials",{}).items() if v]},
            "runDetails":{"builder":{"id":"MAGHRABI-Creator-V33"},"metadata":{"invocationId":assessment["id"],"startedOn":assessment["createdAt"]}},
            "reproducibility":assessment.get("build"),
        },
    }


def _evidence(assessment: dict, release: dict) -> Path:
    path=EVIDENCE_DIR/f"MAGHRABI-V33-repro-attestation-{assessment['id']}.zip"
    gate=_current_gate(assessment,release,"production")
    entries={"assessment.json":assessment,"dependency-locks.json":assessment.get("locks"),"reproducible-build.json":assessment.get("build"),
             "artifact-sbom.cdx.json":assessment.get("artifactSbom"),"attestation.json":_latest_attestation(release),"oci-evidence.json":_latest_oci(release),
             "policy.json":store.policy(),"policy-decision.json":gate.get("opa"),"production-gate.json":gate,"sample-policy.rego":SAMPLE_REGO}
    with zipfile.ZipFile(path,"w",compression=zipfile.ZIP_DEFLATED) as z:
        for name,value in entries.items():
            z.writestr(name, value if isinstance(value,str) else json.dumps(value,ensure_ascii=False,indent=2))
        z.writestr("README.txt",f"MAGHRABI Creator V33 Reproducible Build Evidence\nRelease: {release['name']}\nCandidate SHA: {release['candidateSha']}\nAssessment: {assessment['id']}\n\nThe artifact SBOM is bound to V32 manifest evidence and is not a binary Syft scan unless an external artifact scanner is integrated. Internal HMAC attestations are not Sigstore. GitHub OIDC status comes from the V33 workflow step.\n")
    return path


def _attestation_actor(request: Request) -> dict:
    supplied=request.headers.get("x-v33-attestation-token","")
    if ATTESTATION_TOKEN and supplied and hmac.compare_digest(supplied,ATTESTATION_TOKEN): return {"id":"ci-attestor","role":"ci"}
    return v24.require_admin_write(request)


@router.get("/health/live")
async def live_v33() -> dict:
    return {"live":True,"version":"33","database":store.schema_status().get("databaseMode")}


@router.get("/admin/overview")
async def overview_v33(admin: dict = Depends(v24.require_admin)) -> dict:
    release=v31.store.active_release(); assessment=store.latest_assessment(release["id"],release["candidateSha"]) if release else None
    gate=_current_gate(assessment,release,"production") if release and assessment else None
    return {"version":"33","generatedAt":_now(),"schema":store.schema_status(),"policy":store.policy(),"activeRelease":release,"latestAssessment":assessment,
            "productionGate":gate,"assessments":store.list_assessments(30),"attestations":store.attestations(release["id"],release["candidateSha"],30) if release else [],
            "oci":_latest_oci(release) if release else {"available":False},"events":store.events(100),
            "capabilities":{"frontendLockWorkflow":True,"githubTokenConfigured":bool(v31.GITHUB_TOKEN),"signerConfigured":bool(SIGNER_URL),"opaConfigured":bool(OPA_URL),
                            "ociVerifierConfigured":bool(OCI_VERIFY_URL),"attestationTokenConfigured":bool(ATTESTATION_TOKEN),"regoReference":SAMPLE_REGO}}


@router.post("/admin/assess")
async def assess_v33(payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    release=_active_release(str(payload.get("releaseId") or "").strip() or None)
    try: assessment=_assess(release)
    except HTTPException: raise
    except Exception as exc:
        store.event("assessment_failed",release_id=release["id"],actor_id=str(admin.get("id") or "admin"),details={"error":str(exc)[:1000]})
        raise HTTPException(status_code=502,detail=f"V33 assessment failed: {str(exc)[:600]}") from exc
    gate=_current_gate(assessment,release,"production")
    store.event("assessment_completed",release_id=release["id"],actor_id=str(admin.get("id") or "admin"),details={"assessmentId":assessment["id"],"ready":gate["ready"]})
    return {**assessment,"productionGate":gate}


@router.post("/admin/policy")
async def save_policy_v33(payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    value=store.save_policy(payload); store.event("policy_updated",actor_id=str(admin.get("id") or "admin"),details={"policy":value}); return value


@router.post("/attest")
async def attest_v33(request: Request, payload: dict = Body(default={})) -> dict:
    actor=_attestation_actor(request); release=_active_release(str(payload.get("releaseId") or "").strip() or None)
    assessment=store.latest_assessment(release["id"],release["candidateSha"])
    if not assessment: raise HTTPException(status_code=428,detail="Run a V33 assessment before creating an attestation.")
    environment=str(payload.get("environment") or "production").lower()
    if environment not in {"dev","staging","production"}: raise HTTPException(status_code=422,detail="Environment غير صالح.")
    artifact=v32.store.latest_artifact(release["id"],environment) or v32.store.latest_artifact(release["id"],"production")
    digest=str(payload.get("digestSha256") or (artifact or {}).get("digestSha256") or "").lower().replace("sha256:","").strip()
    if not re.fullmatch(r"[0-9a-f]{64}",digest): raise HTTPException(status_code=422,detail="A SHA-256 artifact digest is required.")
    subject=str(payload.get("subjectName") or (artifact or {}).get("name") or "deployment-artifact")[:240]
    statement=_statement(release,assessment,subject,digest,environment)
    mode="internal"; issuer="MAGHRABI-V33"; identity=str(actor.get("id") or "admin"); bundle={"statement":statement,"signature":{"scheme":"HMAC-SHA256","value":_hmac(statement)},"verified":True}
    if SIGNER_URL:
        try:
            response=_post_json(SIGNER_URL,SIGNER_TOKEN,{"statement":statement,"releaseId":release["id"],"candidateSha":release["candidateSha"]})
            if not response.get("verified"): raise RuntimeError("External signer did not return verified=true")
            mode=str(response.get("mode") or "external"); issuer=str(response.get("issuer") or "external-signer")[:240]; identity=str(response.get("identity") or "external")[:240]; bundle=response
        except Exception as exc:
            raise HTTPException(status_code=502,detail=f"External attestation signer failed: {str(exc)[:500]}") from exc
    item=store.add_attestation(release_id=release["id"],candidate_sha=release["candidateSha"],environment=environment,subject_name=subject,digest_sha256=digest,
                               mode=mode,issuer=issuer,identity=identity,bundle=bundle)
    store.event("attestation_created",release_id=release["id"],actor_id=str(actor.get("id") or "unknown"),details={"attestationId":item["id"],"mode":mode,"digest":digest})
    return item


@router.post("/admin/oci/verify")
async def verify_oci_v33(payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    release=_active_release(str(payload.get("releaseId") or "").strip() or None)
    image_ref=str(payload.get("imageRef") or "").strip(); digest=str(payload.get("digestSha256") or "").lower().replace("sha256:","").strip()
    if not image_ref: raise HTTPException(status_code=422,detail="imageRef مطلوب.")
    if not re.fullmatch(r"[0-9a-f]{64}",digest): raise HTTPException(status_code=422,detail="digestSha256 يجب أن يكون 64 hex.")
    status="unverified"; verifier="syntax-only"; metadata={"note":"Digest syntax accepted; registry identity was not externally verified."}
    if OCI_VERIFY_URL:
        try:
            response=_post_json(OCI_VERIFY_URL,OCI_VERIFY_TOKEN,{"imageRef":image_ref,"digestSha256":digest,"candidateSha":release["candidateSha"]})
            status="verified" if response.get("verified") else "failed"; verifier=str(response.get("verifier") or "external-oci-verifier"); metadata=response
        except Exception as exc:
            raise HTTPException(status_code=502,detail=f"OCI verifier failed: {str(exc)[:500]}") from exc
    item=store.add_oci(release_id=release["id"],candidate_sha=release["candidateSha"],image_ref=image_ref,digest_sha256=digest,status=status,verifier=verifier,metadata=metadata)
    store.event("oci_verified",release_id=release["id"],actor_id=str(admin.get("id") or "admin"),details={"status":status,"imageRef":image_ref,"digest":digest})
    return item


@router.get("/admin/assessments/{assessment_id}/evidence")
async def evidence_v33(assessment_id: str, admin: dict = Depends(v24.require_admin)) -> FileResponse:
    assessment=store.get_assessment(assessment_id)
    if not assessment: raise HTTPException(status_code=404,detail="Assessment غير موجودة.")
    release=v31.store.get_release(assessment["releaseId"])
    if not release: raise HTTPException(status_code=404,detail="Release غير موجودة.")
    path=_evidence(assessment,release); return FileResponse(path,media_type="application/zip",filename=path.name)


@router.get("/release/ready")
async def ready_v33() -> JSONResponse:
    release=v31.store.active_release()
    if not release: return JSONResponse({"ready":True,"state":"no-active-release","version":"33"})
    assessment=store.latest_assessment(release["id"],release["candidateSha"])
    if not assessment: return JSONResponse({"ready":False,"state":"assessment-required","version":"33","releaseId":release["id"]},status_code=503)
    gate=_current_gate(assessment,release,"production")
    return JSONResponse({"ready":gate["ready"],"gate":gate,"assessmentId":assessment["id"],"version":"33"},status_code=200 if gate["ready"] else 503)
