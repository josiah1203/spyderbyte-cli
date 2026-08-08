# Rollback failed

1. Freeze further traffic changes and record deployment, model/artifact version, target, action
   digest, health evidence, and operator correlation ID.
2. Use the Deployment controller to recheck tenant scope, approval, authority, and current
   generation. Do not mutate serving traffic directly from a worker or UI.
3. If the previous version is unhealthy, route to the approved safe state or stop serving rather
   than widening exposure. Preserve the failed rollback evidence.
4. Verify health, deployment projection, audit chain, and budget/cost reconciliation before
   reopening changes.

Serving-system commands and safe-state policy are hosted deployment decisions.
