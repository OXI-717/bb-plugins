import gzip
import hashlib
import importlib.util
import json
import os
import stat
from pathlib import Path
import tempfile
import unittest

SCRIPT_PATH = Path(__file__).with_name("pull-exports.py")
SPEC = importlib.util.spec_from_file_location("pull_exports", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
pull_exports = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pull_exports)


def make_bundle(root: Path, bucket: str, thread_id: str, events: list[dict], *, corrupt_sha: bool = False) -> tuple[Path, Path]:
    bucket_dir = root / bucket
    bucket_dir.mkdir(parents=True, exist_ok=True)
    archive = bucket_dir / f"{thread_id}.jsonl.gz"
    header = {
        "format": pull_exports.EXPORT_FORMAT,
        "exportedAt": 1_700_000_000_000,
        "thread": {"id": thread_id},
        "eventCount": len(events),
    }
    lines = [json.dumps(header), *(json.dumps(e) for e in events)]
    payload = ("\n".join(lines) + "\n").encode("utf-8")
    archive.write_bytes(gzip.compress(payload))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if corrupt_sha:
        digest = "0" * 64
    checksum = bucket_dir / f"{thread_id}.jsonl.gz.sha256"
    checksum.write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
    return archive, checksum


class PullExportsTests(unittest.TestCase):
    def test_syncs_verifies_and_deletes_only_verified_source_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "src"
            dst = Path(tmp) / "dst"
            src.mkdir()
            dst.mkdir()
            (dst / ".archive-sentinel").write_text("ok\n", encoding="utf-8")

            good_arc, good_sha = make_bundle(
                src, "2026-08", "thr_good_1", [{"seq": 1, "type": "turn/started"}]
            )
            bad_arc, bad_sha = make_bundle(
                src, "2026-08", "thr_bad_1", [{"seq": 1}], corrupt_sha=True
            )
            # In-flight temp file on source must never be synced or deleted.
            tmp_file = src / "2026-08" / "thr_inflight.jsonl.gz.tmp.123.abc"
            tmp_file.write_bytes(b"partial")

            report = pull_exports.pull_and_verify(
                source=str(src),
                dest_dir=dst,
                require_sentinel=".archive-sentinel",
                delete_remote=True,
                dry_run=False,
            )

            self.assertEqual(report["verifiedCount"], 1)
            self.assertEqual(report["deletedSourceFiles"], 2)
            self.assertIn("2026-08/thr_bad_1.jsonl.gz", report["failedVerification"])
            # Verified good pair removed from source, kept on destination.
            self.assertFalse(good_arc.exists())
            self.assertFalse(good_sha.exists())
            self.assertTrue((dst / "2026-08" / "thr_good_1.jsonl.gz").is_file())
            # Corrupt pair NEVER removed from source!
            self.assertTrue(bad_arc.exists())
            self.assertTrue(bad_sha.exists())
            # In-flight .tmp file ignored and untouched on source.
            self.assertTrue(tmp_file.exists())
            self.assertFalse((dst / "2026-08" / tmp_file.name).exists())

    def test_dry_run_never_deletes_source_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "src"
            dst = Path(tmp) / "dst"
            src.mkdir()
            dst.mkdir()
            good_arc, good_sha = make_bundle(src, "2026-08", "thr_dry_1", [])

            report = pull_exports.pull_and_verify(
                source=str(src),
                dest_dir=dst,
                delete_remote=True,
                dry_run=True,
            )

            self.assertTrue(report["dryRun"])
            self.assertEqual(report["deletedSourceFiles"], 0)
            self.assertTrue(good_arc.exists())
            self.assertTrue(good_sha.exists())

    def test_refuses_when_sentinel_or_mount_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "src"
            dst = Path(tmp) / "dst"
            src.mkdir()
            dst.mkdir()

            with self.assertRaisesRegex(RuntimeError, "sentinel"):
                pull_exports.pull_and_verify(
                    source=str(src),
                    dest_dir=dst,
                    require_sentinel=".missing-sentinel",
                )

            with self.assertRaisesRegex(RuntimeError, "not mounted"):
                pull_exports.pull_and_verify(
                    source=str(src),
                    dest_dir=dst,
                    require_mount_root=str(dst),
                )

    def test_rejects_mismatched_event_count_in_gzip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dst = Path(tmp) / "dst"
            bucket = dst / "2026-08"
            bucket.mkdir(parents=True)
            arc = bucket / "thr_trunc.jsonl.gz"
            header = {
                "format": pull_exports.EXPORT_FORMAT,
                "exportedAt": 1_700_000_000_000,
                "thread": {"id": "thr_trunc"},
                "eventCount": 3,
            }
            arc.write_bytes(gzip.compress((json.dumps(header) + "\n").encode("utf-8")))
            sha = hashlib.sha256(arc.read_bytes()).hexdigest()
            (bucket / "thr_trunc.jsonl.gz.sha256").write_text(
                f"{sha}  {arc.name}\n", encoding="utf-8"
            )
            ok, reason = pull_exports.verify_archive_pair(dst, arc)
            self.assertFalse(ok)
            self.assertIn("event count mismatch", reason)

    def test_default_mode_only_verifies_pending_source_archives_unless_verify_all(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "src"
            dst = Path(tmp) / "dst"
            src.mkdir()
            dst.mkdir()
            # Pre-existing historical file on destination with bad checksum
            make_bundle(dst, "2026-01", "thr_old_hist", [], corrupt_sha=True)
            # Only one pending file on source
            make_bundle(src, "2026-08", "thr_new_1", [])

            report = pull_exports.pull_and_verify(
                source=str(src),
                dest_dir=dst,
                delete_remote=True,
            )
            self.assertEqual(report["sourceArchiveCount"], 1)
            self.assertEqual(report["verifiedCount"], 1)
            self.assertEqual(report["failedVerification"], {})
            self.assertEqual(report["deletedSourceFiles"], 2)

            # Full scrub with verify_all=True catches the historical corruption
            scrub = pull_exports.pull_and_verify(
                source=str(src),
                dest_dir=dst,
                verify_all=True,
            )
            self.assertIn("2026-01/thr_old_hist.jsonl.gz", scrub["failedVerification"])


    def test_keeps_source_bundle_republished_after_copy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "src"
            dst = Path(tmp) / "dst"
            src.mkdir()
            dst.mkdir()
            make_bundle(src, "2026-08", "thr_race", [{"seq": 1}])
            make_bundle(dst, "2026-08", "thr_race", [{"seq": 1}])
            rel = "2026-08/thr_race.jsonl.gz"
            ok, _ = pull_exports.verify_archive_pair(dst, dst / rel)
            self.assertTrue(ok)
            verified = {rel: pull_exports.verified_digest(dst / rel)}

            # Retention republishes a newer export after the copy was verified.
            new_arc, new_sha = make_bundle(src, "2026-08", "thr_race", [{"seq": 1}, {"seq": 2}])
            new_bytes = new_arc.read_bytes()

            removed, kept = pull_exports.delete_verified_from_source(
                str(src), verified, ssh_cmd=None, timeout_sec=30
            )
            self.assertEqual((removed, kept), (0, 1))
            self.assertEqual(new_arc.read_bytes(), new_bytes)
            self.assertTrue(new_sha.is_file())
            self.assertEqual(sorted(p.name for p in (src / "2026-08").iterdir()),
                             ["thr_race.jsonl.gz", "thr_race.jsonl.gz.sha256"])

    def test_keeps_checksum_that_names_a_different_digest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "src"
            src.mkdir()
            arc, sha = make_bundle(src, "2026-08", "thr_sum", [])
            digest = hashlib.sha256(arc.read_bytes()).hexdigest()
            sha.write_text(f"{'1' * 64}  {arc.name}\n", encoding="utf-8")

            removed, kept = pull_exports.delete_verified_from_source(
                str(src), {"2026-08/thr_sum.jsonl.gz": digest}, ssh_cmd=None, timeout_sec=30
            )
            self.assertEqual((removed, kept), (1, 0))
            self.assertFalse(arc.exists())
            self.assertTrue(sha.is_file())

    def test_remote_delete_survives_shell_word_splitting(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "src dir"
            src.mkdir()
            arc, sha = make_bundle(src, "2026-08", "thr_remote", [])
            digest = hashlib.sha256(arc.read_bytes()).hexdigest()
            # Fake ssh with OpenSSH semantics: drop the host, join the remaining
            # arguments with spaces and run them through a shell.
            fake_ssh = Path(tmp) / "fake-ssh"
            fake_ssh.write_text('#!/bin/sh\nshift\nexec /bin/sh -c "$*"\n', encoding="utf-8")
            fake_ssh.chmod(fake_ssh.stat().st_mode | stat.S_IXUSR)

            removed, kept = pull_exports.delete_verified_from_source(
                f"archive-host:{src}",
                {"2026-08/thr_remote.jsonl.gz": digest},
                ssh_cmd=str(fake_ssh),
                timeout_sec=30,
            )
            self.assertEqual((removed, kept), (2, 0))
            self.assertFalse(arc.exists())
            self.assertFalse(sha.exists())

if __name__ == "__main__":
    unittest.main()
