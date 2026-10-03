"""Event log for objects and conversation turns. Writes happen off the voice loop, in the background.

Events go to a local JSONL file that the dashboard reads.
"""

import asyncio
import json
import logging
from datetime import datetime, timezone

from integrations import config

log = logging.getLogger(__name__)

class _BackgroundLogger:
    """Fire-and-forget logging that never blocks or breaks a conversation."""

    name = "base"

    def __init__(self) -> None:
        self._tasks: set[asyncio.Task] = set()

    def log(self, session_id: str, kind: str, object_name: str, payload: dict) -> None:
        event = {
            "ts": datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
            "session_id": session_id,
            "kind": kind,
            "object_name": object_name,
            "payload": payload,
        }
        task = asyncio.create_task(self._safe_write(event))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _safe_write(self, event: dict) -> None:
        try:
            await asyncio.to_thread(self._write, event)
        except Exception:
            log.exception("memory write failed (%s)", self.name)

    def _write(self, event: dict) -> None:
        raise NotImplementedError


class LocalMemory(_BackgroundLogger):
    name = "local"

    def _write(self, event: dict) -> None:
        config.LOCAL_EVENTS_PATH.parent.mkdir(parents=True, exist_ok=True)
        with config.LOCAL_EVENTS_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event) + "\n")


def make_memory():
    return LocalMemory()
