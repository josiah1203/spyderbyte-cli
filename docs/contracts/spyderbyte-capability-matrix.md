# Spyderbyte capability matrix

This matrix is the P0 acceptance boundary for the terminal-first product loop. “Durable” means backed by the authoritative state/event boundary; “projection” means a read model and is not sufficient by itself to claim execution.

| Capability             | Authority                                                                | Terminal/CLI                                     | Web/Desktop                                    | P0 acceptance evidence                            |
| ---------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------- |
| Provider configuration | `ProviderConfiguration` metadata + credential vault                      | `provider add`, `provider list`, `provider test` | Local API available to existing clients        | Metadata persistence and secret-redaction tests   |
| Provider credentials   | Vault value keyed by credential reference; metadata contains status only | Add/rotate through API; never print secret       | API accepts secret over authenticated request  | Store snapshot excludes plaintext secret          |
| Model discovery        | Persisted `ProviderModel` records refreshed by provider transport        | `model list`, `model refresh`                    | `/v1/models` and existing catalog              | Discovery transport tests and restart rehydration |
| Model selection        | `ModelRouter` + routing policy + ready provider metadata                 | Used by `run prompt`                             | Shared local API path                          | Selection rejects unconfigured providers          |
| Project create/open    | Project aggregate and `projects` projection                              | `project create`, `project list`                 | Existing command/projection surface            | Tenant-bound command and projection contract      |
| Model invocation       | `Run`, `RunAttempt`, invocation aggregate, run events                    | `run prompt`                                     | Conversation API and run endpoints             | Local-daemon durable run test                     |
| Progress/log streaming | Event store + outbox + `/v1/subscriptions/events` SSE                    | Follow run cursor with reconnect                 | Existing SSE client can consume same events    | Client SDK cursor/reconnect test                  |
| Run detail             | `Run` and `RunAttempt` reconstructed from authoritative events           | `run show`, `run logs`                           | `/v1/runs/{runId}`                             | State/attempt/log assertions                      |
| Cancel                 | Active turn controller plus terminal run event                           | `run cancel`                                     | Existing conversation cancel + run cancel      | Cancellation emits terminal run state             |
| Retry                  | Original user message + new durable run                                  | `run retry`                                      | API endpoint                                   | Only terminal failed runs retry                   |
| Provider health/usage  | Provider configuration state and safe usage report                       | `doctor`, provider health endpoints              | API/catalog surface                            | No credentials in health/usage responses          |
| Query/SQL preview      | Projection/local preview only                                            | Not exposed as a fake durable run                | Controls remain unavailable/explicitly preview | No completion claim without execution backend     |

## Explicit non-goals for this P0 slice

- Hosted multi-tenant provider secret storage.
- Provider-specific multimodal/tool-call schemas beyond the common text transport boundary.
- Treating a chart, SQL preview, or generated projection as a completed model run.
- Hiding a provider outage behind an automatic fallback without recording the selected provider and attempt outcome.
