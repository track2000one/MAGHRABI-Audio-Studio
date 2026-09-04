from __future__ import annotations

import json
import os
import re
import time
import urllib.parse
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from . import supply_chain_store_v34 as store
from . import video_tools_v24 as v24
from . import video_tools_v31 as v31
from . import video_tools_v32 as v32
from . import video_tools_v33 as v33
from .main import DATA_DIR

router=APIRouter(prefix="/api/video/v34",tags=["video-studio-v34"])
EVIDENCE_DIR=DATA_DIR/"video_supply_chain"/"v34_evidence"; EVIDENCE_DIR.mkdir(parents=True,exist_ok=True)
NON_WAIVABLE={"candidate_mismatch","python_lock_missing","python_hash_incomplete","torch_cpu_stack_mismatch"}


def _now()->str:return datetime.now(timezone.utc).isoformat()

def _parse_ts(value:str|None)->float|None:
    if not value:return None
    try:return datetime.fromisoformat(str(value).replace("Z","+00:00")).timestamp()
    except Exception:return None


def _active_release(release_id:str|None=None)->dict:
    release=v31.store.get_release(release_id) if release_id else v31.store.active_release()
    if not release:raise HTTPException(status_code=404,detail="لا توجد V31 Release نشطة.")
    return release


def _python_lock(release:dict)->dict:
    text=v32._github_text(release["repository"],"backend/requirements.lock.txt",release["candidateSha"])
    if not text:return {"available":False,"hashComplete":False,"packages":0,"hashes":0,"torchCpu":False,"torchaudioCpu":False}
    packages=[]; current=None
    for raw in text.splitlines():
        line=raw.strip()
        m=re.match(r"^([A-Za-z0-9_.-]+)==([^\\\s]+)",line)
        if m:
            if current:packages.append(current)
            current={"name":m.group(1).lower(),"version":m.group(2),"hashes":0}
        elif current and "--hash=sha256:" in line:
            current["hashes"]+=line.count("--hash=sha256:")
    if current:packages.append(current)
    missing=[p for p in packages if int(p.get("hashes") or 0)==0]
    torch=next((p for p in packages if p["name"]=="torch"),None)
    torchaudio=next((p for p in packages if p["name"]=="torchaudio"),None)
    return {"available":True,"sha256":v32._sha(text),"packages":len(packages),"hashes":sum(int(p["hashes"]) for p in packages),
            "hashComplete":bool(packages) and not missing,"missingHashPackages":[p["name"] for p in missing[:40]],
            "torchCpu":bool(torch and torch.get("version")=="2.0.1+cpu"),"torchaudioCpu":bool(torchaudio and torchaudio.get("version")=="2.0.2+cpu"),
            "torchVersion":torch.get("version") if torch else None,"torchaudioVersion":torchaudio.get("version") if torchaudio else None}


def _workflow(release:dict)->dict:
    result={"available":False,"success":False,"crossRunner":False,"syft":False,"scanner":False,"criticalGate":False,"oidc":False,"artifact":None}
    try:
        data=v31._github_get(release["repository"],f"actions/runs?head_sha={urllib.parse.quote(release['candidateSha'],safe='')}&per_page=50")
        runs=data.get("workflow_runs",[]) if isinstance(data,dict) else []
        matches=[r for r in runs if str(r.get("path") or "").endswith("v34-hermetic-artifact.yml")]
        if not matches:return {**result,"reason":"no_v34_workflow_for_candidate"}
        run=sorted(matches,key=lambda x:str(x.get("created_at") or ""),reverse=True)[0]; run_id=int(run["id"])
        jobs_data=v31._github_get(release["repository"],f"actions/runs/{run_id}/jobs?per_page=100")
        jobs=jobs_data.get("jobs",[]) if isinstance(jobs_data,dict) else []
        verify=next((j for j in jobs if j.get("name")=="verify-artifact"),{})
        steps={str(s.get("name")):s for s in (verify.get("steps") or []) if isinstance(s,dict)}
        arts=v31._github_get(release["repository"],f"actions/runs/{run_id}/artifacts?per_page=100")
        items=arts.get("artifacts",[]) if isinstance(arts,dict) else []
        artifact=next((a for a in items if str(a.get("name") or "").startswith(f"v34-hermetic-{release['candidateSha']}-")),None)
        digest=None
        if artifact:
            m=re.search(r"-([0-9a-f]{64})$",str(artifact.get("name") or "")); digest=m.group(1) if m else None
        def ok(name):return (steps.get(name) or {}).get("conclusion")=="success"
        success=run.get("conclusion")=="success" and verify.get("conclusion")=="success"
        return {"available":True,"success":success,"runId":run_id,"runUrl":run.get("html_url"),"conclusion":run.get("conclusion"),"createdAt":run.get("created_at"),
                "crossRunner":ok("Prove cross-run reproducibility"),"syft":ok("Generate Syft artifact SBOM"),"scanner":ok("Trivy artifact report"),
                "criticalGate":ok("Trivy critical gate"),"oidc":ok("GitHub OIDC artifact provenance"),
                "artifact":{"available":bool(artifact),"id":artifact.get("id") if artifact else None,"name":artifact.get("name") if artifact else None,
                            "sizeBytes":artifact.get("size_in_bytes") if artifact else None,"archiveDigest":artifact.get("digest") if artifact else None,"canonicalSha256":digest,
                            "expired":artifact.get("expired") if artifact else None},"scannerThreshold":"CRITICAL"}
    except Exception as exc:return {**result,"error":str(exc)[:500],"reason":"github_workflow_evidence_unavailable"}


def _github_attestation(release:dict,workflow:dict)->dict:
    digest=str(((workflow.get("artifact") or {}).get("canonicalSha256") or ""))
    if not re.fullmatch(r"[0-9a-f]{64}",digest):return {"available":False,"verifiedPresence":False,"reason":"canonical_artifact_digest_missing"}
    try:
        data=v31._github_get(release["repository"],f"attestations/sha256:{digest}?per_page=100")
        items=data.get("attestations",[]) if isinstance(data,dict) else []
        return {"available":True,"verifiedPresence":bool(items),"count":len(items),"subjectDigest":f"sha256:{digest}",
                "bundlePresent":bool(items and (items[0] or {}).get("bundle")),"repository":release["repository"]}
    except Exception as exc:
        return {"available":False,"verifiedPresence":False,"subjectDigest":f"sha256:{digest}","error":str(exc)[:500],"reason":"github_attestation_api_unavailable"}


def _v33(release:dict)->dict:
    assessment=v33.store.latest_assessment(release["id"],release["candidateSha"])
    if not assessment:return {"available":False,"ready":False,"reason":"v33_assessment_required"}
    gate=v33._current_gate(assessment,release,"production")
    return {"available":True,"assessmentId":assessment["id"],**gate}


def _active_waivers(release:dict)->list[dict]:
    now=time.time(); out=[]
    for item in store.waivers(release["id"],200):
        if item.get("candidateSha")!=release["candidateSha"] or item.get("revokedAt"):continue
        expires=_parse_ts(item.get("expiresAt"))
        if expires and expires>now:out.append(item)
    return out


def _gate(assessment:dict,release:dict,environment:str="production")->dict:
    policy=store.policy(); blockers=[]; warnings=[]
    py=assessment.get("pythonLock") or {}; wf=assessment.get("workflow") or {}; gh=assessment.get("githubAttestation") or {}; v33gate=_v33(release)
    def block(code,msg):blockers.append({"code":code,"message":msg})
    if assessment.get("candidateSha")!=release.get("candidateSha"):block("candidate_mismatch","V34 assessment candidate SHA does not match the active release.")
    if policy.get("requirePythonHashLock") and not py.get("available"):block("python_lock_missing","backend/requirements.lock.txt is required.")
    if policy.get("requirePythonHashLock") and py.get("available") and not py.get("hashComplete"):block("python_hash_incomplete","Python transitive lock contains packages without SHA-256 hashes.")
    if policy.get("requireTorchCpuPins") and not (py.get("torchCpu") and py.get("torchaudioCpu")):block("torch_cpu_stack_mismatch","Torch CPU stack must remain torch 2.0.1+cpu / torchaudio 2.0.2+cpu.")
    if policy.get("requireCrossRunnerReproducible") and not wf.get("crossRunner"):block("cross_runner_repro","Cross-run reproducibility evidence is required.")
    if policy.get("requireSyftArtifactSbom") and not wf.get("syft"):block("syft_sbom","Syft artifact SBOM step is required.")
    if policy.get("requireArtifactScanner") and not wf.get("scanner"):block("artifact_scanner","Artifact vulnerability scanner evidence is required.")
    if policy.get("requireCriticalScanGate") and not wf.get("criticalGate"):block("critical_scan_gate","Critical vulnerability gate did not pass.")
    if policy.get("requireGithubOidcStep") and not wf.get("oidc"):block("github_oidc_step","GitHub OIDC artifact provenance step is required.")
    if policy.get("requireGithubAttestationApi") and not gh.get("verifiedPresence"):block("github_attestation_api","GitHub Attestations API did not confirm an attestation for the canonical artifact digest.")
    if policy.get("requireV33ProductionGate") and not v33gate.get("ready"):block("v33_gate","Creator V33 production gate is not ready.")
    if policy.get("requirePostgresForProduction") and store.schema_status().get("databaseMode")!="postgresql":block("postgres_required","PostgreSQL evidence store is required for Production.")
    created=_parse_ts(assessment.get("createdAt")); max_age=max(5,int(policy.get("maxEvidenceAgeMinutes",120) or 120))*60
    if created is None or time.time()-created>max_age:block("evidence_stale","V34 evidence is stale; run a new assessment.")
    if not gh.get("available"):warnings.append("GitHub Attestations API could not be confirmed; OIDC workflow step may still have succeeded.")
    warnings.append("V34 Syft scans the assembled deploy artifact root; Railway runtime container image is not OCI-verified unless an OCI verifier is connected in V33/V34 policy.")
    waivers=_active_waivers(release); active_codes={w["blockerCode"] for w in waivers}
    remaining=[]; waived=[]
    for item in blockers:
        if item["code"] in active_codes and item["code"] not in NON_WAIVABLE:
            waived.append(item)
        else:remaining.append(item)
    return {"ready":not remaining,"environment":environment,"blockers":remaining,"waivedBlockers":waived,"warnings":warnings,"waivers":waivers,
            "evaluatedAt":_now(),"assessmentId":assessment.get("id"),"candidateSha":release.get("candidateSha"),"policy":policy,"v33":v33gate,"githubAttestation":gh}


def _assess(release:dict)->dict:
    py=_python_lock(release); wf=_workflow(release); gh=_github_attestation(release,wf); v33gate=_v33(release); policy=store.policy()
    draft={"id":None,"releaseId":release["id"],"candidateSha":release["candidateSha"],"pythonLock":py,"workflow":wf,"githubAttestation":gh,"v33":v33gate,"createdAt":_now()}
    gate=_gate(draft,release,"production")
    return store.create_assessment(release_id=release["id"],candidate_sha=release["candidateSha"],python_lock=py,workflow=wf,github_attestation=gh,v33=v33gate,policy_value=policy,gate=gate)


def _evidence(assessment:dict,release:dict)->Path:
    path=EVIDENCE_DIR/f"MAGHRABI-V34-hermetic-{assessment['id']}.zip"; gate=_gate(assessment,release,"production")
    entries={"assessment.json":assessment,"python-hash-lock.json":assessment.get("pythonLock"),"hermetic-workflow.json":assessment.get("workflow"),
             "github-attestation-api.json":assessment.get("githubAttestation"),"v33-chain.json":gate.get("v33"),"policy.json":store.policy(),"production-gate.json":gate,"waivers.json":gate.get("waivers")}
    with zipfile.ZipFile(path,"w",compression=zipfile.ZIP_DEFLATED) as z:
        for name,value in entries.items():z.writestr(name,json.dumps(value,ensure_ascii=False,indent=2))
        z.writestr("README.txt",f"MAGHRABI Creator V34 Hermetic Evidence\nRelease: {release['name']}\nCandidate SHA: {release['candidateSha']}\nAssessment: {assessment['id']}\n\nNon-waivable integrity blockers: {', '.join(sorted(NON_WAIVABLE))}. Temporary waivers are scoped to this release + candidate SHA and expire automatically.\n")
    return path


@router.get("/health/live")
async def live_v34()->dict:return {"live":True,"version":"34","database":store.schema_status().get("databaseMode")}

@router.get("/admin/overview")
async def overview_v34(admin:dict=Depends(v24.require_admin))->dict:
    release=v31.store.active_release(); assessment=store.latest_assessment(release["id"],release["candidateSha"]) if release else None
    gate=_gate(assessment,release,"production") if release and assessment else None
    return {"version":"34","generatedAt":_now(),"schema":store.schema_status(),"policy":store.policy(),"activeRelease":release,"latestAssessment":assessment,"productionGate":gate,
            "assessments":store.list_assessments(30),"waivers":store.waivers(release["id"],100) if release else [],"events":store.events(100),"nonWaivable":sorted(NON_WAIVABLE)}

@router.post("/admin/assess")
async def assess_v34(payload:dict=Body(default={}),admin:dict=Depends(v24.require_admin_write))->dict:
    release=_active_release(str(payload.get("releaseId") or "").strip() or None)
    assessment=_assess(release); gate=_gate(assessment,release,"production")
    store.event("assessment_completed",release_id=release["id"],actor_id=str(admin.get("id") or "admin"),details={"assessmentId":assessment["id"],"ready":gate["ready"]})
    return {**assessment,"productionGate":gate}

@router.post("/admin/policy")
async def policy_v34(payload:dict=Body(default={}),admin:dict=Depends(v24.require_admin_write))->dict:
    value=store.save_policy(payload); store.event("policy_updated",actor_id=str(admin.get("id") or "admin"),details={"policy":value}); return value

@router.post("/admin/waivers")
async def waiver_v34(payload:dict=Body(default={}),admin:dict=Depends(v24.require_admin_write))->dict:
    release=_active_release(str(payload.get("releaseId") or "").strip() or None); policy=store.policy()
    if not policy.get("allowTemporaryWaivers"):raise HTTPException(status_code=403,detail="Temporary waivers are disabled by policy.")
    assessment=store.latest_assessment(release["id"],release["candidateSha"])
    if not assessment:raise HTTPException(status_code=428,detail="Run V34 assessment first.")
    gate=_gate(assessment,release,"production"); code=str(payload.get("blockerCode") or "").strip()
    current={x["code"] for x in gate.get("blockers",[])}
    if code not in current:raise HTTPException(status_code=422,detail="Waiver code is not an active blocker.")
    if code in NON_WAIVABLE:raise HTTPException(status_code=403,detail="This integrity blocker is non-waivable.")
    reason=str(payload.get("reason") or "").strip()
    if len(reason)<12:raise HTTPException(status_code=422,detail="Waiver reason must be at least 12 characters.")
    hours=max(1,min(int(payload.get("hours") or 24),int(policy.get("waiverMaxHours",168) or 168)))
    expires=(datetime.now(timezone.utc)+timedelta(hours=hours)).isoformat()
    item=store.create_waiver(release_id=release["id"],candidate_sha=release["candidateSha"],blocker_code=code,reason=reason[:1000],approver_id=str(admin.get("id") or "admin"),expires_at=expires)
    store.event("waiver_created",release_id=release["id"],actor_id=str(admin.get("id") or "admin"),details={"waiverId":item["id"],"code":code,"expiresAt":expires}); return item

@router.post("/admin/waivers/{waiver_id}/revoke")
async def revoke_v34(waiver_id:str,admin:dict=Depends(v24.require_admin_write))->dict:
    item=store.revoke_waiver(waiver_id)
    if not item:raise HTTPException(status_code=404,detail="Waiver غير موجودة.")
    store.event("waiver_revoked",release_id=item.get("releaseId"),actor_id=str(admin.get("id") or "admin"),details={"waiverId":waiver_id}); return item

@router.get("/admin/assessments/{assessment_id}/evidence")
async def evidence_v34(assessment_id:str,admin:dict=Depends(v24.require_admin))->FileResponse:
    assessment=store.get_assessment(assessment_id)
    if not assessment:raise HTTPException(status_code=404,detail="Assessment غير موجودة.")
    release=v31.store.get_release(assessment["releaseId"])
    if not release:raise HTTPException(status_code=404,detail="Release غير موجودة.")
    path=_evidence(assessment,release); return FileResponse(path,media_type="application/zip",filename=path.name)

@router.get("/release/ready")
async def ready_v34()->JSONResponse:
    release=v31.store.active_release()
    if not release:return JSONResponse({"ready":True,"state":"no-active-release","version":"34"})
    assessment=store.latest_assessment(release["id"],release["candidateSha"])
    if not assessment:return JSONResponse({"ready":False,"state":"assessment-required","version":"34","releaseId":release["id"]},status_code=503)
    gate=_gate(assessment,release,"production"); return JSONResponse({"ready":gate["ready"],"gate":gate,"version":"34"},status_code=200 if gate["ready"] else 503)
