from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

DEFAULT_DAEMON_URL = "http://127.0.0.1:8787"


class DaemonManager:
    def __init__(
        self,
        *,
        url: str = DEFAULT_DAEMON_URL,
        opener: Callable[..., Any] = urlopen,
        popen: Callable[..., Any] = subprocess.Popen,
        repository_root: Path | None = None,
    ) -> None:
        self.url = url.rstrip("/")
        self._opener = opener
        self._popen = popen
        self._repository_root = repository_root or Path(__file__).resolve().parents[2]
        self._process: Any | None = None
        self._log_path: Path | None = None

    def discover(self) -> dict[str, str]:
        """Discover the configured local daemon without spawning or mutating anything."""

        return self.status()

    def status(self) -> dict[str, str]:
        try:
            with self._opener(f"{self.url}/health", timeout=0.5) as response:
                state = "ready" if response.status == 200 else "degraded"
        except (OSError, HTTPError, URLError):
            state = "stopped"
        return {"state": state, "url": self.url}

    def ensure(self, *, timeout: float = 20.0) -> dict[str, str]:
        current = self.status()
        if current["state"] == "ready":
            return current

        return self.start(timeout=timeout)

    def start(self, *, timeout: float = 20.0) -> dict[str, str]:
        current = self.status()
        if current["state"] == "ready":
            return current
        if self._process is not None and self._process.poll() is not None:
            self._process = None

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
        kwargs: dict[str, Any] = {
            "cwd": self._repository_root,
            "env": environment,
            "stdout": log_handle,
            "stderr": subprocess.STDOUT,
        }
        if os.name != "nt":
            kwargs["start_new_session"] = True
        try:
            process = self._popen(
                [
                    "pnpm",
                    "--dir",
                    str(platform),
                    "--filter",
                    "@agentic-platform/local-daemon",
                    "local:server",
                ],
                **kwargs,
            )
        finally:
            log_handle.close()
        self._process = process
        self._log_path = log_path

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

    def stop(self, *, timeout: float = 5.0) -> dict[str, str]:
        """Stop only a process owned by this manager."""

        process = self._process
        if process is None:
            return self.status()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=timeout)
        self._process = None
        return self.status()

    def restart(self, *, timeout: float = 20.0) -> dict[str, str]:
        self.stop()
        return self.start(timeout=timeout)

    def diagnostics(self) -> dict[str, Any]:
        """Return safe daemon diagnostics; log content is intentionally not included."""

        result: dict[str, Any] = {
            **self.status(),
            "ownedProcess": self._process is not None,
        }
        if self._log_path is not None:
            result["logPath"] = str(self._log_path)
        try:
            with self._opener(f"{self.url}/v1/diagnostics", timeout=1.0) as response:
                payload = response.read()
            decoded = json.loads(payload.decode("utf-8") if isinstance(payload, bytes) else payload)
            if isinstance(decoded, dict):
                result["daemon"] = decoded
        except (OSError, HTTPError, URLError, ValueError, TypeError):
            result["daemon"] = {"state": "unavailable"}
        return result
