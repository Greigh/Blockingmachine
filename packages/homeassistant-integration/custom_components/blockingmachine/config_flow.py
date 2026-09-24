"""Config flow for Blockingmachine integration."""
from __future__ import annotations

import logging
from typing import Any

from aiohttp import ClientError, ClientTimeout
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import HomeAssistant, callback
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    DOMAIN,
    CONF_HOST,
    CONF_PORT,
    CONF_SCAN_INTERVAL,
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_SCAN_INTERVAL,
)

_LOGGER = logging.getLogger(__name__)


async def validate_input(hass: HomeAssistant, data: dict[str, Any]) -> dict[str, Any]:
    """Validate user input by attempting to reach the Blockingmachine hub."""
    host = data[CONF_HOST]
    port = data[CONF_PORT]
    session = async_get_clientsession(hass)
    url = f"http://{host}:{port}/v1/status"

    try:
        async with session.get(url, timeout=ClientTimeout(total=5)) as response:
            if response.status != 200:
                raise ValueError("cannot_connect")
            json_data = await response.json()
            return {"title": f"Blockingmachine ({host})", "info": json_data}
    except (ClientError, TimeoutError, Exception) as err:
        _LOGGER.warning("Connection test failed for %s: %s", url, err)
        raise ValueError("cannot_connect") from err


class BlockingmachineConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Blockingmachine."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Handle the initial step."""
        errors: dict[str, str] = {}

        if user_input is not None:
            try:
                info = await validate_input(self.hass, user_input)
                await self.async_set_unique_id(f"{user_input[CONF_HOST]}:{user_input[CONF_PORT]}")
                self._abort_if_unique_id_configured()
                return self.async_create_entry(title=info["title"], data=user_input)
            except ValueError:
                errors["base"] = "cannot_connect"
            except Exception:  # pylint: disable=broad-except
                _LOGGER.exception("Unexpected exception")
                errors["base"] = "unknown"

        schema = vol.Schema(
            {
                vol.Required(CONF_HOST, default=DEFAULT_HOST): str,
                vol.Required(CONF_PORT, default=DEFAULT_PORT): int,
            }
        )

        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: config_entries.ConfigEntry) -> config_entries.OptionsFlow:
        """Create the options flow."""
        return BlockingmachineOptionsFlowHandler(config_entry)


class BlockingmachineOptionsFlowHandler(config_entries.OptionsFlow):
    """Handle options flow for Blockingmachine."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        """Initialize options flow."""
        self.config_entry = config_entry

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        """Manage options."""
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        schema = vol.Schema(
            {
                vol.Optional(
                    CONF_SCAN_INTERVAL,
                    default=self.config_entry.options.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL),
                ): int,
            }
        )

        return self.async_show_form(step_id="init", data_schema=schema)
