from __future__ import annotations

import pytest

from spyderbyte_cli.adapters.kimi import (
    ExtractiveContextCompactor,
    JsonCheckpointCache,
    RecencyContextWindowManager,
)
from spyderbyte_cli.adapters.ports import ContextItem


def test_recency_window_preserves_protected_and_newest_context() -> None:
    items = (
        ContextItem("system", "policy", 2, protected=True),
        ContextItem("old", "old turn", 4),
        ContextItem("new", "new turn", 3),
    )
    selection = RecencyContextWindowManager().select(items, token_budget=5)
    assert [item.item_id for item in selection.items] == ["system", "new"]
    assert selection.omitted_item_ids == ("old",)
    assert selection.token_count == 5


def test_recency_window_fails_when_protected_context_exceeds_budget() -> None:
    items = (ContextItem("system", "policy", 4, protected=True),)
    with pytest.raises(ValueError, match="protected context"):
        RecencyContextWindowManager().select(items, token_budget=3)


def test_extractive_compactor_is_bounded_and_traceable() -> None:
    items = (
        ContextItem("one", "first message", 4),
        ContextItem("two", "second message", 4),
    )
    result = ExtractiveContextCompactor().compact(items, token_budget=5)
    assert len(result.summary) <= 20
    assert result.summary.endswith("…")
    assert result.source_item_ids == ("one", "two")
    assert result.estimated_tokens <= 5


def test_checkpoint_cache_is_deterministic_and_treats_corruption_as_a_miss(tmp_path) -> None:
    cache = JsonCheckpointCache(tmp_path)
    assert cache.load("session/one") is None

    cache.store("session/one", {"cursor": 7, "runId": "run-1"})
    assert cache.load("session/one") == {"cursor": 7, "runId": "run-1"}
    checkpoint = next(tmp_path.glob("*.json"))
    assert checkpoint.name != "session/one.json"
    assert list(tmp_path.glob("*.tmp")) == []

    checkpoint.write_text("not-json", encoding="utf-8")
    assert cache.load("session/one") is None


def test_checkpoint_cache_rejects_empty_keys(tmp_path) -> None:
    cache = JsonCheckpointCache(tmp_path)
    with pytest.raises(ValueError, match="must not be empty"):
        cache.load("")
