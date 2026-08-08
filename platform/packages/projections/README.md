# Projections

`ProjectionEngine` derives workflow, invocation/job, artifact/lineage, approval, budget/cost, and
audit views from the authoritative event stream. It also exposes tenant-scoped catalog, model,
deployment, connector/governance, and chat/session projections so every planned interaction-panel
read has the same authoritative source. It persists tenant-scoped global-stream checkpoints,
detects gaps, exposes lag/staleness, supports idempotent incremental runs, and rebuilds from zero
after a process restart or projector failure. `BuiltinProjectionReader` exposes the same
tenant-bound snapshots to local or hosted API composition roots.
