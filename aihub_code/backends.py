"""Pick the backend stream function for a model (shared by the CLI and the bridge)."""
from __future__ import annotations

from typing import Callable


def resolve_stream_fn(stream_model: str, backend: str) -> Callable:
    if backend == "api" or stream_model.startswith("api://"):
        from aihub.api_client import chat_stream
        return chat_stream
    if backend == "llamacpp":
        from aihub.llamacpp_client import chat_stream
        return chat_stream
    from aihub.ollama_client import chat_stream
    return chat_stream
