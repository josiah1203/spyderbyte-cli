# Policy

Phase 3 control-plane primitives are implemented here:

- integrity-protected, invocation-bound authority envelopes with scoped resources and revocation epochs;
- typed, versioned, reproducible policy decisions;
- approval requests whose digests bind exact artifact versions, credentials, deployment traffic, cost,
  policy version, and configuration;
- expiring break-glass grants that require independent human approval, bind one human to explicit
  actions/resources, cap use count, and emit audit evidence for request, approval, revocation, and use;
- commit-time approval revalidation and an audit sink port.

The default stores are in-memory and are intentionally exposed behind small ports so a durable state
adapter can be supplied without moving authorization into agents or prompts.
