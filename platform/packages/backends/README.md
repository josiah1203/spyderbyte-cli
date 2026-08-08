# Resource backends

The package exposes local and provider-neutral hosted contracts for compute, experiment, catalog,
model and connector registries, event transport, secret management, and quota-aware worker pools.
Hosted
adapters accept injected clients so provider selection remains outside business logic; authority,
tenant, deduplication, lease, redaction, and result-shape checks remain in this package.

`ConnectorPublicationWorkflow` is the provider-neutral publication gate. It validates tenant-bound
material and requires a digest covering the source artifact, generated package, scopes, scans, and
contract-test evidence before delegating to the registry.

`InMemoryCatalogBackend` provides tenant-scoped dataset resolution, schema reads, and monotonic
artifact-version publication. `HostedCatalogBackend` preserves the same contract behind an
injected catalog client and rejects cross-tenant or malformed hosted responses.

`InMemoryWorkerPool` models Tier 0 control, Tier 1 domain, Tier 2 deterministic/coding,
compute-observation, and projection pools with tenant quotas, lease heartbeats, redelivery, and
parking. `HostedWorkerPool` preserves the same contract behind an injected hosted client.

Local compute offers carry a deterministic rate basis. The local training workflow executes both
candidate configurations sequentially, keeps candidate-level observations and checkpoints,
selects the best deterministic metric, and enforces the cumulative reconciled budget before each
offer and after each observation. Training summaries preserve both estimated and observation-
derived actual cost. The hosted scheduler contract can supply its own usage and billing
implementation without changing the control-plane result shape. Model publication requires a
structured lineage record linking the checkpoint to its experiment run, exact training
configuration, source revision, environment snapshot, validated dataset, and original-data
lineage.
