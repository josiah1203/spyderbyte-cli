from __future__ import annotations

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from spyderbyte_cli.frontend.models import FrontendEvent, FrontendSession, PromptAcceptance

console = Console()


def render_session(session: FrontendSession) -> None:
    table = Table.grid(padding=(0, 2))
    table.add_column(style="cyan")
    table.add_column()
    table.add_row("Project", session.project_id)
    table.add_row("Agent session", session.agent_session_id)
    table.add_row("Mode", session.mode)
    table.add_row("Backend", session.capabilities.api_version)
    console.print(Panel(table, title="Spyderbyte", border_style="cyan"))


def render_acceptance(acceptance: PromptAcceptance) -> None:
    console.print(Text(f"Run {acceptance.run_id} accepted", style="cyan"))


def render_event(event: FrontendEvent) -> None:
    if event.kind == "assistant.delta":
        console.print(str(event.payload.get("text", "")))
    elif event.kind == "run.status":
        console.print(Text(f"Run status: {event.payload.get('state', 'unknown')}", style="green"))
