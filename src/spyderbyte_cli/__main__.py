from __future__ import annotations

from collections.abc import Sequence


def main(argv: Sequence[str] | None = None) -> int:
    from spyderbyte_cli.cli import app

    args = None if argv is None else list(argv)
    app(args=args, prog_name="spyderbyte")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
