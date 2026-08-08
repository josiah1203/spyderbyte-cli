from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from spyderbyte_cli.adapters.ports import AdapterUnavailable, LocalProcessRuntime, ProcessRequest


class BoundedProcessRuntime(LocalProcessRuntime):
    """Small local-process adapter with explicit path, timeout, and output bounds."""

    def __init__(
        self,
        *,
        workspace_root: Path,
        allowed_programs: frozenset[str] = frozenset(),
        max_output_bytes: int = 256 * 1024,
    ) -> None:
        self.workspace_root = workspace_root.resolve()
        self.allowed_programs = allowed_programs
        self.max_output_bytes = max_output_bytes

    async def execute(self, request: ProcessRequest) -> dict[str, Any]:
        if not request.argv:
            raise AdapterUnavailable("process requests require a program")
        program = request.argv[0]
        if self.allowed_programs and program not in self.allowed_programs:
            raise AdapterUnavailable(f"program is not approved: {program}")
        cwd = Path(request.cwd).resolve()
        if not cwd.is_relative_to(self.workspace_root):
            raise AdapterUnavailable("process cwd is outside the approved workspace")
        if request.timeout_ms < 1 or request.timeout_ms > 120_000:
            raise AdapterUnavailable("process timeout is outside the allowed range")
        try:
            process = await asyncio.create_subprocess_exec(
                *request.argv,
                cwd=cwd,
                env=request.environment or None,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
        except OSError as error:
            raise AdapterUnavailable("approved process could not be started") from error
        try:
            output_bytes, _ = await asyncio.wait_for(
                process.communicate(),
                timeout=request.timeout_ms / 1000,
            )
        except TimeoutError:
            process.kill()
            await process.wait()
            return {
                "state": "timed_out",
                "exitCode": None,
                **_bounded(output_bytes=b"", limit=self.max_output_bytes),
            }
        output = _bounded(output_bytes=output_bytes, limit=self.max_output_bytes)
        return {
            "state": "succeeded" if process.returncode == 0 else "failed",
            "exitCode": process.returncode,
            **output,
        }


def _bounded(*, output_bytes: bytes, limit: int) -> dict[str, Any]:
    clipped = output_bytes[:limit]
    return {
        "output": clipped.decode("utf-8", errors="replace"),
        "truncated": len(output_bytes) > limit,
    }
