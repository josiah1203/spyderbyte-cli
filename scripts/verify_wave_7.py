#!/usr/bin/env python3
"""Verify local Wave 7 scaffolding and report blocked hosted/release gates."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GATES = ROOT / "docs/spyderbyte-integration/RELEASE_GATES.md"

BLOCKED = (
    "H3 hosted control-plane deployment",
    "H4 managed inference/compute reconciliation",
    "H5 pricing/entitlements/billing",
    "H6 SSO/SCIM/CMK/residency/government evidence",
    "P5 signed/notarized publication",
    "P6 update channels/rollback/DR",
    "Q8 hosted SLO/security scan evidence",
    "U6 package namespace rename",
    "P4 full sidecar packaging targets",
)


def main() -> None:
    if not GATES.is_file():
        raise SystemExit(f"missing release gate checklist: {GATES}")

    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(ROOT / "src")
    help_result = subprocess.run(
        [sys.executable, "-m", "spyderbyte_cli", "--help"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
        env=environment,
    )
    if help_result.returncode != 0:
        raise SystemExit(f"spyderbyte --help failed: {help_result.stderr}")
    if "Spyderbyte" not in help_result.stdout:
        raise SystemExit("Spyderbyte help missing branding")

    daemon_help = subprocess.run(
        [sys.executable, "-m", "spyderbyte_cli", "daemon", "--help"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
        env=environment,
    )
    if daemon_help.returncode != 0:
        raise SystemExit(f"spyderbyte daemon --help failed: {daemon_help.stderr}")

    checklist = GATES.read_text(encoding="utf-8")
    for gate in BLOCKED:
        # Ensure the checklist still names every blocked hosted/commercial gate.
        token = gate.split(" ", 1)[0]
        if token not in checklist:
            raise SystemExit(f"release checklist missing blocked gate token {token}")

    print("Wave 7 local scaffolding verification passed.")
    print("Blocked hosted/commercial/signing gates (Section 13):")
    for gate in BLOCKED:
        print(f"  - {gate}")
    print(
        "Wave 7 remains Blocked for hosted/credentialed/signed completion; "
        "see docs/spyderbyte-integration/RELEASE_GATES.md"
    )


if __name__ == "__main__":
    main()
