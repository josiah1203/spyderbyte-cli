from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any, cast

from spyderbyte_cli.frontend.models import (
    EventPage,
    FrontendApproval,
    FrontendArtifact,
    FrontendEvent,
    FrontendRun,
    FrontendRunState,
    FrontendSession,
    FrontendUsage,
)


@dataclass(frozen=True, slots=True)
class FrontendSnapshot:
    """Deterministic, render-ready state derived solely from frontend events."""

    session: FrontendSession
    cursor: int
    assistant_text: str
    runs: tuple[FrontendRun, ...]
    approvals: tuple[FrontendApproval, ...]
    artifacts: tuple[FrontendArtifact, ...]
    usage: tuple[FrontendUsage, ...]
    seen_event_ids: tuple[str, ...]
    gap_detected: bool
    refresh_required: bool


@dataclass(slots=True)
class FrontendProjector:
    """Apply duplicate-safe, cursor-ordered frontend events."""

    session: FrontendSession
    cursor: int = 0
    assistant_text: str = ""
    gap_detected: bool = False
    refresh_required: bool = False
    _runs: dict[str, FrontendRun] = field(default_factory=dict)
    _approvals: dict[str, FrontendApproval] = field(default_factory=dict)
    _artifacts: dict[str, FrontendArtifact] = field(default_factory=dict)
    _usage: dict[str, FrontendUsage] = field(default_factory=dict)
    _seen_event_ids: set[str] = field(default_factory=set)
    _pending: dict[int, FrontendEvent] = field(default_factory=dict)

    def apply(self, page_or_event: EventPage | FrontendEvent) -> None:
        if isinstance(page_or_event, EventPage):
            self.gap_detected = self.gap_detected or page_or_event.gap_detected
            self.refresh_required = self.refresh_required or page_or_event.refresh_required
            for event in page_or_event.events:
                self._enqueue(event)
        else:
            self._enqueue(page_or_event)
        self._drain()
        if self._pending and min(self._pending) > self.cursor + 1:
            self.gap_detected = True
            self.refresh_required = True
        elif not self._pending and not self.gap_detected:
            self.refresh_required = False

    def replace(self, events: Iterable[FrontendEvent], *, cursor: int = 0) -> None:
        """Replace local state after the backend says a cursor gap needs refresh."""

        self.cursor = cursor
        self.assistant_text = ""
        self.gap_detected = False
        self.refresh_required = False
        self._runs.clear()
        self._approvals.clear()
        self._artifacts.clear()
        self._usage.clear()
        self._seen_event_ids.clear()
        self._pending.clear()
        for event in sorted(events, key=lambda item: (item.cursor, item.event_id)):
            self._enqueue(event)
        self._drain()

    def snapshot(self) -> FrontendSnapshot:
        return FrontendSnapshot(
            session=self.session,
            cursor=self.cursor,
            assistant_text=self.assistant_text,
            runs=tuple(self._runs[key] for key in sorted(self._runs)),
            approvals=tuple(self._approvals[key] for key in sorted(self._approvals)),
            artifacts=tuple(self._artifacts[key] for key in sorted(self._artifacts)),
            usage=tuple(self._usage[key] for key in sorted(self._usage)),
            seen_event_ids=tuple(sorted(self._seen_event_ids)),
            gap_detected=self.gap_detected,
            refresh_required=self.refresh_required,
        )

    def _enqueue(self, event: FrontendEvent) -> None:
        if event.event_id in self._seen_event_ids or event.cursor <= self.cursor:
            return
        self._seen_event_ids.add(event.event_id)
        self._pending.setdefault(event.cursor, event)

    def _drain(self) -> None:
        while (event := self._pending.pop(self.cursor + 1, None)) is not None:
            self._apply_event(event)
            self.cursor = event.cursor

    def _apply_event(self, event: FrontendEvent) -> None:
        payload = event.payload
        if event.kind == "assistant.delta":
            text = payload.get("text")
            if isinstance(text, str):
                self.assistant_text += text
            return
        if event.kind in {"turn.accepted", "run.status"} and event.run_id is not None:
            fallback = "accepted" if event.kind == "turn.accepted" else "running"
            state = _run_state(payload.get("state"), fallback)
            previous = self._runs.get(event.run_id)
            self._runs[event.run_id] = FrontendRun(
                run_id=event.run_id,
                project_id=event.project_id,
                state=state,
                attempt_count=_non_negative_int(
                    payload.get("attemptCount"),
                    previous.attempt_count if previous is not None else 0,
                ),
                requested_action=_string(payload.get("requestedAction"))
                or (previous.requested_action if previous is not None else None),
            )
            return
        if event.kind == "approval.requested" and event.run_id is not None:
            approval_id = _string(payload.get("approvalId")) or f"approval:{event.event_id}"
            self._approvals[approval_id] = FrontendApproval(
                approval_id=approval_id,
                run_id=event.run_id,
                state="pending",
                action=_record(payload.get("action")),
                resources=_strings(payload.get("resources")),
            )
            return
        if event.kind == "approval.committed":
            approval_id = _string(payload.get("approvalId"))
            if approval_id is not None and approval_id in self._approvals:
                previous = self._approvals[approval_id]
                decision = _string(payload.get("state"))
                state = decision if decision in {"approved", "rejected", "revoked"} else "approved"
                self._approvals[approval_id] = previous.model_copy(update={"state": state})
            return
        if event.kind == "artifact.available":
            artifact_id = _string(payload.get("artifactId"))
            version = _non_negative_int(payload.get("version"), 0)
            media_type = _string(payload.get("mediaType"))
            if artifact_id is not None and version > 0 and media_type is not None:
                self._artifacts[artifact_id] = FrontendArtifact(
                    artifact_id=artifact_id,
                    version=version,
                    media_type=media_type,
                    content_hash=_string(payload.get("contentHash")),
                    title=_string(payload.get("title")),
                )
            return
        if event.kind == "usage.updated" and event.run_id is not None:
            self._usage[event.run_id] = FrontendUsage(
                run_id=event.run_id,
                input_tokens=_non_negative_int(payload.get("inputTokens"), 0),
                output_tokens=_non_negative_int(payload.get("outputTokens"), 0),
                estimated_cost=_non_negative_float(payload.get("estimatedCost")),
                actual_cost=_non_negative_float(payload.get("actualCost")),
            )
            return
        if event.kind == "stream.end" and event.run_id is not None:
            previous = self._runs.get(event.run_id)
            if previous is not None and previous.state in {"accepted", "queued", "running"}:
                self._runs[event.run_id] = previous.model_copy(update={"state": "succeeded"})


def project_events(session: FrontendSession, events: Iterable[FrontendEvent]) -> FrontendSnapshot:
    projector = FrontendProjector(session)
    for event in events:
        projector.apply(event)
    return projector.snapshot()


def _run_state(value: object, fallback: FrontendRunState) -> FrontendRunState:
    valid_states = {
        "accepted",
        "queued",
        "running",
        "awaiting_approval",
        "succeeded",
        "failed",
        "cancelled",
        "timed_out",
        "partially_succeeded",
    }
    if isinstance(value, str) and value in valid_states:
        return cast(FrontendRunState, value)
    return fallback


def _record(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _strings(value: object) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(item for item in value if isinstance(item, str))


def _non_negative_int(value: object, fallback: int) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return fallback


def _non_negative_float(value: object) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
        return float(value)
    return None
