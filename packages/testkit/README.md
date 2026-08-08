# Testkit

This package owns cross-package invariant and hosted-database smoke fixtures. Contract suites and
deterministic test utilities live beside the ports they exercise so every adapter can run the same
behavioral checks in local CI; PostgreSQL cases activate when `DATABASE_URL` is supplied.
