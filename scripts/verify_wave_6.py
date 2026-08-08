#!/usr/bin/env python3
"""Verify Spyderbyte production paths do not invoke Kimi product authority."""

from __future__ import annotations

import ast
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "src/spyderbyte_cli"

FORBIDDEN_PRODUCT_IMPORTS = (
    "kimi_cli.app",
    "kimi_cli.auth",
    "kimi_cli.background",
    "kimi_cli.config",
    "kimi_cli.llm",
    "kimi_cli.session",
    "kimi_cli.soul",
    "kimi_cli.telemetry",
    "kimi_cli.tools",
    "kimi_cli.ui.shell.update",
    "kimi_cli.ui.shell.usage",
)

FORBIDDEN_TOKENS = (
    "KimiCLI",
    "login_kimi_code",
    "OAuthManager",
    "check_update_gate",
    "do_update",
    "moonshot.cn",
)


def imports(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    result: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            result.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            result.append(node.module)
    return result


def scan_imports() -> list[str]:
    violations: list[str] = []
    for path in sorted(PACKAGE.rglob("*.py")):
        relative = path.relative_to(ROOT).as_posix()
        package_relative = path.relative_to(PACKAGE).as_posix()
        for module in imports(path):
            if module.startswith(FORBIDDEN_PRODUCT_IMPORTS):
                violations.append(f"{relative} imports {module}")
            if module.startswith("kimi_cli") and not (
                package_relative.startswith("adapters/kimi/") or module.startswith("kimi_cli.ui")
            ):
                violations.append(f"{relative} imports unapproved {module}")
            if module.startswith(("kimi_cli.ui.shell.update", "kimi_cli.ui.shell.usage")):
                violations.append(f"{relative} imports product UI authority {module}")
    return violations


def scan_tokens() -> list[str]:
    violations: list[str] = []
    for path in (PACKAGE / "__main__.py", PACKAGE / "cli.py", PACKAGE / "shell.py"):
        source = path.read_text(encoding="utf-8")
        for token in FORBIDDEN_TOKENS:
            if token in source:
                violations.append(f"{path.relative_to(ROOT)} contains {token}")
    return violations


def main() -> None:
    violations = scan_imports() + scan_tokens()
    if violations:
        print("Wave 6 authority verification failed:")
        for item in violations:
            print(f"  - {item}")
        raise SystemExit(1)

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
    stdout = help_result.stdout
    if "Kimi account" in stdout or "moonshot" in stdout.lower():
        raise SystemExit("Spyderbyte help still advertises Kimi account flows")
    if "Spyderbyte" not in stdout:
        raise SystemExit("Spyderbyte help is missing Spyderbyte branding")

    print(
        "Wave 6 authority verification passed: "
        "no Kimi product-authority imports/tokens on Spyderbyte path; help is Spyderbyte-branded"
    )


if __name__ == "__main__":
    main()
