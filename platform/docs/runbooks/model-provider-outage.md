# Model provider outage

1. Stop new provider calls when the outage is confirmed and classify failures as retryable only
   when the runtime policy allows it.
2. Preserve the command, workflow, harness version, model route, usage, and cost evidence without
   recording credentials or untrusted provider content as authority.
3. Retry with bounded backoff or use an explicitly approved fallback route. Do not duplicate a
   durable side effect because a model response was lost.
4. Revalidate report schema, authority, budget, and acceptance policy before committing output.

Provider choice, data-handling constraints, and fallback policy require product and operations
approval.
