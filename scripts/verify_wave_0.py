#!/usr/bin/env python3
"""Verify the immutable inputs and exhaustive Kimi classification for Wave 0."""

from __future__ import annotations

import fnmatch
import hashlib
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
INTEGRATION = ROOT / "integration"


def load_json(name: str) -> dict[str, Any]:
    return json.loads((INTEGRATION / name).read_text(encoding="utf-8"))


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", *args], cwd=ROOT)


def fail(message: str) -> None:
    print(f"wave-0 verification failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def verify_baseline(name: str, baseline: dict[str, Any]) -> None:
    commit = baseline["commit"]
    try:
        git("cat-file", "-e", f"{commit}^{{commit}}")
    except subprocess.CalledProcessError:
        fail(f"{name} commit is unavailable: {commit}")

    try:
        tagged_commit = git("rev-list", "-n", "1", baseline["tag"]).decode().strip()
    except subprocess.CalledProcessError:
        fail(f"{name} source tag is unavailable: {baseline['tag']}")
    if tagged_commit != commit:
        fail(f"{name} source tag resolves to {tagged_commit}, expected {commit}")

    for path, expected in baseline.get("files", {}).items():
        try:
            content = git("show", f"{commit}:{path}")
        except subprocess.CalledProcessError:
            fail(f"{name} baseline file is unavailable: {commit}:{path}")
        actual = f"sha256:{hashlib.sha256(content).hexdigest()}"
        if actual != expected:
            fail(f"{name} hash mismatch for {path}: expected {expected}, got {actual}")

    tracked_files = int(git("ls-tree", "-r", "--name-only", commit).count(b"\n"))
    if tracked_files != baseline["trackedFiles"]:
        fail(
            f"{name} tracked-file mismatch: expected {baseline['trackedFiles']}, "
            f"got {tracked_files}"
        )


def verify_classification(kimi_commit: str) -> None:
    policy = load_json("kimi-module-classification.json")
    rules = policy["classificationOrder"]
    files = git("ls-tree", "-r", "--name-only", kimi_commit, "--", policy["sourceRoot"])
    paths = files.decode().splitlines()
    unmatched: list[str] = []
    counts: Counter[str] = Counter()

    for path in paths:
        selected = next(
            (
                rule
                for rule in rules
                if any(fnmatch.fnmatchcase(path, pattern) for pattern in rule["patterns"])
            ),
            None,
        )
        if selected is None:
            unmatched.append(path)
        else:
            counts[selected["disposition"]] += 1

    if unmatched:
        fail("unclassified Kimi paths:\n  " + "\n  ".join(unmatched))

    required = {"preserve", "adapt", "replace", "remove", "defer"}
    missing = sorted(required - counts.keys())
    if missing:
        fail(f"classification has no paths for dispositions: {', '.join(missing)}")

    print(f"classified {len(paths)} Kimi source paths: {dict(sorted(counts.items()))}")


def verify_candidate_decisions() -> None:
    decisions = load_json("runtime-candidate-decisions.json")["candidates"]
    required = {"candidate", "source", "decision", "targetPort", "gate"}
    for index, decision in enumerate(decisions):
        missing = required - decision.keys()
        if missing:
            fail(f"candidate {index} is missing fields: {', '.join(sorted(missing))}")
        if not decision["gate"]:
            fail(f"candidate {decision['candidate']} has no adoption gate")
    print(f"validated {len(decisions)} runtime candidate decisions")


def main() -> None:
    manifest = load_json("source-baselines.json")
    baselines = manifest["baselines"]
    verify_baseline("Kimi CLI", baselines["kimiCli"])
    verify_baseline("Spyderbyte platform", baselines["spyderbytePlatform"])
    verify_classification(baselines["kimiCli"]["commit"])
    verify_candidate_decisions()
    print("Wave 0 provenance and classification verification passed.")


if __name__ == "__main__":
    main()
