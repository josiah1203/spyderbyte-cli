"""Disposable checkpoint caching behind a Spyderbyte-owned port.

The cache borrows Kimi CLI's replace-on-write checkpointing pattern, Apache-2.0. It is not a
system of record: Spyderbyte remains authoritative for sessions, runs, events, and recovery.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any


class JsonCheckpointCache:
    def __init__(self, root: Path) -> None:
        self._root = root

    def load(self, cache_key: str) -> dict[str, Any] | None:
        path = self._path(cache_key)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def store(self, cache_key: str, value: dict[str, Any]) -> None:
        self._root.mkdir(parents=True, exist_ok=True)
        serialized = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self._digest(cache_key)}.", suffix=".tmp", dir=self._root
        )
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(serialized)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self._path(cache_key))
        finally:
            temporary_path.unlink(missing_ok=True)

    def _path(self, cache_key: str) -> Path:
        if not cache_key:
            raise ValueError("cache_key must not be empty")
        return self._root / f"{self._digest(cache_key)}.json"

    @staticmethod
    def _digest(cache_key: str) -> str:
        return hashlib.sha256(cache_key.encode("utf-8")).hexdigest()
