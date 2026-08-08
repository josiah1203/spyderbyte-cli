# Spyderbyte JupyterLab extension bridge

This package is the small, dependency-free boundary used by a JupyterLab host. It keeps project,
notebook, runtime, environment, and model context in the host, and routes cell execution,
artifact publication, runtime discovery, and lineage through the Spyderbyte API. The API token is
provided by the host as a short-lived callback and is never persisted by this package.

`createJupyterLabPlugin` returns the structural plugin surface needed by a JupyterLab build. The
host can adapt `JupyterLabLike` to its installed JupyterLab version without coupling the daemon to
JupyterLab's frontend package versions. The bridge also exposes `list-experiment-runs` and
`compare-experiments`, returning the same immutable comparison records used by the browser,
including curves, distributions, confusion matrices, explainability, and artifact lineage.
