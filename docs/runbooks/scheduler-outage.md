# Scheduler outage

1. Stop new compute allocation and preserve existing allocation/grant records. Recheck Cluster
   authority, tenant scope, approval, cost, and expiry before retrying.
2. Observe active jobs through the scheduler adapter. Do not assume a missing response means a job
   stopped; use an external request ID or lease state.
3. Release expired or cancelled grants, terminate only through the approved controller, and
   reconcile actual usage and cost.
4. Resume queued work with bounded retry ownership after capacity and connectivity recover.

Kubernetes/SLURM commands and capacity targets remain intentionally unselected.
