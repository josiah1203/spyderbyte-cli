# Phase 11 local operations targets

These are the explicit local-release targets for the first supported Spyderbyte installation.
They are decision inputs, not silently inferred production guarantees. Hosted and organizational
targets require their own approved release record.

| Area                   | Local target                                    | Evidence shape                     |
| ---------------------- | ----------------------------------------------- | ---------------------------------- |
| command acceptance     | 100% of deterministic fixture commands accepted | command and API acceptance suite   |
| idempotency            | duplicate keys produce one authoritative result | universal-run and command fixtures |
| projection freshness   | p95 ≤ 2,000 ms                                  | timestamped local observation      |
| subscription reconnect | p95 ≤ 5,000 ms                                  | cursor replay fixture              |
| workflow recovery      | p95 ≤ 30,000 ms                                 | daemon/worker restart fixture      |
| audit completeness     | 100% of material fixture actions                | hash-chain verification            |
| artifact durability    | 100% of published fixture artifacts recoverable | backup/restore exercise            |
| deployment rollback    | p95 ≤ 60,000 ms                                 | local serving rollback fixture     |
| local concurrency      | 4 concurrent command workers                    | bounded capacity probe             |
| artifact size          | 100 MiB maximum for the local release harness   | request validation                 |
| slow consumers         | 32 buffered event pages per subscriber          | reconnect/backpressure fixture     |
| connection exhaustion  | 128 local API sessions                          | supervisor/load fixture            |

Every recorded observation must include the harness version, fixture/scenario version, observation
window, workspace scope, correlation range, raw-measurement digest, evaluated result, and operator
approval. A failed target holds the current release and requires an explicit remediation record.
