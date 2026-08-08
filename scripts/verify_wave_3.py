#!/usr/bin/env python3
"""Verify the local Spyderbyte golden path through the real daemon and Python frontend client."""

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


async def verify_client(base_url: str) -> tuple[str, str, str, int]:
    transport = FrontendTransport(base_url, interface="cli")
    client = HttpFrontendClient(
        transport,
        project_name="Wave 3 verification project",
        project_objective="Verify the local AgentSession and Run golden path.",
    )
    try:
        session = await client.open_session()
        assert session.mode == "local"
        assert session.project_id
        assert session.agent_session_id
        assert {
            "dataset",
            "sql",
            "notebook",
            "experiment",
            "model",
            "visualization",
            "pipeline",
            "automation",
        } <= set(session.capabilities.native_resources)

        initial_conversation = await client.read_conversation()
        assert initial_conversation.project_id == session.project_id
        assert initial_conversation.session is not None
        provider_catalog = await client.read_provider_catalog()
        model_catalog = await client.read_model_catalog()
        runtime_catalog = await client.read_runtime_catalog()
        assert any(item.get("providerId") == "deterministic" for item in provider_catalog.providers)
        assert any(item.get("modelId") == "fixture-model" for item in model_catalog.models)
        assert isinstance(runtime_catalog.profiles, tuple)

        acceptance = await client.send_prompt("Verify the Wave 3 local golden path.")
        events = []
        async for event in client.events(after_cursor=0):
            if event.run_id != acceptance.run_id:
                continue
            events.append(event)
            if event.kind == "stream.end":
                break

        resume_cursor = events[-2].cursor
        resumed = []
        async for event in client.events(after_cursor=resume_cursor, max_reconnects=0):
            if event.run_id != acceptance.run_id:
                continue
            resumed.append(event)
            if event.kind == "stream.end":
                break

        snapshot = await client.read_agent_session()
        detail = await client.read_run(acceptance.run_id)
        conversation = await client.read_conversation()
        assert snapshot.session.session_id == session.agent_session_id
        assert any(event.kind == "assistant.delta" for event in events)
        assert events[-1].kind == "stream.end"
        assert resumed and resumed[-1].kind == "stream.end"
        assert resumed[0].cursor > resume_cursor
        assert detail.run.run_id == acceptance.run_id
        assert detail.run.state == "succeeded"
        assert detail.attempts
        assert detail.logs
        assert any(
            run.run_id == acceptance.run_id for run in await client.list_runs(session.project_id)
        )
        assert conversation.run_id == acceptance.run_id
        assert conversation.latest_response is not None
        return session.project_id, session.agent_session_id, acceptance.run_id, len(events)
    finally:
        await transport.close()


def main() -> None:
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryDirectory(prefix="spyderbyte-wave-3-") as temporary:
        workspace = Path(temporary) / "workspace"
        log_path = Path(temporary) / "daemon.log"
        environment = os.environ.copy()
        environment.update(
            {
                "AGENTIC_LOCAL_API_PORT": str(port),
                "AGENTIC_WORKSPACE": str(workspace),
                "AGENTIC_WORKSPACE_NAME": "Wave 3 verification workspace",
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
            project_id, agent_session_id, run_id, event_count = asyncio.run(verify_client(base_url))
            print(
                "Wave 3 local golden-path verification passed: "
                f"project={project_id} agentSession={agent_session_id} "
                f"run={run_id} events={event_count}"
            )
        finally:
            stop_daemon(process)


if __name__ == "__main__":
    main()
