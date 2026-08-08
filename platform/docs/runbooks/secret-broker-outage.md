# Secret broker outage

1. Fail closed for secret issuance and resolution. Do not copy raw secret values into prompts,
   logs, artifacts, environment dumps, or incident tickets.
2. Record only tenant, credential-handle, operation, correlation, and redacted error metadata.
3. Retry handle operations with bounded backoff only when the operation is declared retryable.
   Recheck scope, revocation, and expiry before each use.
4. After recovery, verify redaction, audit completeness, and that no pending worker retained a
   plaintext value.

Provider secret-manager failover and credential rotation are hosted decision-gate procedures.
