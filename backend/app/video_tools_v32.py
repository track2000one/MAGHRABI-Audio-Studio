from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from . import supply_chain_store_v32 as store
from . import video_tools_v24 as v24
from . import video_tools_v31 as v31
from .main import AUTH_SECRET, DATA_DIR

router = APIRouter(prefix="/api/video/v32", tags=["video-studio-v32"])

OSV_URL = os.getenv("V32_OSV_URL", "https://api.osv.dev/v1/querybatch").strip()
ATTESTATION_TOKEN = os.getenv("V32_ATTESTATION_TOKEN", "").strip()
EVIDENCE_DIR = DATA_DIR / "video_supply_chain" / "evidence"
EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)

TRACKED_ENV_EXACT = {
    "DATABASE_URL", "AUTH_SECRET", "ADMIN_USERNAME", "ADMIN_PASSWORD", "PUBLIC_BASE_URL",
    "STT_WORKER_URL", "STT_WORKER_TOKEN", "V26_WORKER_TOKEN", "V31_GITHUB_TOKEN",
    "V31_DEPLOY_WEBHOOK_URL", "V31_DEPLOY_WEBHOOK_TOKEN", "V30_TRAFFIC_WEBHOOK_URL",
    "V30_TRAFFIC_WEBHOOK_TOKEN", "V32_ATTESTATION_TOKEN",
}
TRACKED_ENV_PREFIXES = ("SMTP_", "OIDC_", "V24_", "V25_", "V26_", "V27_", "V28_", "V29_", "V30_", "V31_", "V32_")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_ts(value: str | None) -> float | None:
    if not value: return None
    try: return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except Exception: return None


def _secret() -> bytes:
    value = (AUTH_SECRET or "").encode("utf-8")
    if len(value) < 32:
        raise HTTPException(status_code=503, detail="AUTH_SECRET يجب أن يكون 32 حرفًا على الأقل لتشغيل V32 provenance/config fingerprints.")
    return value


def _canonical(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sha(value: bytes | str) -> str:
    data = value.encode("utf-8") if isinstance(value, str) else value
    return hashlib.sha256(data).hexdigest()


def _hmac(value) -> str:
    return hmac.new(_secret(), _canonical(value) if not isinstance(value, (str, bytes)) else (value.encode() if isinstance(value,str) else value), hashlib.sha256).hexdigest()


def _github_text(repository: str, path: str, sha: str) -> str | None:
    try:
        encoded_path = "/".join(urllib.parse.quote(part, safe="") for part in path.split("/"))
        data = v31._github_get(repository, f"contents/{encoded_path}?ref={urllib.parse.quote(sha, safe='')}")
        if not isinstance(data, dict) or data.get("type") != "file": return None
        content = str(data.get("content") or "").replace("\n", "")
        if data.get("encoding") == "base64" and content:
            return base64.b64decode(content).decode("utf-8", errors="replace")
        return None
    except Exception:
        return None


def _version(value: str) -> str | None:
    text = str(value or "").strip()
    match = re.search(r"(\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)", text)
    return match.group(1) if match else None


def _parse_requirements(text: str) -> list[dict]:
    items = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("-"): continue
        left = re.split(r"[<>=!~]", line, 1)[0].strip()
        name = re.sub(r"\[.*?\]", "", left).strip()
        if not name: continue
        version = _version(line)
        items.append({"type":"library","name":name,"version":version,"declared":line,"ecosystem":"PyPI","scope":"runtime","purl":f"pkg:pypi/{name.lower()}@{version}" if version else f"pkg:pypi/{name.lower()}"})
    return items


def _build_sbom(repository: str, sha: str) -> dict:
    package_text = _github_text(repository, "frontend/package.json", sha)
    req_text = _github_text(repository, "backend/requirements.txt", sha)
    docker_text = _github_text(repository, "Dockerfile", sha)
    components: list[dict] = []
    materials: dict[str, str] = {}
    warnings: list[str] = []

    if package_text:
        materials["frontend/package.json"] = _sha(package_text)
        try:
            pkg = json.loads(package_text)
            for section, scope in (("dependencies","runtime"),("devDependencies","development")):
                for name, declared in (pkg.get(section) or {}).items():
                    ver = _version(str(declared))
                    components.append({"type":"library","name":name,"version":ver,"declared":declared,"ecosystem":"npm","scope":scope,
                                       "purl":f"pkg:npm/{urllib.parse.quote(name, safe='@/')}@{ver}" if ver else f"pkg:npm/{urllib.parse.quote(name, safe='@/')}"})
                    if str(declared).startswith(("^","~",">","<","*")): warnings.append(f"npm dependency is range-pinned, not exact: {name} {declared}")
        except Exception as exc:
            warnings.append(f"package.json parse failed: {str(exc)[:160]}")
    else: warnings.append("frontend/package.json unavailable at candidate SHA")

    if req_text:
        materials["backend/requirements.txt"] = _sha(req_text)
        components.extend(_parse_requirements(req_text))
    else: warnings.append("backend/requirements.txt unavailable at candidate SHA")

    if docker_text:
        materials["Dockerfile"] = _sha(docker_text)
        for line in docker_text.splitlines():
            if line.strip().upper().startswith("FROM "):
                image = line.strip().split()[1]
                components.append({"type":"container","name":image,"version":None,"declared":image,"ecosystem":"container","scope":"build","purl":f"pkg:docker/{image}"})
    else: warnings.append("Dockerfile unavailable at candidate SHA")

    # direct-dependency CycloneDX-compatible subset; no claim of transitive completeness without lockfiles.
    return {
        "bomFormat":"CycloneDX","specVersion":"1.5","serialNumber":f"urn:uuid:{hashlib.md5((repository+sha).encode()).hexdigest()}",
        "version":1,"metadata":{"timestamp":_now(),"component":{"type":"application","name":repository,"version":sha}},
        "components":components,"materials":materials,"componentCount":len(components),"warnings":warnings,
        "coverage":"direct-manifests","transitiveComplete":False,
    }


def _osv(sbom: dict) -> dict:
    queries=[]; refs=[]
    for item in sbom.get("components",[]):
        eco=item.get("ecosystem"); ver=item.get("version"); name=item.get("name")
        if eco not in {"npm","PyPI"} or not ver or not name: continue
        queries.append({"package":{"name":name,"ecosystem":eco},"version":ver}); refs.append(item)
    if not queries: return {"available":True,"queries":0,"items":[],"summary":{"critical":0,"high":0,"medium":0,"low":0,"unknown":0,"total":0}}
    payload=json.dumps({"queries":queries}).encode()
    req=urllib.request.Request(OSV_URL,data=payload,headers={"Content-Type":"application/json","User-Agent":"MAGHRABI-V32/1.0"},method="POST")
    try:
        with urllib.request.urlopen(req,timeout=20) as response: raw=response.read(4*1024*1024)
        data=json.loads(raw.decode())
    except Exception as exc:
        return {"available":False,"queries":len(queries),"items":[],"error":str(exc)[:500],"summary":{"critical":0,"high":0,"medium":0,"low":0,"unknown":0,"total":0}}
    findings=[]; counts={"critical":0,"high":0,"medium":0,"low":0,"unknown":0,"total":0}
    results=data.get("results",[]) if isinstance(data,dict) else []
    for idx,result in enumerate(results):
        vulns=result.get("vulns",[]) if isinstance(result,dict) else []
        for vuln in vulns:
            sev="unknown"
            dbs=vuln.get("database_specific") if isinstance(vuln,dict) else {}
            rawsev=str((dbs or {}).get("severity") or "").lower()
            if rawsev in counts: sev=rawsev
            aliases=vuln.get("aliases",[]) if isinstance(vuln,dict) else []
            findings.append({"id":vuln.get("id"),"aliases":aliases[:8],"summary":vuln.get("summary"),"severity":sev,
                             "package":refs[idx].get("name") if idx<len(refs) else None,"version":refs[idx].get("version") if idx<len(refs) else None})
            counts[sev]+=1; counts["total"]+=1
    return {"available":True,"queries":len(queries),"items":findings,"summary":counts}


def _metadata(component: dict) -> dict:
    eco=component.get("ecosystem"); name=component.get("name"); version=component.get("version")
    if not name or eco not in {"npm","PyPI"}: return {"name":name,"available":False}
    try:
        if eco=="npm":
            url=f"https://registry.npmjs.org/{urllib.parse.quote(str(name),safe='@')}/{urllib.parse.quote(str(version or 'latest'),safe='')}"
            with urllib.request.urlopen(urllib.request.Request(url,headers={"User-Agent":"MAGHRABI-V32/1.0"}),timeout=8) as r: data=json.loads(r.read(512*1024).decode())
            license_value=data.get("license")
        else:
            if not version: return {"name":name,"available":False,"reason":"version unknown"}
            url=f"https://pypi.org/pypi/{urllib.parse.quote(str(name),safe='')}/{urllib.parse.quote(str(version),safe='')}/json"
            with urllib.request.urlopen(urllib.request.Request(url,headers={"User-Agent":"MAGHRABI-V32/1.0"}),timeout=8) as r: data=json.loads(r.read(1024*1024).decode())
            info=data.get("info",{}) if isinstance(data,dict) else {}; license_value=info.get("license")
            if not license_value:
                classifiers=info.get("classifiers",[]) or []
                lic=[x.split(" :: ")[-1] for x in classifiers if str(x).startswith("License ::")]
                license_value=", ".join(lic[:3]) if lic else None
        return {"name":name,"ecosystem":eco,"version":version,"available":True,"license":license_value or "UNKNOWN"}
    except Exception as exc:
        return {"name":name,"ecosystem":eco,"version":version,"available":False,"license":"UNKNOWN","error":str(exc)[:180]}


def _licenses(sbom: dict, policy: dict) -> dict:
    candidates=[c for c in sbom.get("components",[]) if c.get("ecosystem") in {"npm","PyPI"}]
    results=[]
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures=[pool.submit(_metadata,c) for c in candidates]
        for f in as_completed(futures): results.append(f.result())
    denied=[]; warned=[]; unknown=[]
    deny=[x.lower() for x in policy.get("deniedLicenses",[])]; warn=[x.lower() for x in policy.get("warnLicenses",[])]
    for item in results:
        lic=str(item.get("license") or "UNKNOWN")
        low=lic.lower()
        if lic=="UNKNOWN": unknown.append(item)
        if any(x and x in low for x in deny): denied.append(item)
        elif any(x and x in low for x in warn): warned.append(item)
    return {"items":sorted(results,key=lambda x:str(x.get("name"))),"denied":denied,"warned":warned,"unknown":unknown,
            "summary":{"total":len(results),"denied":len(denied),"warned":len(warned),"unknown":len(unknown)}}


def _signatures(release: dict) -> dict:
    repository=release["repository"]; sha=release["candidateSha"]
    result={"commit":{"available":False,"verified":False},"tag":{"available":False,"verified":False}}
    try:
        data=v31._github_get(repository,f"commits/{urllib.parse.quote(sha,safe='')}")
        verification=data.get("commit",{}).get("verification",{}) if isinstance(data,dict) else {}
        result["commit"]={"available":True,"verified":bool(verification.get("verified")),"reason":verification.get("reason"),"signaturePresent":bool(verification.get("signature")),"payloadPresent":bool(verification.get("payload"))}
    except Exception as exc: result["commit"]["error"]=str(exc)[:300]
    tag=str(release.get("tagName") or "").strip()
    if tag:
        try:
            ref=v31._github_get(repository,f"git/ref/tags/{urllib.parse.quote(tag,safe='')}")
            obj=ref.get("object",{}) if isinstance(ref,dict) else {}
            if obj.get("type")=="tag" and obj.get("sha"):
                tagdata=v31._github_get(repository,f"git/tags/{urllib.parse.quote(str(obj['sha']),safe='')}")
                verification=tagdata.get("verification",{}) if isinstance(tagdata,dict) else {}
                result["tag"]={"available":True,"annotated":True,"verified":bool(verification.get("verified")),"reason":verification.get("reason")}
            else:
                result["tag"]={"available":True,"annotated":False,"verified":False,"reason":"lightweight_tag_has_no_tag_signature"}
        except Exception as exc: result["tag"]={"available":False,"verified":False,"error":str(exc)[:300]}
    return result


def _rules(release: dict) -> dict:
    repository=release["repository"]; ref=str(release.get("candidateRef") or "main")
    result={"branch":ref,"protection":{"available":False,"protected":False},"rulesets":{"available":False,"count":0,"items":[]}}
    try:
        data=v31._github_get(repository,f"branches/{urllib.parse.quote(ref,safe='')}/protection")
        result["protection"]={"available":True,"protected":True,"requiredStatusChecks":bool((data or {}).get("required_status_checks")),"enforceAdmins":bool(((data or {}).get("enforce_admins") or {}).get("enabled"))}
    except Exception as exc: result["protection"]["error"]=str(exc)[:260]
    try:
        data=v31._github_get(repository,"rulesets?includes_parents=true&per_page=100")
        items=data if isinstance(data,list) else []
        result["rulesets"]={"available":True,"count":len(items),"items":[{"id":x.get("id"),"name":x.get("name"),"enforcement":x.get("enforcement"),"target":x.get("target")} for x in items[:50] if isinstance(x,dict)]}
    except Exception as exc: result["rulesets"]["error"]=str(exc)[:260]
    return result


def _fingerprints() -> dict:
    names=sorted(name for name in os.environ if name in TRACKED_ENV_EXACT or name.startswith(TRACKED_ENV_PREFIXES))
    values={name:hmac.new(_secret(),f"v32-config|{name}|{os.environ.get(name,'')}".encode(),hashlib.sha256).hexdigest() for name in names}
    return {"names":names,"fingerprints":values}


def _drift_for(environment: str, current: dict) -> dict:
    baseline=store.baseline(environment)
    if not baseline: return {"environment":environment,"baselineAvailable":False,"status":"no_baseline","added":[],"missing":[],"changed":[]}
    old=baseline.get("fingerprints",{}); now=current["fingerprints"]
    added=sorted(set(now)-set(old)); missing=sorted(set(old)-set(now)); changed=sorted(k for k in set(old)&set(now) if old[k]!=now[k])
    return {"environment":environment,"baselineAvailable":True,"status":"drift" if (added or missing or changed) else "clean","added":added,"missing":missing,"changed":changed,"baselineUpdatedAt":baseline.get("updatedAt")}


def _artifact(release: dict) -> dict:
    items=store.artifacts(release["id"],30); latest=items[0] if items else None
    return {"available":bool(latest),"latest":latest,"items":items}


def _provenance(release: dict, sbom: dict, artifact: dict) -> dict:
    statement={
        "_type":"https://in-toto.io/Statement/v1","predicateType":"https://slsa.dev/provenance/v1",
        "subject":[{"name":release["repository"],"digest":{"sha256":release["candidateSha"]}}],
        "predicate":{"buildDefinition":{"buildType":"https://maghrabi.local/v32/git-release","externalParameters":{"releaseId":release["id"],"candidateRef":release.get("candidateRef")},"resolvedDependencies":[{"uri":path,"digest":{"sha256":digest}} for path,digest in (sbom.get("materials") or {}).items()]},
                     "runDetails":{"builder":{"id":"MAGHRABI-Creator-V32"},"metadata":{"invocationId":release["id"],"startedOn":_now()}},
                     "artifact":artifact.get("latest")},
    }
    signature=_hmac(statement)
    return {"statement":statement,"signature":{"scheme":"MAGHRABI-HMAC-SHA256","value":signature,"valid":True},"slsaInspired":True,"slsaConformant":False,
            "note":"Internal signed provenance; not an externally-issued SLSA attestation."}


def evaluate_gate(scan: dict, release: dict, environment: str) -> dict:
    policy=scan.get("policy") or store.policy(); blockers=[]; warnings=[]
    vuln=scan.get("vulnerabilities") or {}; summary=vuln.get("summary") or {}
    if not vuln.get("available",False): warnings.append("OSV vulnerability service unavailable; vulnerability status is unknown.")
    if policy.get("blockCritical") and int(summary.get("critical",0) or 0)>0: blockers.append(f"{summary.get('critical')} critical vulnerabilities detected.")
    if policy.get("blockHigh") and int(summary.get("high",0) or 0)>0: blockers.append(f"{summary.get('high')} high vulnerabilities detected.")
    if int(summary.get("unknown",0) or 0)>0 and policy.get("warnUnknownVulnerabilitySeverity",True): warnings.append(f"{summary.get('unknown')} vulnerabilities have unknown severity.")
    licenses=scan.get("licenses") or {}
    if (licenses.get("denied") or []): blockers.append(f"{len(licenses.get('denied') or [])} dependencies use denied licenses.")
    if (licenses.get("warned") or []): warnings.append(f"{len(licenses.get('warned') or [])} dependencies use review-required licenses.")
    if (licenses.get("unknown") or []): warnings.append(f"{len(licenses.get('unknown') or [])} dependency licenses are unknown.")
    for warning in (scan.get("sbom") or {}).get("warnings",[])[:20]: warnings.append(str(warning))

    if environment=="production":
        sig=(scan.get("signatures") or {}).get("commit") or {}
        if policy.get("requireVerifiedCommitForProduction") and not sig.get("verified"): blockers.append("Production policy requires a GitHub-verified commit signature.")
        rules=scan.get("rules") or {}; protected=bool((rules.get("protection") or {}).get("protected")) or bool((rules.get("rulesets") or {}).get("count"))
        if policy.get("requireProtectedBranchForProduction") and not protected: blockers.append("Production policy requires branch protection/ruleset evidence.")
        artifact=(scan.get("artifact") or {}).get("latest")
        if policy.get("requireArtifactDigestForProduction") and not artifact: blockers.append("Production policy requires a pinned artifact SHA-256 digest.")
        drift=(scan.get("drift") or {}).get("production") or {}
        if policy.get("requireConfigBaselineForProduction") and not drift.get("baselineAvailable"): blockers.append("Production config baseline is required but missing.")
        if policy.get("blockConfigDriftForProduction") and drift.get("baselineAvailable") and drift.get("status")=="drift": blockers.append("Production configuration drift detected.")

    created=_parse_ts(scan.get("createdAt")); max_age=max(5,int(policy.get("maxScanAgeMinutes",120) or 120))*60
    age=max(0,time.time()-created) if created else None
    if age is None or age>max_age: blockers.append("Supply-chain scan is stale; run a new scan for this candidate SHA.")
    if scan.get("candidateSha")!=release.get("candidateSha"): blockers.append("Scan candidate SHA does not match the current V31 release SHA.")
    return {"ready":not blockers,"environment":environment,"blockers":blockers,"warnings":warnings,"evaluatedAt":_now(),"scanId":scan.get("id"),"candidateSha":release.get("candidateSha")}


def _scan_release(release: dict) -> dict:
    policy=store.policy(); sbom=_build_sbom(release["repository"],release["candidateSha"])
    with ThreadPoolExecutor(max_workers=4) as pool:
        f_v=pool.submit(_osv,sbom); f_l=pool.submit(_licenses,sbom,policy); f_s=pool.submit(_signatures,release); f_r=pool.submit(_rules,release)
        vulnerabilities=f_v.result(); licenses=f_l.result(); signatures=f_s.result(); rules=f_r.result()
    current=_fingerprints(); drift={env:_drift_for(env,current) for env in ("dev","staging","production")}
    artifact=_artifact(release); provenance=_provenance(release,sbom,artifact)
    draft={"id":None,"releaseId":release["id"],"repository":release["repository"],"candidateSha":release["candidateSha"],"createdAt":_now(),
           "sbom":sbom,"vulnerabilities":vulnerabilities,"signatures":signatures,"rules":rules,"drift":drift,"licenses":licenses,"artifact":artifact,"provenance":provenance,"policy":policy}
    # Save with a neutral gate snapshot; target-specific gates are recalculated on every promotion.
    preview=evaluate_gate(draft,release,"staging")
    status="pass" if preview["ready"] else "block"
    return store.create_scan(release_id=release["id"],repository=release["repository"],candidate_sha=release["candidateSha"],status=status,
                             sbom=sbom,vulnerabilities=vulnerabilities,signatures=signatures,rules=rules,drift=drift,licenses=licenses,artifact=artifact,
                             provenance=provenance,policy_value=policy,gate=preview)


def _active_release(release_id: str | None = None) -> dict:
    release=v31.store.get_release(release_id) if release_id else v31.store.active_release()
    if not release: raise HTTPException(status_code=404,detail="لا توجد V31 Release مطلوبة للفحص.")
    return release


def _attestation_actor(request: Request) -> dict:
    supplied=request.headers.get("x-v32-attestation-token","")
    if ATTESTATION_TOKEN and supplied and hmac.compare_digest(supplied,ATTESTATION_TOKEN): return {"id":"ci-attestor","role":"ci"}
    return v24.require_admin_write(request)


def _evidence(scan: dict, release: dict) -> Path:
    path=EVIDENCE_DIR/f"MAGHRABI-V32-supply-chain-{scan['id']}.zip"
    gates={env:evaluate_gate(scan,release,env) for env in ("dev","staging","production")}
    with zipfile.ZipFile(path,"w",compression=zipfile.ZIP_DEFLATED) as z:
        entries={"scan.json":scan,"sbom.cdx.json":scan.get("sbom"),"vulnerabilities.json":scan.get("vulnerabilities"),"licenses.json":scan.get("licenses"),
                 "signatures.json":scan.get("signatures"),"repository-policy.json":scan.get("rules"),"config-drift.json":scan.get("drift"),
                 "artifact.json":scan.get("artifact"),"provenance.intoto.json":scan.get("provenance"),"policy.json":scan.get("policy"),"gates.json":gates}
        for name,value in entries.items(): z.writestr(name,json.dumps(value,ensure_ascii=False,indent=2))
        z.writestr("README.txt",f"MAGHRABI Creator V32 Supply Chain Evidence\nRelease: {release['name']}\nCandidate SHA: {release['candidateSha']}\nScan: {scan['id']}\n\nSBOM covers direct manifests; transitive completeness requires lockfile/artifact tooling. Provenance is internally HMAC-signed and SLSA-inspired, not a formal external SLSA attestation.\n")
    return path


@router.get("/health/live")
async def live_v32() -> dict:
    return {"live":True,"version":"32","database":store.schema_status().get("databaseMode")}


@router.get("/admin/overview")
async def overview_v32(admin: dict = Depends(v24.require_admin)) -> dict:
    release=v31.store.active_release(); scan=store.latest_scan(release["id"],release["candidateSha"]) if release else None
    gates={env:evaluate_gate(scan,release,env) for env in ("dev","staging","production")} if release and scan else None
    return {"version":"32","generatedAt":_now(),"schema":store.schema_status(),"policy":store.policy(),"activeRelease":release,"latestScan":scan,"gates":gates,
            "scans":store.list_scans(30),"baselines":[{k:v for k,v in b.items() if k!="fingerprints"} for b in store.baselines()],
            "artifacts":store.artifacts(release["id"],30) if release else [],"events":store.events(80),
            "capabilities":{"osvUrlConfigured":bool(OSV_URL),"attestationTokenConfigured":bool(ATTESTATION_TOKEN),"githubTokenConfigured":bool(v31.GITHUB_TOKEN),"sbomCoverage":"direct-manifests"}}


@router.post("/admin/scan")
async def run_scan_v32(payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    release=_active_release(str(payload.get("releaseId") or "").strip() or None)
    try: scan=_scan_release(release)
    except HTTPException: raise
    except Exception as exc:
        store.event("scan_failed",release_id=release["id"],actor_id=str(admin.get("id") or "admin"),details={"error":str(exc)[:1000]})
        raise HTTPException(status_code=502,detail=f"Supply-chain scan failed: {str(exc)[:600]}") from exc
    store.event("scan_completed",release_id=release["id"],actor_id=str(admin.get("id") or "admin"),details={"scanId":scan["id"],"status":scan["status"],"sha":release["candidateSha"]})
    return {**scan,"gates":{env:evaluate_gate(scan,release,env) for env in ("dev","staging","production")}}


@router.post("/admin/policy")
async def save_policy_v32(payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    value=store.save_policy(payload); store.event("policy_updated",actor_id=str(admin.get("id") or "admin"),details={"policy":value}); return value


@router.post("/admin/config-baseline")
async def baseline_v32(payload: dict = Body(default={}), admin: dict = Depends(v24.require_admin_write)) -> dict:
    environment=str(payload.get("environment") or "production").lower()
    if environment not in {"dev","staging","production"}: raise HTTPException(status_code=422,detail="Environment غير صالح.")
    current=_fingerprints(); item=store.save_baseline(environment,current["fingerprints"],current["names"])
    store.event("config_baseline_captured",actor_id=str(admin.get("id") or "admin"),details={"environment":environment,"variableCount":len(current["names"])})
    return {k:v for k,v in item.items() if k!="fingerprints"}


@router.post("/attest/artifact")
async def attest_artifact_v32(request: Request, payload: dict = Body(default={})) -> dict:
    actor=_attestation_actor(request); release=_active_release(str(payload.get("releaseId") or "").strip() or None)
    digest=str(payload.get("digestSha256") or "").lower().replace("sha256:","").strip()
    if not re.fullmatch(r"[0-9a-f]{64}",digest): raise HTTPException(status_code=422,detail="digestSha256 يجب أن يكون SHA-256 من 64 خانة hex.")
    environment=str(payload.get("environment") or "production").lower()
    if environment not in {"dev","staging","production"}: raise HTTPException(status_code=422,detail="Environment غير صالح.")
    item=store.register_artifact(release_id=release["id"],environment=environment,name=str(payload.get("name") or "deployment-artifact")[:180],digest_sha256=digest,
                                 size_bytes=int(payload["sizeBytes"]) if payload.get("sizeBytes") is not None else None,source=str(payload.get("source") or actor.get("id") or "manual")[:120],metadata=payload.get("metadata") if isinstance(payload.get("metadata"),dict) else {})
    store.event("artifact_attested",release_id=release["id"],actor_id=str(actor.get("id") or "unknown"),details={"artifactId":item["id"],"digest":digest,"environment":environment})
    return item


@router.get("/admin/scans/{scan_id}/evidence")
async def evidence_v32(scan_id: str, admin: dict = Depends(v24.require_admin)) -> FileResponse:
    scan=store.get_scan(scan_id)
    if not scan: raise HTTPException(status_code=404,detail="Scan غير موجود.")
    release=v31.store.get_release(scan["releaseId"])
    if not release: raise HTTPException(status_code=404,detail="V31 Release المرتبطة غير موجودة.")
    path=_evidence(scan,release); return FileResponse(path,media_type="application/zip",filename=path.name)


@router.get("/release/ready")
async def ready_v32() -> JSONResponse:
    release=v31.store.active_release()
    if not release: return JSONResponse({"ready":True,"state":"no-active-v31-release","version":"32"})
    scan=store.latest_scan(release["id"],release["candidateSha"])
    if not scan: return JSONResponse({"ready":False,"state":"scan-required","releaseId":release["id"],"version":"32"},status_code=503)
    gate=evaluate_gate(scan,release,"production")
    return JSONResponse({"ready":gate["ready"],"gate":gate,"scanId":scan["id"],"version":"32"},status_code=200 if gate["ready"] else 503)
