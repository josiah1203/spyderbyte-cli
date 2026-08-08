"""Transitional boundary for approved Kimi-derived implementation primitives.

Product authority is forbidden in this package. Adapters implement Spyderbyte ports only.
"""

from spyderbyte_cli.adapters.kimi.checkpoint import JsonCheckpointCache
from spyderbyte_cli.adapters.kimi.context import (
    ExtractiveContextCompactor,
    RecencyContextWindowManager,
)
from spyderbyte_cli.adapters.kimi.process import BoundedProcessRuntime
from spyderbyte_cli.adapters.kimi.provider import KosongProviderTransportAdapter
from spyderbyte_cli.adapters.kimi.runtime import AgentRuntimeAdapter, InMemoryBackgroundExecution
from spyderbyte_cli.adapters.kimi.tools import ToolBrokerAdapter

__all__ = [
    "AgentRuntimeAdapter",
    "BoundedProcessRuntime",
    "ExtractiveContextCompactor",
    "InMemoryBackgroundExecution",
    "JsonCheckpointCache",
    "KosongProviderTransportAdapter",
    "RecencyContextWindowManager",
    "ToolBrokerAdapter",
]
