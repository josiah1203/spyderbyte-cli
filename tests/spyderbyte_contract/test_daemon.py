from __future__ import annotations

from pathlib import Path

from spyderbyte_cli.daemon import DaemonManager


class FakeResponse:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_daemon_status_ready() -> None:
    manager = DaemonManager(opener=lambda *args, **kwargs: FakeResponse())
    assert manager.status() == {"state": "ready", "url": "http://127.0.0.1:8787"}


def test_daemon_ensure_requires_composed_platform(tmp_path: Path) -> None:
    def stopped(*args, **kwargs):
        raise OSError("not listening")

    manager = DaemonManager(opener=stopped, repository_root=tmp_path)
    try:
        manager.ensure()
    except RuntimeError as error:
        assert "not composed" in str(error)
    else:
        raise AssertionError("missing platform must fail before spawning a process")
