# Spyderbyte shell

This package owns the presentation-only spyderbyte terminal host. It contains terminal lifecycle,
alternate-screen handling, keyboard input, multiline composition, adaptive panes, scrolling,
markdown/code-block presentation, progress, approval presentation, and diff presentation.

It does not contain an agent, provider, credential, cloud, policy, Run, or persistence authority.
The TypeScript launcher starts the local daemon and owns the typed `SpyderbyteClient` boundary;
the shell connects to that launcher over an authenticated loopback bridge. Requests are submitted
through `sendMessage`, and Run status, plan, log, reconnect, cancellation, and output-delta
events are rendered as they arrive from the same subscription/replay stream used by the CLI.

Build and run it from the repository root:

    pnpm --filter @agentic-platform/spyderbyte-shell build
    apps/spyderbyte-shell/target/debug/spyderbyte

The TypeScript `apps/tui` launcher delegates its no-argument interactive path to this binary when
the binary is present. Use `spyderbyte --project <projectId>` to bind the rich shell to a project.
Set `SPYDERBYTE_SHELL_PLAIN=1` to use the transitional line-oriented client instead.

The shell is independently testable with:

    pnpm --filter @agentic-platform/spyderbyte-shell test
