# Phase 1 shell file review

Date: 2026-08-07

The Phase 0 snapshot is the source identity recorded in UPSTREAM_CODEX.md:

    sha256:57aee212fcbe89fd7bb7e2ddb24cd3ef60e92796daf808b970031ab9a3dc4eba

The reviewed upstream files are all classified KEEP/ADAPT in the migration matrix. The review
approved only terminal presentation mechanics. No upstream file is copied into the build. The
Spyderbyte shell reimplements the approved behavior in the isolated apps/spyderbyte-shell Rust
boundary so Codex agent, account, cloud, telemetry, protocol, persistence, and provider behavior
cannot enter the product.

| Upstream file                                     | Snapshot SHA-256                                                 | Review decision | Spyderbyte treatment                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| codex-rs/tui/src/tui.rs                           | 58d9475459c546da4e35fbe0d017274080e0f2558c752ca495e766628309f2cf | ADAPT           | Alternate-screen lifecycle and terminal restoration reimplemented in terminal.rs.                             |
| codex-rs/tui/src/tui/event_stream.rs              | 7a7072be84c99024685a75955fca103da6eb055523fadb8d4005e81c96cbb794 | ADAPT           | Key-event ownership and redraw loop reimplemented without Codex event types.                                  |
| codex-rs/tui/src/tui/screen_size.rs               | 17b5cd868da4da40c8e3180d3ac44f06d93e93629dc96f7ca8f263a06114e18a | ADAPT           | Resize sampling and narrow-terminal fallback reimplemented with terminal-size fallback.                       |
| codex-rs/tui/src/custom_terminal.rs               | efe07723e762dc8aa2a843277a2ef638e4ef422e4685130299f2dd4d9630df5d | ADAPT           | Terminal frame ownership was retained as a boundary principle; no Ratatui internals imported.                 |
| codex-rs/tui/src/public_widgets/composer_input.rs | b131ff63ac6a45987f1990a45e80512f283e837e95faafb5b996af09c64c4d81 | ADAPT           | Multiline composition, submit, and paste-safe draft state reimplemented in ShellState.                        |
| codex-rs/tui/src/markdown_render.rs               | 8c0d0bdb8d525542758e1651a467cd59b6b2c89e082df3061cdc4362d83d7c8d | ADAPT           | Neutral headings and fenced code presentation reimplemented without transcript authority.                     |
| codex-rs/tui/src/diff_render.rs                   | da5a3158917d9b6bbd24918ef25fbbd132dfb164b492440ae717da6a695426b6 | ADAPT           | Added/removed line presentation is owned by ShellEvent::Diff.                                                 |
| codex-rs/tui/src/frames.rs                        | 2d8e9bd639b8ab924156bc6316734d15c6944d2d7c5e28a559d7d9bdc365e936 | REMOVE          | Animation variants include inherited product branding; no frames were retained.                               |
| codex-rs/ansi-escape/src/lib.rs                   | 4ee1d3709d986a783ba479f6df4b11033a5c26645f51795c50311d7e16642e0c | ADAPT           | ANSI parsing was not imported because it requires Ratatui and upstream logging; plain text is bounded safely. |

## Boundary checks

- The shell Cargo manifest has no Codex, provider, account, cloud, telemetry, or Spyderbyte domain
  dependencies.
- The shell has no credential, provider selection, policy, approval decision, Run persistence, or
  agent orchestration state.
- The TypeScript command delegates only its interactive no-argument path; noninteractive commands
  continue to use the existing typed client/API services.
- Ctrl+C restores raw terminal settings and the alternate screen; non-TTY and Windows paths use
  a plain-mode fallback.
- Shell tests cover branded help, wide and narrow rendering, multiline input, pane navigation,
  bounded output, plan/approval/diff/log event rendering, and authority isolation.
- Selected upstream shell-mechanics regressions pass: `tui::` (45), `custom_terminal::` (10),
  `markdown_render::markdown_render_tests::` (106), and `diff_render::` (50). The full upstream
  library suite has an unrelated product-domain stack-overflow failure and is not imported into
  the Spyderbyte gate.

## License treatment

No upstream source file is included in the build, so no modified-file notice is required for the
new shell implementation. The upstream Apache-2.0 and Ratatui MIT notices remain recorded in
UPSTREAM_CODEX.md and the source checkout NOTICE. If a future review approves copying any upstream
file, the file, license notice, dependency record, and modified-file notice must be added before
the build is changed.
