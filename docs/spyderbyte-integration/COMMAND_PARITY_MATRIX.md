# Command parity matrix (Wave 5 / Q6)

Oracle: TypeScript TUI help in `platform/apps/tui/src/index.ts`.
Client: Python `spyderbyte` CLI in `src/spyderbyte_cli/cli.py`.

| Capability | TypeScript TUI | Python CLI | Status |
| --- | --- | --- | --- |
| Prompt / chat turn | default prompt | default prompt | Implemented |
| Daemon lifecycle | local API start | `daemon` | Implemented |
| ACP | ACP host paths | `acp` | Implemented |
| Native resources | resource surfaces via API | `resource` | Implemented (Wave 4) |
| Organization list/show | `org [list\|show]` | `org [list\|show]` | Implemented |
| Users / members | `users` | `users` | Implemented |
| Policies | `policies` | `policies` | Implemented |
| Budgets + usage | `budgets` | `budgets` | Implemented |
| Approvals | `approvals` | `approvals` | Implemented |
| Audit verify/read | `audit` | `audit` | Implemented |
| Workspace facets | `workspace context\|intake\|...` | `workspace <facet\|status>` | Implemented |
| Onboarding | `onboarding status\|choose` | `onboarding status\|choose` | Implemented |
| License status | license/settings surfaces | `license` | Implemented |
| Full SSO/SCIM admin | enterprise TUI paths | — | Deferred (Wave 7 / Section 13) |
| Signed cloud login UX | hosted identity flows | token/`--token` only | Partial (H1 light) |
| Interactive TUI widgets | full Ink TUI | JSON/headless CLI | Deliberate rich-client handoff |
