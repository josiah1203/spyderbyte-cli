from __future__ import annotations

import os
import subprocess
import tempfile
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen

DEFAULT_DAEMON_URL = "http://127.0.0.1:8787"


class DaemonManager:
    def __init__(
        self,
        *,
        url: str = DEFAULT_DAEMON_URL,
        opener: Callable[..., Any] = urlopen,
        popen: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
        repository_root: Path | None = None,
    ) -> None:
        self.url = url.rstrip("/")
        self._opener = opener
        self._popen = popen
        self._repository_root = repository_root or Path(__file__).resolve().parents[2]

    def status(self) -> dict[str, str]:
        try:
            with self._opener(f"{self.url}/health", timeout=0.5) as response:
                state = "ready" if response.status == 200 else "degraded"
        except (OSError, URLError):
            state = "stopped"
        return {"state": state, "url": self.url}

    def ensure(self, *, timeout: float = 20.0) -> dict[str, str]:
        current = self.status()
        if current["state"] == "ready":
            return current

        platform = self._repository_root / "platform"
        if not (platform / "apps/local-daemon/package.json").is_file():
            raise RuntimeError(f"Spyderbyte platform is not composed at {platform}")

        log_path = Path(tempfile.gettempdir()) / "spyderbyte-local-daemon.log"
        log_handle = log_path.open("ab")
        environment = os.environ.copy()
        environment.setdefault(
            "AGENTIC_WORKSPACE",
            str(self._repository_root / ".spyderbyte" / "workspace"),
        )
        process = self._popen(
            [
                "pnpm",
                "--dir",
                str(platform),
                "--filter",
                "@agentic-platform/local-daemon",
                "local:server",
            ],
            cwd=self._repository_root,
            env=environment,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        log_handle.close()

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(
                    f"Spyderbyte daemon exited with {process.returncode}; inspect {log_path}"
                )
            current = self.status()
            if current["state"] == "ready":
                return current
            time.sleep(0.1)
        raise TimeoutError(f"Spyderbyte daemon was not ready within {timeout}s; inspect {log_path}")
