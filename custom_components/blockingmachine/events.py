"""Server-Sent Events subscriber — push updates from a Blockingmachine hub.

Both hubs (the desktop app and the add-on) serve `/v1/events`, a keepalive'd
text/event-stream carrying named events:

    connected          — emitted on subscribe, no payload worth acting on
    remote_control     — {"action": "toggle_cosmetics"|"reload_rules"|..., ...}
    protection_changed — {"enabled": bool, "pausedUntil": ms|null}
    compile_completed  — compile stats after a rules compile finished
    rules_updated      — the published rule set changed
    quarantine_added   — the AI radar quarantined a domain (desktop hub)

Each SSE event is fired onto the Home Assistant bus as `blockingmachine_<name>`
with the JSON payload as event data, so an automation can trigger on
`blockingmachine_remote_control` (or any of the others) directly instead of
learning a wrapper schema. Events that change the polled `/v1/status` fields
also nudge the coordinator into an immediate refresh, so entity state follows
the push rather than the next 30s poll.

The stream is best-effort: any failure backs off and reconnects — the polling
coordinator remains the source of truth while the stream is down.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable

from aiohttp import ClientError, ClientTimeout

_LOGGER = logging.getLogger(__name__)

RECONNECT_MIN_S = 1.0
RECONNECT_MAX_S = 60.0
# Both servers emit a `: keepalive` comment every 25 s — a socket silent longer
# than this is dead, not merely quiet.
SOCK_READ_TIMEOUT_S = 60.0

EventCallback = Callable[[str, dict[str, Any]], Awaitable[None]]


class BlockingmachineEventStream:
    """Persistent `/v1/events` subscriber with bounded exponential reconnect."""

    def __init__(
        self,
        base_url: str,
        session: Any,
        headers: dict[str, str],
        on_event: EventCallback,
    ) -> None:
        """Initialize the stream (not connected until `start()`)."""
        self._base_url = base_url
        self._session = session
        self._headers = headers
        self._on_event = on_event
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()

    def start(self) -> None:
        """Begin consuming the stream in the background."""
        self._task = asyncio.create_task(self._run())

    async def async_stop(self) -> None:
        """Signal the loop to exit and wait for it."""
        self._stop_event.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _run(self) -> None:
        backoff = RECONNECT_MIN_S
        while not self._stop_event.is_set():
            try:
                await self._consume_once()
                # A clean close still means reconnect — the stream is the
                # deliverable, not the connection's natural lifespan.
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001 — a dead socket must never kill the loop
                _LOGGER.debug("Blockingmachine event stream interrupted: %s", err)
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=backoff)
            except asyncio.TimeoutError:
                pass
            backoff = min(backoff * 2, RECONNECT_MAX_S)

    async def _consume_once(self) -> None:
        url = f"{self._base_url}/v1/events"
        async with self._session.get(
            url,
            headers=self._headers,
            timeout=ClientTimeout(total=None, sock_read=SOCK_READ_TIMEOUT_S),
        ) as response:
            if response.status != 200:
                raise ClientError(f"/v1/events answered HTTP {response.status}")
            buffer = ""
            async for chunk in response.content.iter_any():
                buffer += chunk.decode("utf-8", errors="replace")
                buffer = buffer.replace("\r\n", "\n")
                while "\n\n" in buffer:
                    frame, buffer = buffer.split("\n\n", 1)
                    await self._dispatch_frame(frame)

    async def _dispatch_frame(self, frame: str) -> None:
        """Parse one SSE frame and hand the event to the callback."""
        name = "message"
        data_lines: list[str] = []
        for line in frame.split("\n"):
            if line.startswith(":"):
                continue  # keepalive comment
            field, _, value = line.partition(":")
            if field == "event":
                name = value.strip()
            elif field == "data":
                data_lines.append(value.lstrip(" "))
        if not data_lines:
            return
        raw = "\n".join(data_lines)
        try:
            data = json.loads(raw)
        except ValueError:
            data = {"raw": raw}
        if not isinstance(data, dict):
            data = {"value": data}
        await self._on_event(name, data)
