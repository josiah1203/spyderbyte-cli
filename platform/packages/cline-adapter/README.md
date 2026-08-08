# Cline adapter

This is the only package allowed to import Cline SDK APIs. It maps the pinned SDK-like event and
runtime surface into the internal harness adapter contract; business code uses the internal
adapter contract instead. A real SDK binding remains an explicit integration choice.

The adapter compatibility suite covers streamed failures, normalized errors, cancellation races,
usage delivery, and gateway model selection. No other package imports the Cline SDK surface.
