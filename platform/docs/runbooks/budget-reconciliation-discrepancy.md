# Budget reconciliation discrepancy

1. Pause new compute and model reservations for the affected tenant or budget, without altering
   already committed records.
2. Compare reservation history, usage observations, provider receipts, retry records, and actual
   compute observations using integer minor-unit arithmetic.
3. Identify duplicate, missing, or late receipts by idempotency/effect key. Reconcile through FinOps
   with an auditable adjustment; never silently rewrite usage.
4. Recheck hard-limit enforcement, available balance, reservation state, and workflow impact.

Production price sources and material adjustment thresholds require the approved budget and
operations decisions.
