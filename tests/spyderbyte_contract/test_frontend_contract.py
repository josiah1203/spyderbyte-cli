from __future__ import annotations

import json
from pathlib import Path

from pydantic import TypeAdapter, ValidationError
from typer.testing import CliRunner

from spyderbyte_cli.cli import app
from spyderbyte_cli.frontend.client import MockFrontendClient
from spyderbyte_cli.frontend.models import FrontendEvent, FrontendSession

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "contracts/frontend/v1/fixtures"


def test_session_fixture_matches_python_contract() -> None:
    session = FrontendSession.model_validate_json((FIXTURES / "session.json").read_text())
    assert session.schema_version == 1
    assert session.agent_session_id == "as_fixture_01"
    assert "experiment" in session.capabilities.native_resources


def test_event_fixture_has_monotonic_cursors() -> None:
    payload = json.loads((FIXTURES / "events.json").read_text())
    events = TypeAdapter(list[FrontendEvent]).validate_python(payload)
    assert [event.cursor for event in events] == [1, 2, 3]


def test_frontend_models_reject_unknown_fields() -> None:
    payload = json.loads((FIXTURES / "session.json").read_text())
    payload["backendAuthority"] = "frontend"
    try:
        FrontendSession.model_validate(payload)
    except ValidationError:
        pass
    else:
        raise AssertionError("unknown frontend contract fields must fail closed")


def test_mock_shell_emits_session_run_and_events() -> None:
    result = CliRunner().invoke(app, ["--mock", "--prompt", "profile this dataset", "--json"])
    assert result.exit_code == 0, result.output
    records = [json.loads(line) for line in result.output.splitlines()]
    assert records[0]["agentSessionId"] == "as_mock_01"
    assert records[1]["runId"] == "run_mock_01"
    assert [record["kind"] for record in records[2:]] == [
        "turn.accepted",
        "assistant.delta",
        "run.status",
        "stream.end",
    ]


async def test_mock_client_resume_cursor_is_exclusive() -> None:
    client = MockFrontendClient()
    await client.send_prompt("inspect")
    assert [event.cursor async for event in client.events(after_cursor=3)] == [4, 5]
