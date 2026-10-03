"""Event log for objects and conversation turns. Writes happen off the voice loop, in the background.

Snowflake when configured, otherwise a local JSONL file. The dashboard reads either one.
"""

import asyncio
import json
import logging
from datetime import datetime, timezone

from integrations import config

log = logging.getLogger(__name__)

CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS EVENTS (
    TS TIMESTAMP_NTZ,
    SESSION_ID STRING,
    KIND STRING,
    OBJECT_NAME STRING,
    PAYLOAD VARIANT
)"""


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


class SnowflakeMemory(_BackgroundLogger):
    name = "snowflake"

    def __init__(self) -> None:
        super().__init__()
        self._conn = None

    def _connection(self):
        if self._conn is None:
            import snowflake.connector

            params = {k: v for k, v in config.SNOWFLAKE.items() if v}
            self._conn = snowflake.connector.connect(**params)
            self._conn.cursor().execute(CREATE_TABLE)
        return self._conn

    def _write(self, event: dict) -> None:
        self._connection().cursor().execute(
            "INSERT INTO EVENTS (TS, SESSION_ID, KIND, OBJECT_NAME, PAYLOAD) "
            "SELECT %s, %s, %s, %s, PARSE_JSON(%s)",
            (event["ts"], event["session_id"], event["kind"], event["object_name"], json.dumps(event["payload"])),
        )


def make_memory():
    if config.use_snowflake():
        return SnowflakeMemory()
    log.warning("Snowflake not configured: logging events to %s", config.LOCAL_EVENTS_PATH)
    return LocalMemory()
