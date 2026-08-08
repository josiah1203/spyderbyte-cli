"""Kimi-derived context budgeting primitives behind Spyderbyte-owned ports.

Derived from concepts in Kimi CLI's context and compaction implementation, Apache-2.0.
Spyderbyte selects eligible context and owns durable history; this module only performs bounded,
deterministic selection and extractive compaction over the supplied fixture-safe values.
"""

from __future__ import annotations

from spyderbyte_cli.adapters.ports import (
    CompactionResult,
    ContextItem,
    ContextSelection,
)


class RecencyContextWindowManager:
    def select(
        self,
        items: tuple[ContextItem, ...],
        *,
        token_budget: int,
    ) -> ContextSelection:
        if token_budget < 0:
            raise ValueError("token_budget must be non-negative")
        protected = [item for item in items if item.protected]
        protected_tokens = sum(item.token_count for item in protected)
        if protected_tokens > token_budget:
            raise ValueError("protected context exceeds token budget")

        selected_ids = {item.item_id for item in protected}
        remaining = token_budget - protected_tokens
        for item in reversed(items):
            if item.item_id in selected_ids:
                continue
            if item.token_count <= remaining:
                selected_ids.add(item.item_id)
                remaining -= item.token_count

        selected = tuple(item for item in items if item.item_id in selected_ids)
        omitted = tuple(item.item_id for item in items if item.item_id not in selected_ids)
        return ContextSelection(
            items=selected,
            token_count=sum(item.token_count for item in selected),
            omitted_item_ids=omitted,
        )


class ExtractiveContextCompactor:
    def compact(
        self,
        items: tuple[ContextItem, ...],
        *,
        token_budget: int,
    ) -> CompactionResult:
        if token_budget <= 0:
            raise ValueError("token_budget must be positive")
        source_ids = tuple(item.item_id for item in items)
        if not items:
            return CompactionResult(summary="", source_item_ids=(), estimated_tokens=0)

        character_budget = token_budget * 4
        lines = [f"[{item.item_id}] {item.text.strip()}" for item in items if item.text.strip()]
        summary = "\n".join(lines)
        if len(summary) > character_budget:
            summary = summary[: max(0, character_budget - 1)].rstrip() + "…"
        estimated_tokens = min(token_budget, max(1, (len(summary) + 3) // 4))
        return CompactionResult(
            summary=summary,
            source_item_ids=source_ids,
            estimated_tokens=estimated_tokens,
        )
