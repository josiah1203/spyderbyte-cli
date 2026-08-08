from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "src/spyderbyte_cli"
MAIN = PACKAGE / "__main__.py"
CLI = PACKAGE / "cli.py"

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

FORBIDDEN_SOURCE_TOKENS = (
    "KimiCLI",
    "login_kimi_code",
    "OAuthManager",
    "check_update_gate",
    "do_update",
    "KIMI_DISABLE_TELEMETRY",
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


def test_spyderbyte_has_no_kimi_product_authority_imports() -> None:
    violations: list[str] = []
    for path in sorted(PACKAGE.rglob("*.py")):
        for module in imports(path):
            if module.startswith(FORBIDDEN_PRODUCT_IMPORTS):
                violations.append(f"{path.relative_to(ROOT)} -> {module}")
    assert violations == []


def test_kimi_imports_are_limited_to_approved_adapter_or_ui_mechanics() -> None:
    violations: list[str] = []
    for path in sorted(PACKAGE.rglob("*.py")):
        relative = path.relative_to(PACKAGE).as_posix()
        for module in imports(path):
            if not module.startswith("kimi_cli"):
                continue
            allowed = relative.startswith("adapters/kimi/") or module.startswith("kimi_cli.ui")
            if module.startswith(("kimi_cli.ui.shell.update", "kimi_cli.ui.shell.usage")):
                allowed = False
            if not allowed:
                violations.append(f"{path.relative_to(ROOT)} -> {module}")
    assert violations == []


def test_spyderbyte_entry_does_not_compose_kimi_cli() -> None:
    for path in (MAIN, CLI):
        source = path.read_text(encoding="utf-8")
        for token in FORBIDDEN_SOURCE_TOKENS:
            assert token not in source, f"{path.relative_to(ROOT)} contains {token}"
        assert "from spyderbyte_cli.cli import app" in MAIN.read_text(encoding="utf-8")
        assert "KimiCLI.create" not in source


def test_shell_renderer_does_not_depend_on_kimi_console() -> None:
    shell = (PACKAGE / "shell.py").read_text(encoding="utf-8")
    assert "kimi_cli" not in shell
    assert "from rich.console import Console" in shell
