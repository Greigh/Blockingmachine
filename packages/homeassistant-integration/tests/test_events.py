"""Unit tests for the /v1/events SSE subscriber with mocked aiohttp."""
import asyncio
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Provide lightweight mock for aiohttp if not present in environment
if "aiohttp" not in sys.modules:
    aiohttp_mock = types.ModuleType("aiohttp")

    class ClientError(Exception):
        pass

    class ClientTimeout:
        def __init__(self, *args, **kwargs):
            pass

    aiohttp_mock.ClientError = ClientError
    aiohttp_mock.ClientTimeout = ClientTimeout
    sys.modules["aiohttp"] = aiohttp_mock

# Provide lightweight mock for homeassistant package hierarchy if not present —
# importing `custom_components.blockingmachine.events` executes the package
# `__init__`, which imports homeassistant itself; without these mocks the module
# load would depend on another test file's injection order.
if "homeassistant" not in sys.modules:
    from unittest.mock import MagicMock

    ha = types.ModuleType("homeassistant")
    ha.__path__ = []
    sys.modules["homeassistant"] = ha

    ha_const = types.ModuleType("homeassistant.const")
    ha_const.Platform = MagicMock()
    sys.modules["homeassistant.const"] = ha_const

    ha_core = types.ModuleType("homeassistant.core")
    ha_core.HomeAssistant = MagicMock()
    ha_core.ServiceCall = MagicMock()
    ha_core.callback = lambda fn: fn
    sys.modules["homeassistant.core"] = ha_core

    ha_config = types.ModuleType("homeassistant.config_entries")
    ha_config.ConfigEntry = MagicMock()
    sys.modules["homeassistant.config_entries"] = ha_config

    ha_exceptions = types.ModuleType("homeassistant.exceptions")
    ha_exceptions.ConfigEntryAuthFailed = type("ConfigEntryAuthFailed", (Exception,), {})
    sys.modules["homeassistant.exceptions"] = ha_exceptions

    ha_helpers = types.ModuleType("homeassistant.helpers")
    ha_helpers.__path__ = []
    sys.modules["homeassistant.helpers"] = ha_helpers

    ha_aiohttp = types.ModuleType("homeassistant.helpers.aiohttp_client")
    ha_aiohttp.async_get_clientsession = MagicMock()
    sys.modules["homeassistant.helpers.aiohttp_client"] = ha_aiohttp

    class MockDataUpdateCoordinator:
        def __class_getitem__(cls, item):
            return cls

        def __init__(self, hass, logger, name, update_interval):
            pass

        async def async_request_refresh(self):
            pass

    ha_coordinator = types.ModuleType("homeassistant.helpers.update_coordinator")
    ha_coordinator.DataUpdateCoordinator = MockDataUpdateCoordinator
    ha_coordinator.UpdateFailed = type("UpdateFailed", (Exception,), {})
    sys.modules["homeassistant.helpers.update_coordinator"] = ha_coordinator

from custom_components.blockingmachine.events import BlockingmachineEventStream


class FakeContent:
    """Async-iterable SSE body."""

    def __init__(self, chunks):
        self._chunks = chunks

    async def iter_any(self):
        for chunk in self._chunks:
            yield chunk


class FakeResponse:
    def __init__(self, status=200, chunks=()):
        self.status = status
        self.content = FakeContent(chunks)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeSession:
    def __init__(self, response):
        self._response = response
        self.requested = []

    def get(self, url, headers=None, timeout=None):
        self.requested.append((url, headers))
        return self._response


def run(coro):
    return asyncio.run(coro)


class EventStreamTests(unittest.TestCase):
    def test_parses_named_event_with_json_payload(self):
        seen = []

        async def on_event(name, data):
            seen.append((name, data))

        body = b'event: remote_control\ndata: {"action":"reload_rules"}\n\n'
        stream = BlockingmachineEventStream("http://h:1", FakeSession(FakeResponse(chunks=[body])), {}, on_event)
        run(stream._consume_once())
        self.assertEqual(seen, [("remote_control", {"action": "reload_rules"})])

    def test_frames_split_across_chunk_boundaries_and_keepalives(self):
        seen = []

        async def on_event(name, data):
            seen.append((name, data))

        chunks = [
            b": keepalive\n\n",
            b"event: protection_changed\r\n",
            b'data: {"enabled":fal',
            b'se}\r\n\r\nevent: compile_completed\ndata: {"total":30}\n\n',
        ]
        stream = BlockingmachineEventStream("http://h:1", FakeSession(FakeResponse(chunks=chunks)), {}, on_event)
        run(stream._consume_once())
        self.assertEqual(
            seen,
            [
                ("protection_changed", {"enabled": False}),
                ("compile_completed", {"total": 30}),
            ],
        )

    def test_bearer_token_is_sent(self):
        session = FakeSession(FakeResponse(chunks=[]))
        stream = BlockingmachineEventStream(
            "http://h:1", session, {"Authorization": "Bearer tok"}, lambda n, d: asyncio.sleep(0)
        )
        run(stream._consume_once())
        self.assertEqual(session.requested[0][1]["Authorization"], "Bearer tok")
        self.assertTrue(session.requested[0][0].endswith("/v1/events"))

    def test_non_200_raises_client_error(self):
        stream = BlockingmachineEventStream(
            "http://h:1", FakeSession(FakeResponse(status=401)), {}, lambda n, d: asyncio.sleep(0)
        )
        with self.assertRaises(Exception):
            run(stream._consume_once())

    def test_non_dict_payload_is_wrapped_not_dropped(self):
        seen = []

        async def on_event(name, data):
            seen.append((name, data))

        body = b"event: ping\ndata: 42\n\n"
        stream = BlockingmachineEventStream("http://h:1", FakeSession(FakeResponse(chunks=[body])), {}, on_event)
        run(stream._consume_once())
        self.assertEqual(seen, [("ping", {"value": 42})])

    def test_stop_cancels_a_running_stream(self):
        async def on_event(name, data):
            pass

        async def start_and_stop():
            stream = BlockingmachineEventStream(
                "http://h:1", FakeSession(FakeResponse(chunks=[])), {}, on_event
            )
            stream.start()
            await stream.async_stop()
            return stream

        stream = run(start_and_stop())
        self.assertTrue(stream._task.cancelled() or stream._task.done())


if __name__ == "__main__":
    unittest.main()
