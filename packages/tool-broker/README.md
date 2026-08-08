# Tool broker

The broker issues short-lived, invocation-bound grants for exact tool operations and resource
selectors. Execution revalidates authority, policy, approval, grant expiry/use limits, and budget
before invoking the tool; responses are JSON-validated, secret-redacted, metered, and audited.
