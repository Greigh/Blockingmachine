"""Unit tests for coordinator data fetching and compile commands with mocked HA."""
import asyncio
import os
import sys
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import types

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

# Provide lightweight mock for homeassistant package hierarchy if not present in environment
if "homeassistant" not in sys.modules:

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

    ha_flow = types.ModuleType("homeassistant.data_entry_flow")
    sys.modules["homeassistant.data_entry_flow"] = ha_flow

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
            self.hass = hass
            self.logger = logger
            self.name = name
            self.update_interval = update_interval
        async def async_request_refresh(self):
            pass

    class MockUpdateFailed(Exception):
        pass

    ha_coordinator = types.ModuleType("homeassistant.helpers.update_coordinator")
    ha_coordinator.DataUpdateCoordinator = MockDataUpdateCoordinator
    ha_coordinator.UpdateFailed = MockUpdateFailed
    sys.modules["homeassistant.helpers.update_coordinator"] = ha_coordinator

# Now import the coordinator
from custom_components.blockingmachine.coordinator import BlockingmachineDataUpdateCoordinator

class TestCoordinatorLogic(unittest.TestCase):
    def setUp(self):
        self.mock_hass = MagicMock()
        self.coordinator = BlockingmachineDataUpdateCoordinator(
            self.mock_hass, host="127.0.0.1", port=9191, scan_interval=30
        )

    def test_initialization(self):
        self.assertEqual(self.coordinator.host, "127.0.0.1")
        self.assertEqual(self.coordinator.port, 9191)
        self.assertEqual(self.coordinator.base_url, "http://127.0.0.1:9191")

    def test_async_update_data_success(self):
        async def run_test():
            mock_payload = {
                "status": "online",
                "rules": {"total": 125000, "dns": 120000, "browser": 122000},
                "uptimeSeconds": 3600
            }

            mock_response = AsyncMock()
            mock_response.status = 200
            mock_response.json = AsyncMock(return_value=mock_payload)

            mock_cm = AsyncMock()
            mock_cm.__aenter__.return_value = mock_response

            self.coordinator.session = MagicMock()
            self.coordinator.session.get.return_value = mock_cm

            data = await self.coordinator._async_update_data()
            self.assertEqual(data["status"], "online")
            self.assertEqual(data["rules"]["total"], 125000)

        asyncio.run(run_test())

    def test_async_compile_rules_success(self):
        async def run_test():
            mock_response = AsyncMock()
            mock_response.status = 200

            mock_cm = AsyncMock()
            mock_cm.__aenter__.return_value = mock_response

            self.coordinator.session = MagicMock()
            self.coordinator.session.post.return_value = mock_cm

            success = await self.coordinator.async_compile_rules()
            self.assertTrue(success)

        asyncio.run(run_test())

    def test_async_check_domain(self):
        async def run_test():
            mock_response = AsyncMock()
            mock_response.status = 200
            mock_response.json = AsyncMock(return_value={"domain": "tracker.ad.com", "blocked": True})

            mock_cm = AsyncMock()
            mock_cm.__aenter__.return_value = mock_response

            self.coordinator.session = MagicMock()
            self.coordinator.session.get.return_value = mock_cm

            res = await self.coordinator.async_check_domain("tracker.ad.com")
            self.assertEqual(res["domain"], "tracker.ad.com")
            self.assertTrue(res["blocked"])

        asyncio.run(run_test())

if __name__ == "__main__":
    unittest.main()
