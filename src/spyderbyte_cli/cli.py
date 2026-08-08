from __future__ import annotations

import asyncio
import json
from typing import Annotated

import typer

from spyderbyte_cli.daemon import DaemonManager
from spyderbyte_cli.frontend.acp import AcpSessionBridge
from spyderbyte_cli.frontend.client import FrontendClient, HttpFrontendClient, MockFrontendClient
from spyderbyte_cli.frontend.resources import (
    RESOURCE_OPERATIONS,
    RESOURCE_TYPES,
    FrontendResourceError,
    NativeResourceClient,
)
from spyderbyte_cli.frontend.transport import FrontendTransport, FrontendTransportError
from spyderbyte_cli.shell import render_acceptance, render_event, render_session

app = typer.Typer(
    add_completion=False,
    invoke_without_command=True,
    help="Spyderbyte terminal shell, derived in part from Kimi CLI.",
)


class SpyderbyteCLI:
    """Spyderbyte composition root; UI code only receives the typed frontend client."""

    def __init__(self, client: FrontendClient, *, daemon: DaemonManager | None = None) -> None:
        self.client = client
        self.daemon = daemon

    @classmethod
    def create(
        cls,
        *,
        backend: str,
        base_url: str,
        token: str | None = None,
        workspace_id: str | None = None,
        project_id: str | None = None,
        daemon: DaemonManager | None = None,
    ) -> SpyderbyteCLI:
        if backend == "mock":
            return cls(MockFrontendClient(), daemon=daemon)
        if backend != "local":
            raise ValueError(f"unsupported Spyderbyte backend: {backend}")
        return cls(
            HttpFrontendClient(
                FrontendTransport(
                    base_url,
                    token=token,
                    workspace_id=workspace_id,
                    interface="cli",
                ),
                project_id=project_id,
            ),
            daemon=daemon,
        )

    async def run_once(self, prompt: str | None, as_json: bool) -> None:
        if self.daemon is not None:
            self.daemon.ensure()
        session = await self.client.open_session()
        if as_json:
            typer.echo(session.model_dump_json(by_alias=True))
        else:
            render_session(session)
        if prompt is None:
            return
        acceptance = await self.client.send_prompt(prompt)
        if as_json:
            typer.echo(acceptance.model_dump_json(by_alias=True))
        else:
            render_acceptance(acceptance)
        async for event in self.client.events(after_cursor=1 if session.mode == "mock" else 0):
            if event.kind == "session.ready" or event.run_id != acceptance.run_id:
                continue
            if as_json:
                typer.echo(event.model_dump_json(by_alias=True))
            else:
                render_event(event)
            if event.kind == "stream.end":
                break


async def _run_client(client: FrontendClient, prompt: str | None, as_json: bool) -> None:
    await SpyderbyteCLI(client).run_once(prompt, as_json)


async def _run_mock(prompt: str | None, as_json: bool) -> None:
    client = MockFrontendClient()
    session = await client.open_session()
    if as_json:
        typer.echo(session.model_dump_json(by_alias=True))
    else:
        render_session(session)
    if prompt is None:
        return
    acceptance = await client.send_prompt(prompt)
    if as_json:
        typer.echo(acceptance.model_dump_json(by_alias=True))
    else:
        render_acceptance(acceptance)
    async for event in client.events(after_cursor=1):
        if as_json:
            typer.echo(event.model_dump_json(by_alias=True))
        else:
            render_event(event)


@app.callback()
def main(
    ctx: typer.Context,
    mock: Annotated[
        bool, typer.Option(help="Use the deterministic Spyderbyte mock backend.")
    ] = False,
    backend: Annotated[str, typer.Option(help="Frontend backend: mock or local.")] = "mock",
    url: Annotated[
        str, typer.Option("--url", help="Spyderbyte local/hosted API URL.")
    ] = "http://127.0.0.1:8787",
    token: Annotated[
        str | None, typer.Option(help="Bearer token; never persisted by the shell.")
    ] = None,
    workspace_id: Annotated[
        str | None, typer.Option(help="Workspace identity for the API request.")
    ] = None,
    project_id: Annotated[
        str | None, typer.Option("--project", help="Project ID for the local conversation.")
    ] = None,
    prompt: Annotated[str | None, typer.Option("--prompt", "-p")] = None,
    as_json: Annotated[bool, typer.Option("--json", help="Emit newline-delimited JSON.")] = False,
) -> None:
    if ctx.invoked_subcommand is not None:
        return
    selected_backend = "mock" if mock else backend.lower()
    if selected_backend == "mock":
        asyncio.run(_run_mock(prompt, as_json))
        return
    if selected_backend == "local":
        daemon_manager = DaemonManager(url=url)
        client = SpyderbyteCLI.create(
            backend="local",
            base_url=url,
            token=token,
            workspace_id=workspace_id,
            project_id=project_id,
            daemon=daemon_manager,
        )
        try:
            asyncio.run(client.run_once(prompt, as_json))
        finally:
            daemon_manager.stop()
        return
    if not mock:
        typer.echo(
            "Unknown Spyderbyte backend. Use --backend local or --mock for the fixture shell."
        )
        raise typer.Exit(2)
    asyncio.run(_run_mock(prompt, as_json))


@app.command()
def daemon(
    ensure: Annotated[
        bool, typer.Option(help="Start the local daemon if it is not ready.")
    ] = False,
    stop: Annotated[
        bool, typer.Option(help="Stop a daemon process started by this shell.")
    ] = False,
    restart: Annotated[bool, typer.Option(help="Restart the local daemon.")] = False,
    diagnostics: Annotated[bool, typer.Option(help="Print safe daemon diagnostics.")] = False,
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    manager = DaemonManager()
    if diagnostics:
        result = manager.diagnostics()
    elif restart:
        result = manager.restart()
    elif stop:
        result = manager.stop()
    else:
        result = manager.ensure() if ensure else manager.discover()
    if as_json:
        typer.echo(json.dumps(result, sort_keys=True))
    else:
        typer.echo(f"Spyderbyte daemon: {result['state']} ({result['url']})")
    if result["state"] != "ready":
        raise typer.Exit(1)


@app.command()
def acp(
    mock: Annotated[bool, typer.Option(help="Use the deterministic frontend mock.")] = False,
    backend: Annotated[str, typer.Option(help="Frontend backend: mock or local.")] = "mock",
    url: Annotated[
        str, typer.Option("--url", help="Spyderbyte local/hosted API URL.")
    ] = "http://127.0.0.1:8787",
    token: Annotated[
        str | None, typer.Option(help="Bearer token; never persisted by the ACP bridge.")
    ] = None,
    workspace_id: Annotated[
        str | None, typer.Option(help="Workspace identity for the API request.")
    ] = None,
    project_id: Annotated[
        str | None, typer.Option("--project", help="Project ID for the local conversation.")
    ] = None,
    prompt: Annotated[str | None, typer.Option("--prompt", "-p")] = None,
    as_json: Annotated[bool, typer.Option("--json")] = True,
) -> None:
    """Run the ACP mapping boundary over a Spyderbyte AgentSession."""

    selected_backend = "mock" if mock else backend.lower()
    if selected_backend == "mock":
        asyncio.run(_run_acp(MockFrontendClient(), prompt, as_json))
        return
    if selected_backend != "local":
        typer.echo("Unknown ACP backend. Use --backend local or --mock.")
        raise typer.Exit(2)
    daemon_manager = DaemonManager(url=url)
    try:
        daemon_manager.ensure()
        client = SpyderbyteCLI.create(
            backend="local",
            base_url=url,
            token=token,
            workspace_id=workspace_id,
            project_id=project_id,
        ).client
        asyncio.run(_run_acp(client, prompt, as_json))
    finally:
        daemon_manager.stop()


async def _run_acp(client: FrontendClient, prompt: str | None, as_json: bool) -> None:
    bridge = AcpSessionBridge(client)
    initialization = await bridge.initialize()
    if as_json:
        typer.echo(json.dumps(initialization, sort_keys=True))
    if prompt is None:
        return
    async for update in bridge.prompt(prompt):
        if as_json:
            typer.echo(json.dumps(update, sort_keys=True))


async def _run_resource(
    *,
    backend: str,
    base_url: str,
    token: str | None,
    workspace_id: str | None,
    resource_type: str,
    operation: str,
    resource_id: str | None,
    run_id: str | None,
    input_json: str,
    stream: bool,
) -> int:
    if resource_type not in RESOURCE_TYPES:
        typer.echo(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "error": "resource_type is not supported",
                    "code": "VALIDATION_SCHEMA_MISMATCH",
                    "details": {"resourceType": resource_type, "supported": RESOURCE_TYPES},
                },
                sort_keys=True,
            )
        )
        return 2
    if operation not in RESOURCE_OPERATIONS:
        typer.echo(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "error": "operation is not supported",
                    "code": "VALIDATION_SCHEMA_MISMATCH",
                    "details": {"operation": operation, "supported": RESOURCE_OPERATIONS},
                },
                sort_keys=True,
            )
        )
        return 2
    try:
        payload = json.loads(input_json)
    except json.JSONDecodeError as error:
        typer.echo(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "error": "input must be valid JSON",
                    "code": "VALIDATION_SCHEMA_MISMATCH",
                    "details": {"message": error.msg},
                },
                sort_keys=True,
            )
        )
        return 2
    if not isinstance(payload, dict):
        typer.echo(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "error": "input must be a JSON object",
                    "code": "VALIDATION_SCHEMA_MISMATCH",
                },
                sort_keys=True,
            )
        )
        return 2

    daemon_manager: DaemonManager | None = None
    if backend == "mock":
        client: FrontendClient = MockFrontendClient()
    elif backend == "local":
        daemon_manager = DaemonManager(url=base_url)
        daemon_manager.ensure()
        client = SpyderbyteCLI.create(
            backend="local",
            base_url=base_url,
            token=token,
            workspace_id=workspace_id,
        ).client
    else:
        typer.echo(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "error": "unknown Spyderbyte backend",
                    "code": "VALIDATION_SCHEMA_MISMATCH",
                    "details": {"backend": backend},
                },
                sort_keys=True,
            )
        )
        return 2

    try:
        result = await client.resources.execute(
            resource_type,  # type: ignore[arg-type]
            operation,  # type: ignore[arg-type]
            resource_id=resource_id,
            run_id=run_id,
            payload=payload,
        )
        typer.echo(result.model_dump_json(by_alias=True))
        if stream and result.run_id is not None:
            async for event in client.events():
                if event.run_id != result.run_id:
                    continue
                typer.echo(event.model_dump_json(by_alias=True))
                if event.kind == "stream.end":
                    break
        return 0
    except FrontendResourceError as error:
        typer.echo(error.error.model_dump_json(by_alias=True))
        return 2
    except FrontendTransportError as error:
        if error.error is not None:
            typer.echo(error.error.model_dump_json(by_alias=True))
        else:
            typer.echo(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "error": str(error),
                        "code": "EXTERNAL_DEPENDENCY_UNAVAILABLE",
                    },
                    sort_keys=True,
                )
            )
        return 1
    finally:
        if isinstance(client.resources, NativeResourceClient):
            await client.resources.transport.close()
        if daemon_manager is not None:
            daemon_manager.stop()


@app.command("resource")
def resource_command(
    ctx: typer.Context,
    resource_type: str = typer.Argument(..., help="Native resource family."),
    operation: str = typer.Argument(
        ...,
        help=(
            "discover, invoke, observe, resume, cancel, inspect, compare, publish, export, or "
            "handoff."
        ),
    ),
    resource_id: str | None = typer.Option(None, "--resource-id"),
    run_id: str | None = typer.Option(None, "--run-id"),
    input_json: str = typer.Option(
        "{}", "--input", help="JSON object passed to the typed operation."
    ),
    stream: bool = typer.Option(
        False,
        "--stream",
        help="Follow matching Run events after invoke/resume.",
    ),
) -> None:
    """Run a typed computational-resource operation through the shared API."""

    parent_params = ctx.parent.params if ctx.parent is not None else {}
    selected_backend = (
        "mock" if parent_params.get("mock", False) else parent_params.get("backend", "mock")
    )
    exit_code = asyncio.run(
        _run_resource(
            backend=str(selected_backend).lower(),
            base_url=str(parent_params.get("url", "http://127.0.0.1:8787")),
            token=parent_params.get("token"),
            workspace_id=parent_params.get("workspace_id"),
            resource_type=resource_type,
            operation=operation,
            resource_id=resource_id,
            run_id=run_id,
            input_json=input_json,
            stream=stream,
        )
    )
    if exit_code:
        raise typer.Exit(exit_code)
