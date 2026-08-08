from __future__ import annotations

import asyncio
import json
from typing import Annotated

import typer

from spyderbyte_cli.daemon import DaemonManager
from spyderbyte_cli.frontend.client import MockFrontendClient
from spyderbyte_cli.shell import render_acceptance, render_event, render_session

app = typer.Typer(
    add_completion=False,
    invoke_without_command=True,
    help="Spyderbyte terminal shell, derived in part from Kimi CLI.",
)


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
    mock: Annotated[bool, typer.Option(help="Use the deterministic Wave 1 mock backend.")] = False,
    prompt: Annotated[str | None, typer.Option("--prompt", "-p")] = None,
    as_json: Annotated[bool, typer.Option("--json", help="Emit newline-delimited JSON.")] = False,
) -> None:
    if ctx.invoked_subcommand is not None:
        return
    if not mock:
        typer.echo(
            "Spyderbyte backend wiring arrives in Wave 2. Run with --mock for the fixture shell."
        )
        raise typer.Exit(2)
    asyncio.run(_run_mock(prompt, as_json))


@app.command()
def daemon(
    ensure: Annotated[
        bool, typer.Option(help="Start the local daemon if it is not ready.")
    ] = False,
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    manager = DaemonManager()
    result = manager.ensure() if ensure else manager.status()
    if as_json:
        typer.echo(json.dumps(result, sort_keys=True))
    else:
        typer.echo(f"Spyderbyte daemon: {result['state']} ({result['url']})")
    if result["state"] != "ready":
        raise typer.Exit(1)
