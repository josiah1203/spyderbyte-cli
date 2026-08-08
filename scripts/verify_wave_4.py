#!/usr/bin/env python3
"""Verify the native computational-resource matrix through the real local daemon."""

from __future__ import annotations

import asyncio
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from spyderbyte_cli.frontend.client import HttpFrontendClient  # noqa: E402
from spyderbyte_cli.frontend.resources import RESOURCE_TYPES  # noqa: E402
from spyderbyte_cli.frontend.transport import FrontendTransport  # noqa: E402


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


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


async def verify_client(base_url: str) -> tuple[str, int, str]:
    transport = FrontendTransport(base_url, interface="cli")
    client = HttpFrontendClient(transport)
    try:
        session = await client.open_session()
        assert set(RESOURCE_TYPES) <= set(session.capabilities.native_resources)

        discovered = {}
        for resource_type in RESOURCE_TYPES:
            result = await client.resources.discover(resource_type)
            assert result.resource_type == resource_type
            assert result.operation == "discover"
            assert result.capabilities[0].resource_type == resource_type
            assert result.capabilities[0].operations
            discovered[resource_type] = result

        visualization_catalog = await client.resources.inspect("visualization")
        assert visualization_catalog.operation == "inspect"
        assert visualization_catalog.data.get("resourceType") == "visualization"
        return session.project_id, len(discovered), str(visualization_catalog.state)
    finally:
        await transport.close()


def main() -> None:
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryDirectory(prefix="spyderbyte-wave-4-") as temporary:
        workspace = Path(temporary) / "workspace"
        log_path = Path(temporary) / "daemon.log"
        environment = os.environ.copy()
        environment.update(
            {
                "AGENTIC_LOCAL_API_PORT": str(port),
                "AGENTIC_WORKSPACE": str(workspace),
                "AGENTIC_WORKSPACE_NAME": "Wave 4 verification workspace",
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
            project_id, discovered_count, visualization_state = asyncio.run(verify_client(base_url))
            print(
                "Wave 4 native-resource verification passed: "
                f"project={project_id} discovered={discovered_count} "
                f"visualization={visualization_state}"
            )
        finally:
            stop_daemon(process)


if __name__ == "__main__":
    main()
