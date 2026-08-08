# Agent registry

`InMemoryAgentRegistry` validates versioned active registrations, supported contracts, child
capabilities, status transitions, and disable semantics. `HarnessRegistry` in
`@agentic-platform/harness-core` binds those version records to executable definitions and exact
harness/runtime compatibility before an invocation may start. Durable storage is an injectable
hosted composition concern.
