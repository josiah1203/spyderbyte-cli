# Signed local editor bridges

Release packaging copies the signed bridge executables configured by
`SPYDERBYTE_PREMIERE_BRIDGE_BIN`, `SPYDERBYTE_RESOLVE_BRIDGE_BIN`,
`SPYDERBYTE_FINAL_CUT_BRIDGE_BIN`, and `SPYDERBYTE_MEDIA_BRIDGE_BIN` into this directory.
Each bridge speaks the JSON-over-stdio contract documented by the provider runtime and exposes
only explicit project, timeline, render, export, and publish operations.
