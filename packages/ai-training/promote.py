"""M5 promotion executor — Blockingmachine AI training pipeline.

Installs a gate-approved candidate model into the shipped ai-weights
directory with a full audit trail. The gate advises; this executes;
a human approves (nothing here runs without --confirm).

Layout:
    ai-weights/
      model.json  allowlist.json  manifest.json   <- current release
      versions/v1/ ...                            <- every past release

Every promotion archives the outgoing release and writes a manifest
pinning SHA-256 hashes (DESIGN.md §6). Rollback restores the previous
release the same way — a rollback is just a promotion of the old
weights, so the trail never has gaps.

Usage:
    # dry run: show the plan
    .venv/bin/python promote.py --candidate-dir ./candidate \\
        --weights ~/workspace/blockingmachine/packages/core/ai-weights \\
        --gate-report gate_report.json

    # execute (requires a PASS report whose hashes match the candidate)
    .venv/bin/python promote.py --candidate-dir ./candidate \\
        --weights ... --gate-report gate_report.json --confirm

    # undo the last promotion
    .venv/bin/python promote.py --weights ... --rollback --confirm
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import shutil
import sys
from pathlib import Path


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def read_manifest(weights: Path) -> dict | None:
    p = weights / "manifest.json"
    return json.loads(p.read_text()) if p.exists() else None


def existing_versions(weights: Path) -> list[int]:
    vdir = weights / "versions"
    if not vdir.is_dir():
        return []
    out = []
    for p in vdir.iterdir():
        if p.is_dir() and p.name.startswith("v") and p.name[1:].isdigit():
            out.append(int(p.name[1:]))
    return sorted(out)


def archive_current(weights: Path, version: int) -> None:
    dest = weights / "versions" / f"v{version}"
    dest.mkdir(parents=True, exist_ok=True)
    for name in ("model.json", "allowlist.json", "manifest.json"):
        src = weights / name
        if src.exists():
            shutil.copy2(src, dest / name)
    print(f"archived current release -> versions/v{version}/")


def install(weights: Path, candidate: Path, manifest: dict) -> None:
    shutil.copy2(candidate / "model.json", weights / "model.json")
    shutil.copy2(candidate / "allowlist.json", weights / "allowlist.json")
    (weights / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"installed v{manifest['version']}: model.json "
          f"sha256={manifest['model_sha256'][:12]}...")


def build_manifest(candidate: Path, gate_report: Path, version: int, note: str) -> dict:
    model = json.loads((candidate / "model.json").read_text())
    return {
        "format": "bm-manifest/1",
        "version": version,
        "model_sha256": sha256_file(candidate / "model.json"),
        "allowlist_sha256": sha256_file(candidate / "allowlist.json"),
        "feature_version": model.get("feature_version"),
        "trained_at": model.get("trained_at"),
        "thresholds": model.get("thresholds"),
        "gate_report_sha256": sha256_file(gate_report),
        "promoted_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "note": note,
    }


def cmd_promote(args) -> int:
    weights = Path(args.weights)
    candidate = Path(args.candidate_dir)
    report_path = Path(args.gate_report)

    for name in ("model.json", "allowlist.json"):
        if not (candidate / name).exists():
            raise SystemExit(f"candidate missing {name}")
    report = json.loads(report_path.read_text())
    if report.get("format") != "bm-gate-report/1":
        raise SystemExit("gate report has wrong format")
    if report.get("verdict") != "PASS":
        raise SystemExit(f"refusing: gate verdict is {report.get('verdict')}, not PASS")
    cand_hash = sha256_file(candidate / "model.json")
    if report["candidate"]["model_sha256"] != cand_hash:
        raise SystemExit("refusing: candidate model.json does not match the gate report hash")

    cur = read_manifest(weights)
    cur_version = cur["version"] if cur else 0
    new_version = (max(existing_versions(weights) or [0]) + 1) if cur else 1
    # keep version strictly increasing even if versions/ was cleaned
    new_version = max(new_version, cur_version + 1)
    manifest = build_manifest(candidate, report_path, new_version, "promotion")

    print(f"plan: archive current (v{cur_version}) -> install candidate as v{new_version}")
    if not args.confirm:
        print("dry run — pass --confirm to execute")
        return 0
    if cur:
        archive_current(weights, cur_version)
    install(weights, candidate, manifest)
    print("promotion complete. The TS loader verifies manifest hashes on load (fail closed).")
    return 0


def cmd_rollback(args) -> int:
    weights = Path(args.weights)
    cur = read_manifest(weights)
    if not cur:
        raise SystemExit("no manifest — nothing to roll back")
    prev_versions = [v for v in existing_versions(weights) if v < cur["version"]]
    if not prev_versions:
        raise SystemExit("no previous release archived")
    prev = max(prev_versions)
    prev_dir = weights / "versions" / f"v{prev}"
    new_version = max(existing_versions(weights) + [cur["version"]]) + 1
    manifest = {
        "format": "bm-manifest/1",
        "version": new_version,
        "model_sha256": sha256_file(prev_dir / "model.json"),
        "allowlist_sha256": sha256_file(prev_dir / "allowlist.json"),
        "feature_version": json.loads((prev_dir / "model.json").read_text()).get("feature_version"),
        "trained_at": json.loads((prev_dir / "model.json").read_text()).get("trained_at"),
        "thresholds": json.loads((prev_dir / "model.json").read_text()).get("thresholds"),
        "gate_report_sha256": None,
        "promoted_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "note": f"rollback from v{cur['version']} to v{prev}",
    }
    print(f"plan: archive v{cur['version']} -> restore v{prev} as v{new_version} (rollback)")
    if not args.confirm:
        print("dry run — pass --confirm to execute")
        return 0
    archive_current(weights, cur["version"])
    install(weights, prev_dir, manifest)
    print("rollback complete.")
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weights", required=True, help="shipped ai-weights directory")
    ap.add_argument("--candidate-dir", default=None)
    ap.add_argument("--gate-report", default=None)
    ap.add_argument("--rollback", action="store_true")
    ap.add_argument("--confirm", action="store_true", help="execute (default is dry run)")
    args = ap.parse_args()
    if args.rollback:
        sys.exit(cmd_rollback(args))
    if not args.candidate_dir or not args.gate_report:
        raise SystemExit("need --candidate-dir and --gate-report (or --rollback)")
    sys.exit(cmd_promote(args))


if __name__ == "__main__":
    main()
