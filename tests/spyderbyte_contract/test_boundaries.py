from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
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


def test_spyderbyte_frontend_has_no_kimi_product_authority_imports() -> None:
    violations: list[str] = []
    for path in sorted(PACKAGE.rglob("*.py")):
        for module in imports(path):
            if module.startswith(FORBIDDEN_PRODUCT_IMPORTS):
                violations.append(f"{path.relative_to(ROOT)} -> {module}")
    assert violations == []


def test_kimi_imports_are_limited_to_ui_or_transitional_adapter_boundary() -> None:
    violations: list[str] = []
    for path in sorted(PACKAGE.rglob("*.py")):
        relative = path.relative_to(PACKAGE).as_posix()
        for module in imports(path):
            if not module.startswith("kimi_cli"):
                continue
            allowed = module.startswith("kimi_cli.ui") or relative.startswith("adapters/kimi/")
            if not allowed:
                violations.append(f"{path.relative_to(ROOT)} -> {module}")
    assert violations == []
