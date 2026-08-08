# Specialists

The local vertical slice contains deterministic Governance, Data Engineer, ML Engineer, Cluster,
Eval, Deployment, and Connector specialists. They consume structured task results, return typed
domain decisions/reports, and do not publish durable state or artifacts directly. Connector builds
deterministically generate tool schemas, source, contract tests, and a dependency-free package
manifest while failing closed on secret-like source and unsafe dependency references. Local
lifecycle tests cover independent evaluation, approval-bound publication, canary traffic, and
rollback.
