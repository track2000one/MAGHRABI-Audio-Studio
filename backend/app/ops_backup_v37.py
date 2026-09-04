from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Iterable

SCHEMA = "maghrabi-control-plane-backup/v1"
DEFAULT_EXCLUDED_TOP_LEVEL = {
    ".cache",
    "jobs",
    "tools",
    "video",
    "tmp",
    "temp",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_relative(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if path.is_absolute() or not value or ".." in path.parts:
        raise ValueError(f"Unsafe backup path: {value!r}")
    return path


def _iter_control_plane_files(
    data_dir: Path,
    excluded_top_level: Iterable[str] = DEFAULT_EXCLUDED_TOP_LEVEL,
) -> list[Path]:
    root = data_dir.resolve()
    excluded = set(excluded_top_level)
    files: list[Path] = []
    if not root.exists():
        return files
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(root)
        if relative.parts and relative.parts[0] in excluded:
            continue
        files.append(path)
    files.sort(key=lambda item: item.relative_to(root).as_posix())
    return files


def create_backup(
    data_dir: Path,
    output_path: Path,
    *,
    excluded_top_level: Iterable[str] = DEFAULT_EXCLUDED_TOP_LEVEL,
) -> dict:
    root = data_dir.resolve()
    output = output_path.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    files = _iter_control_plane_files(root, excluded_top_level)
    manifest_files: list[dict] = []
    for path in files:
        relative = path.relative_to(root).as_posix()
        manifest_files.append(
            {
                "path": relative,
                "size": path.stat().st_size,
                "sha256": _sha256_file(path),
            }
        )
    manifest = {
        "schema": SCHEMA,
        "createdAt": _now(),
        "source": str(root),
        "fileCount": len(manifest_files),
        "excludedTopLevel": sorted(set(excluded_top_level)),
        "files": manifest_files,
    }
    payload = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")
    with tarfile.open(output, "w:gz", format=tarfile.PAX_FORMAT) as archive:
        info = tarfile.TarInfo("manifest.json")
        info.size = len(payload)
        info.mtime = 0
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        archive.addfile(info, io.BytesIO(payload))
        for path in files:
            relative = path.relative_to(root).as_posix()
            info = archive.gettarinfo(str(path), arcname=f"data/{relative}")
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            with path.open("rb") as handle:
                archive.addfile(info, handle)
    archive_sha = _sha256_file(output)
    return {**manifest, "archive": str(output), "archiveSha256": archive_sha}


def _load_manifest(archive: tarfile.TarFile) -> dict:
    try:
        member = archive.getmember("manifest.json")
    except KeyError as exc:
        raise ValueError("Backup manifest.json is missing") from exc
    handle = archive.extractfile(member)
    if handle is None:
        raise ValueError("Backup manifest.json cannot be read")
    manifest = json.loads(handle.read().decode("utf-8"))
    if manifest.get("schema") != SCHEMA:
        raise ValueError("Unsupported backup schema")
    if not isinstance(manifest.get("files"), list):
        raise ValueError("Backup manifest files list is invalid")
    return manifest


def verify_backup(backup_path: Path) -> dict:
    backup = backup_path.resolve()
    failures: list[dict] = []
    with tarfile.open(backup, "r:gz") as archive:
        manifest = _load_manifest(archive)
        declared: dict[str, dict] = {}
        for item in manifest["files"]:
            relative = _safe_relative(str(item.get("path") or ""))
            declared[relative.as_posix()] = item
        members = {member.name: member for member in archive.getmembers()}
        for relative, item in declared.items():
            member_name = f"data/{relative}"
            member = members.get(member_name)
            if member is None or not member.isfile():
                failures.append({"path": relative, "reason": "missing"})
                continue
            _safe_relative(member.name)
            handle = archive.extractfile(member)
            if handle is None:
                failures.append({"path": relative, "reason": "unreadable"})
                continue
            digest = hashlib.sha256()
            size = 0
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
                size += len(chunk)
            if size != int(item.get("size") or -1):
                failures.append({"path": relative, "reason": "size", "actual": size})
            if digest.hexdigest() != str(item.get("sha256") or ""):
                failures.append({"path": relative, "reason": "sha256"})
        unexpected = []
        for member in archive.getmembers():
            if member.name == "manifest.json":
                continue
            _safe_relative(member.name)
            if not member.name.startswith("data/"):
                unexpected.append(member.name)
        if unexpected:
            failures.append({"reason": "unexpected_members", "members": unexpected[:25]})
    return {
        "schema": SCHEMA,
        "valid": not failures,
        "archiveSha256": _sha256_file(backup),
        "fileCount": int(manifest.get("fileCount") or 0),
        "failures": failures,
    }


def restore_backup(backup_path: Path, destination: Path, *, overwrite: bool = False) -> dict:
    verification = verify_backup(backup_path)
    if not verification["valid"]:
        raise ValueError(f"Backup verification failed: {verification['failures'][:5]}")
    backup = backup_path.resolve()
    target_root = destination.resolve()
    target_root.mkdir(parents=True, exist_ok=True)
    restored = 0
    with tarfile.open(backup, "r:gz") as archive:
        manifest = _load_manifest(archive)
        for item in manifest["files"]:
            relative = _safe_relative(str(item["path"]))
            target = target_root.joinpath(*relative.parts).resolve()
            if target_root not in target.parents and target != target_root:
                raise ValueError(f"Restore path escaped destination: {relative}")
            if target.exists() and not overwrite:
                raise FileExistsError(f"Restore target already exists: {target}")
            member = archive.getmember(f"data/{relative.as_posix()}")
            handle = archive.extractfile(member)
            if handle is None:
                raise ValueError(f"Cannot read backup member: {relative}")
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as temporary:
                shutil.copyfileobj(handle, temporary)
                temp_path = Path(temporary.name)
            os.replace(temp_path, target)
            restored += 1
    return {
        "schema": SCHEMA,
        "restored": restored,
        "destination": str(target_root),
        "archiveSha256": verification["archiveSha256"],
    }


def _cli() -> int:
    parser = argparse.ArgumentParser(description="MAGHRABI V37 verified backup/restore")
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create")
    create.add_argument("data_dir")
    create.add_argument("output")
    verify = sub.add_parser("verify")
    verify.add_argument("backup")
    restore = sub.add_parser("restore")
    restore.add_argument("backup")
    restore.add_argument("destination")
    restore.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    if args.command == "create":
        result = create_backup(Path(args.data_dir), Path(args.output))
    elif args.command == "verify":
        result = verify_backup(Path(args.backup))
    else:
        result = restore_backup(Path(args.backup), Path(args.destination), overwrite=args.overwrite)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("valid", True) else 2


if __name__ == "__main__":
    raise SystemExit(_cli())
