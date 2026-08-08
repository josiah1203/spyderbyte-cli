# Durable worker

This application wraps the durable workflow engine with replacement-safe start, scheduling, stop,
activity registration, and restart recovery operations. Activity handlers receive the attempt
number and an abort signal so cancellation reaches long-running local work. Hosted worker pools
remain a Phase 8 integration gate.
