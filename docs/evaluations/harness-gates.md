# Harness evaluation gates

Every harness version is recorded on the invocation and evaluated at its own tier.

- Tier 0: plan completeness, specialist routing, authority/budget compliance, escalation quality,
  and unnecessary invocation rate.
- Tier 1: domain decision quality, child decomposition, policy compliance, and rejection of
  malformed deterministic outputs.
- Tier 2: schema/test validity, deterministic repeatability, unauthorized-operation rate, and
  token/tool-call efficiency.
- System: objective success, total cost/duration, intervention rate, stale-artifact propagation,
  audit completeness, rollback rate, and recovery after injected failure.

Release stages are shadow, canary, limited availability, and general availability. The executable
`evaluateReleaseGate` helper holds a candidate when any check or required operator approval fails,
keeps the previous harness version available for rollback, and records an evidence digest. It does
not invent target values or silently change the acceptance policy.
