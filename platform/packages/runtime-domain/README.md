# Runtime domain

`CommandDispatcher` is the transaction boundary for validated, authorized commands. It computes a
stable request digest, reserves tenant-scoped idempotency keys, invokes a pure handler with a
transaction context, appends ordered domain events and transactional outbox rows, and returns the
stored result on replay.
