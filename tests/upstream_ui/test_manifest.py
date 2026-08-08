from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = Path(__file__).with_name("manifest.json")


def test_selected_upstream_ui_regression_files_are_unchanged() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    mismatches: list[str] = []
    for record in manifest["tests"]:
        path = ROOT / record["path"]
        actual = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else "missing"
        if actual != record["sha256"]:
            mismatches.append(f"{record['path']}: expected {record['sha256']}, got {actual}")
    assert mismatches == []
