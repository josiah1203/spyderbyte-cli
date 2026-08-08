# Spyderbyte workspace

`WorkspaceManager` owns the portable Spyderbyte directory shape. A workspace contains a
`.agentic/workspace.json` manifest, SQLite state at `.agentic/state.sqlite`, and filesystem CAS
objects at `.agentic/objects`. The manifest is written atomically and validates the workspace and
tenant UUIDv7 identifiers before opening.

Directory export/import copies the complete workspace without overwriting an existing destination.
For Spyderbyte portability, `WorkspaceManager` also writes and restores the versioned
`agentic.workspace.archive.v1` JSON archive. Each regular file is stored with its byte count and
SHA-256 digest, the archive has a canonical SHA-256 digest, symlinks and traversal paths are
rejected, and restore refuses an existing destination. `previewRestore` validates the archive and
reports whether the destination exists before any files are written. The archive is integrity
protected but not encrypted; users should store exported archives in a protected location.
