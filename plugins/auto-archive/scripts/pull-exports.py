#!/usr/bin/env python3
"""Pull verified BB Auto Archive thread exports to an external archive volume.

Workflow (fail-closed):
1. Verify destination directory exists, is writable, and (if configured) sits on a
   mounted external volume / contains a sentinel file.
2. Sync completed `.jsonl.gz` and `.jsonl.gz.sha256` bundles from `--source`
   (either a local path or `user@host:/remote/export/dir`), ignoring `*.tmp*`.
3. Independently verify EVERY `.jsonl.gz` on `--dest-dir`:
   - matching `.jsonl.gz.sha256` checksum
   - valid gzip stream whose first line is JSON with format `oxi-bb-thread-export/v1`
4. Only when `--delete-remote` is passed (and NOT `--dry-run`), remove ONLY the
   verified `.jsonl.gz` and `.jsonl.gz.sha256` files from the source outbox.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

EXPORT_FORMAT = "oxi-bb-thread-export/v1"
SHA256_LINE_RE = re.compile(r"^([a-f0-9]{64})  ([^/\r\n]+)$")
SAFE_REL_RE = re.compile(r"^[0-9]{4}-[0-9]{2}/thr_[a-zA-Z0-9_-]+\.jsonl\.gz(?:\.sha256)?$")


def parse_remote_spec(source: str) -> tuple[str | None, str]:
    """Split `host:/path` into `(host, path)` or `(None, local_path)`."""
    if ":" in source and not source.startswith("/") and not source.startswith("."):
        host, remote_path = source.split(":", 1)
        if not host or not remote_path.startswith("/"):
            raise ValueError(f"Invalid remote source spec: {source!r}")
        return host, remote_path.rstrip("/")
    return None, os.path.abspath(source).rstrip("/")


def check_destination_mounted(
    dest_dir: Path,
    require_mount_root: str | None,
    require_sentinel: str | None,
) -> None:
    if require_mount_root:
        mount_path = Path(require_mount_root)
        if not mount_path.exists() or not os.path.ismount(mount_path):
            raise RuntimeError(f"Required external volume is not mounted: {mount_path}")
    if not dest_dir.exists() or not dest_dir.is_dir():
        raise RuntimeError(f"Destination directory does not exist: {dest_dir}")
    if not os.access(dest_dir, os.W_OK):
        raise RuntimeError(f"Destination directory is not writable: {dest_dir}")
    if require_sentinel:
        sentinel_path = (dest_dir / require_sentinel).resolve()
        if not sentinel_path.is_file():
            raise RuntimeError(f"Required sentinel file is missing: {sentinel_path}")


def run_rsync(
    source: str,
    dest_dir: Path,
    *,
    dry_run: bool,
    ssh_cmd: str | None,
    timeout_sec: int,
) -> None:
    src = source.rstrip("/") + "/"
    dst = str(dest_dir).rstrip("/") + "/"
    cmd = [
        "rsync",
        "-a",
        "--exclude=*.tmp*",
        "--include=*/",
        "--include=*.jsonl.gz",
        "--include=*.jsonl.gz.sha256",
        "--exclude=*",
    ]
    if dry_run:
        cmd.append("--dry-run")
    if ssh_cmd:
        cmd.extend(["-e", ssh_cmd])
    cmd.extend([src, dst])
    res = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout_sec,
        check=False,
    )
    if res.returncode != 0:
        raise RuntimeError(f"rsync failed (exit {res.returncode}): {res.stderr.strip()}")


def verify_archive_pair(dest_dir: Path, archive_path: Path) -> tuple[bool, str]:
    rel = archive_path.relative_to(dest_dir).as_posix()
    if not SAFE_REL_RE.match(rel):
        return False, f"unexpected relative path: {rel}"
    checksum_path = archive_path.with_name(archive_path.name + ".sha256")
    if not checksum_path.is_file():
        return False, "missing .sha256 file"
    try:
        line = checksum_path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        return False, f"cannot read .sha256: {exc}"
    m = SHA256_LINE_RE.match(line)
    if not m:
        return False, "malformed .sha256 line"
    expected_sha, expected_name = m.group(1), m.group(2)
    if expected_name != archive_path.name:
        return False, f"checksum filename mismatch ({expected_name} != {archive_path.name})"

    digest = hashlib.sha256()
    try:
        with archive_path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        return False, f"cannot read archive: {exc}"
    if digest.hexdigest() != expected_sha:
        return False, "sha256 mismatch"

    try:
        with gzip.open(archive_path, "rt", encoding="utf-8") as gz:
            first_line = gz.readline()
            if not first_line:
                return False, "empty archive"
            header = json.loads(first_line)
            if header.get("format") != EXPORT_FORMAT:
                return False, f"unexpected export format: {header.get('format')!r}"
            event_count = header.get("eventCount")
            if not isinstance(event_count, int) or event_count < 0:
                return False, "invalid header eventCount"
            seen = 0
            for raw_line in gz:
                if raw_line.strip():
                    seen += 1
            if seen != event_count:
                return False, f"event count mismatch ({seen} != {event_count})"
    except (OSError, EOFError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        return False, f"gzip/json verification failed: {exc}"

    return True, "ok"


def delete_verified_from_source(
    source: str,
    verified_rel_archives: list[str],
    *,
    ssh_cmd: str | None,
    timeout_sec: int,
) -> int:
    if not verified_rel_archives:
        return 0
    rel_files: list[str] = []
    for rel in verified_rel_archives:
        sha_rel = rel + ".sha256"
        if not SAFE_REL_RE.match(rel) or not SAFE_REL_RE.match(sha_rel):
            raise ValueError(f"Refusing unsafe relative path: {rel!r}")
        rel_files.append(rel)
        rel_files.append(sha_rel)

    host, root_path = parse_remote_spec(source)
    if host is None:
        base = Path(root_path).resolve()
        removed = 0
        for rel in rel_files:
            target = (base / rel).resolve()
            if not str(target).startswith(str(base) + os.sep):
                raise ValueError(f"Path escape refused: {target}")
            if target.is_file() or target.is_symlink():
                target.unlink()
                removed += 1
        return removed

    # Remote deletion: pass root + NUL-delimited safe relative paths over stdin to python3
    # on the remote host — zero shell interpolation, strict containment check.
    remote_script = (
        "import os, pathlib, sys; "
        "base = pathlib.Path(sys.argv[1]).resolve(); "
        "raw = sys.stdin.buffer.read().split(b'\\0'); "
        "removed = 0\n"
        "for item in raw:\n"
        "  if not item: continue\n"
        "  rel = item.decode('utf-8')\n"
        "  target = (base / rel).resolve()\n"
        "  if not str(target).startswith(str(base) + os.sep): raise SystemExit(2)\n"
        "  if target.is_file():\n"
        "    target.unlink()\n"
        "    removed += 1\n"
        "print(removed)\n"
    )
    ssh_parts = ssh_cmd.split() if ssh_cmd else ["ssh"]
    cmd = [*ssh_parts, host, "python3", "-c", remote_script, root_path]
    payload = b"\0".join(p.encode("utf-8") for p in rel_files)
    res = subprocess.run(
        cmd,
        input=payload,
        capture_output=True,
        timeout=timeout_sec,
        check=False,
    )
    if res.returncode != 0:
        raise RuntimeError(
            f"remote delete failed (exit {res.returncode}): {res.stderr.decode('utf-8', 'replace').strip()}"
        )
    return int(res.stdout.decode("utf-8").strip() or "0")


def list_source_archives(
    source: str,
    *,
    ssh_cmd: str | None,
    timeout_sec: int,
) -> list[str]:
    """List `.jsonl.gz` relative paths currently present in the source outbox."""
    src = source.rstrip("/") + "/"
    cmd = [
        "rsync",
        "-r",
        "--list-only",
        "--exclude=*.tmp*",
        "--include=*/",
        "--include=*.jsonl.gz",
        "--exclude=*",
    ]
    if ssh_cmd:
        cmd.extend(["-e", ssh_cmd])
    cmd.append(src)
    res = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout_sec,
        check=False,
    )
    if res.returncode != 0:
        raise RuntimeError(
            f"rsync --list-only failed (exit {res.returncode}): {res.stderr.strip()}"
        )
    rel_paths: list[str] = []
    for line in res.stdout.splitlines():
        # rsync --list-only format: `<perms> <size> <YYYY/MM/DD> <HH:MM:SS> <relpath>`
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        perms, rel = parts[0], parts[4]
        if perms.startswith("-") and rel.endswith(".jsonl.gz"):
            rel_paths.append(rel)
    return sorted(set(rel_paths))


def pull_and_verify(
    *,
    source: str,
    dest_dir: Path,
    require_mount_root: str | None = None,
    require_sentinel: str | None = None,
    delete_remote: bool = False,
    dry_run: bool = False,
    verify_all: bool = False,
    ssh_cmd: str | None = None,
    timeout_sec: int = 300,
) -> dict[str, object]:
    check_destination_mounted(dest_dir, require_mount_root, require_sentinel)
    source_archives = list_source_archives(
        source,
        ssh_cmd=ssh_cmd,
        timeout_sec=timeout_sec,
    )
    if source_archives:
        run_rsync(
            source,
            dest_dir,
            dry_run=dry_run,
            ssh_cmd=ssh_cmd,
            timeout_sec=timeout_sec,
        )

    if verify_all:
        targets = [
            p.relative_to(dest_dir).as_posix()
            for p in sorted(dest_dir.rglob("*.jsonl.gz"))
            if p.is_file()
        ]
    else:
        targets = source_archives

    verified_all: list[str] = []
    failed: dict[str, str] = {}
    for rel in targets:
        archive_path = dest_dir / rel
        if not archive_path.is_file():
            if dry_run:
                continue
            failed[rel] = "missing on destination after rsync"
            continue
        ok, reason = verify_archive_pair(dest_dir, archive_path)
        if ok:
            verified_all.append(rel)
        else:
            failed[rel] = reason

    source_set = set(source_archives)
    verified_for_delete = [rel for rel in verified_all if rel in source_set]
    deleted_remote_files = 0
    if delete_remote and not dry_run and verified_for_delete:
        deleted_remote_files = delete_verified_from_source(
            source,
            verified_for_delete,
            ssh_cmd=ssh_cmd,
            timeout_sec=timeout_sec,
        )

    return {
        "dryRun": dry_run,
        "sourceArchiveCount": len(source_archives),
        "verifiedCount": len(verified_all),
        "failedVerification": failed,
        "deletedSourceFiles": deleted_remote_files,
        "deleteRemoteRequested": delete_remote,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Pull and SHA-256-verify BB Auto Archive thread exports to an external drive.",
    )
    parser.add_argument(
        "--source",
        required=True,
        help="Source outbox (local directory or SSH spec like user@server:/path/to/exports)",
    )
    parser.add_argument(
        "--dest-dir",
        required=True,
        help="Destination archive directory on the external drive",
    )
    parser.add_argument(
        "--require-mount-root",
        default=None,
        help="Require this volume path to be an active mount point (e.g. /Volumes/ArchiveDisk)",
    )
    parser.add_argument(
        "--require-sentinel",
        default=None,
        help="Require this sentinel file to exist inside --dest-dir before syncing",
    )
    parser.add_argument(
        "--delete-remote",
        action="store_true",
        help="Delete source .jsonl.gz + .sha256 files ONLY after local verification passes",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview rsync and verify existing local copies without deleting source files",
    )
    parser.add_argument(
        "--verify-all",
        action="store_true",
        help="Verify every archive on --dest-dir instead of only archives pending on --source",
    )
    parser.add_argument(
        "--ssh-cmd",
        default=None,
        help="Optional custom SSH command for rsync and remote cleanup",
    )
    parser.add_argument(
        "--timeout-sec",
        type=int,
        default=300,
        help="Timeout in seconds for rsync and remote cleanup (default: 300)",
    )
    args = parser.parse_args(argv)

    try:
        report = pull_and_verify(
            source=args.source,
            dest_dir=Path(args.dest_dir),
            require_mount_root=args.require_mount_root,
            require_sentinel=args.require_sentinel,
            delete_remote=args.delete_remote,
            dry_run=args.dry_run,
            verify_all=args.verify_all,
            ssh_cmd=args.ssh_cmd,
            timeout_sec=args.timeout_sec,
        )
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}, indent=2), file=sys.stderr)
        return 1

    failed = report["failedVerification"]
    print(json.dumps({"ok": not failed, **report}, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
