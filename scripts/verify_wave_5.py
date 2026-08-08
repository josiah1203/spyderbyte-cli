#!/usr/bin/env python3
"""Verify organization and hosted interface parity through the real local daemon."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from spyderbyte_cli.frontend.client import HttpFrontendClient  # noqa: E402
from spyderbyte_cli.frontend.transport import FrontendTransport  # noqa: E402


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def new_sortable_id() -> str:
    timestamp_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    random_a = secrets.randbits(12)
    random_b = secrets.randbits(62)
    value = (timestamp_ms << 80) | (0x7 << 76) | (random_a << 64) | (0b10 << 62) | random_b
    return str(uuid.UUID(int=value))


def create_organization_workspace(root: Path, *, name: str) -> str:
    organization_id = new_sortable_id()
    tenant_id = new_sortable_id()
    workspace_id = new_sortable_id()
    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    metadata = root / ".agentic"
    objects = metadata / "objects"
    objects.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schemaVersion": 1,
        "workspaceId": workspace_id,
        "tenantId": tenant_id,
        "name": name,
        "mode": "organization_local",
        "organizationId": organization_id,
        "createdAt": now,
        "updatedAt": now,
        "databaseFile": "state.sqlite",
        "artifactDirectory": "objects",
    }
    (metadata / "workspace.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return organization_id


def wait_for_daemon(base_url: str, process: subprocess.Popen[str], log_path: Path) -> None:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"local daemon exited with {process.returncode}; inspect {log_path}")
        try:
            with urlopen(f"{base_url}/health", timeout=0.5) as response:
                if response.status == 200:
                    return
        except (OSError, URLError):
            pass
        time.sleep(0.1)
    raise TimeoutError(f"local daemon was not ready within 60 seconds; inspect {log_path}")


def stop_daemon(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        process.terminate()
    else:
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            process.kill()
        else:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=10)


async def verify_client(base_url: str, organization_id: str) -> tuple[str, int, bool, str]:
    transport = FrontendTransport(base_url, interface="cli")
    client = HttpFrontendClient(transport)
    try:
        session = await client.open_session()
        organizations = await client.governance.list_organizations()
        assert any(item.organization_id == organization_id for item in organizations)
        overview = await client.governance.overview(organization_id)
        assert overview.organization_id == organization_id
        members = await client.governance.list_members(organization_id)
        assert members
        await client.governance.put_policy(
            organization_id,
            {
                "version": "governance.v2",
                "scope": {},
                "approvalActions": ["deployment.execute"],
                "allowedDataClasses": ["internal"],
            },
        )
        await client.governance.put_budget(
            organization_id,
            {
                "scope": {},
                "currency": "USD",
                "hardLimitMinor": 100,
                "softLimitMinor": 50,
            },
        )
        evaluation = await client.governance.evaluate(
            organization_id,
            {
                "action": "deployment.execute",
                "target": [{"kind": "deployment", "id": "deployment-wave-5"}],
                "dataClassification": "internal",
                "interfaceName": "cli",
                "estimatedCost": {"amountMinor": 10, "currency": "USD"},
            },
        )
        assert evaluation.input_digest
        committed = await client.governance.commit(
            organization_id,
            {
                "action": "deployment.execute",
                "target": [{"kind": "deployment", "id": "deployment-wave-5"}],
                "dataClassification": "internal",
                "interfaceName": "cli",
                "estimatedCost": {"amountMinor": 10, "currency": "USD"},
                "approvalContext": {
                    "approved": True,
                    "actionDigest": evaluation.input_digest,
                },
                "before": {"token": "redact-me"},
                "after": {"state": "active"},
                "usage": {"category": "compute", "amount": {"amountMinor": 10, "currency": "USD"}},
            },
        )
        assert committed.outcome in {"executed", "unknown"}
        records = await client.governance.audit(organization_id)
        verified = await client.governance.verify_audit(organization_id)
        assert verified.get("valid") is True
        license_status = await client.governance.license_status()
        onboarding = await client.governance.read_onboarding()
        assert onboarding.choices or onboarding.data
        workspace = await client.governance.read_workspace()
        assert workspace.organization_id == organization_id or workspace.mode.startswith(
            "organization"
        )
        # Approvals list may be empty depending on whether evaluate created a durable approval.
        await client.list_approvals()
        return (
            session.project_id,
            len(records),
            bool(verified.get("valid")),
            license_status.status,
        )
    finally:
        await transport.close()


def main() -> None:
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryDirectory(prefix="spyderbyte-wave-5-") as temporary:
        workspace = Path(temporary) / "workspace"
        log_path = Path(temporary) / "daemon.log"
        organization_id = create_organization_workspace(
            workspace, name="Wave 5 verification organization"
        )
        environment = os.environ.copy()
        environment.update(
            {
                "AGENTIC_LOCAL_API_PORT": str(port),
                "AGENTIC_WORKSPACE": str(workspace),
                "AGENTIC_WORKSPACE_NAME": "Wave 5 verification organization",
            }
        )
        with log_path.open("w", encoding="utf-8") as log:
            process = subprocess.Popen(
                [
                    "pnpm",
                    "--dir",
                    str(ROOT / "platform"),
                    "--filter",
                    "@agentic-platform/local-daemon",
                    "local:server",
                ],
                cwd=ROOT,
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=os.name != "nt",
                text=True,
            )
        try:
            wait_for_daemon(base_url, process, log_path)
            project_id, audit_count, valid, license_status = asyncio.run(
                verify_client(base_url, organization_id)
            )
            print(
                "Wave 5 organizational verification passed: "
                f"project={project_id} organization={organization_id} "
                f"audit={audit_count} verified={valid} license={license_status}"
            )
        finally:
            stop_daemon(process)


if __name__ == "__main__":
    main()
