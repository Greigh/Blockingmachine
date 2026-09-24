"""Switch platform for Blockingmachine."""
from __future__ import annotations

from typing import Any
import logging
from homeassistant.components.switch import SwitchEntity, SwitchEntityDescription
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import BlockingmachineDataUpdateCoordinator

_LOGGER = logging.getLogger(__name__)

SWITCH_DESCRIPTIONS: tuple[SwitchEntityDescription, ...] = (
    SwitchEntityDescription(
        key="protection_enabled",
        name="Network Protection",
        icon="mdi:shield-check",
    ),
    SwitchEntityDescription(
        key="ai_radar_enabled",
        name="AI Radar Sentinel",
        icon="mdi:radar",
    ),
    SwitchEntityDescription(
        key="browser_cosmetics",
        name="Browser Cosmetic Shield",
        icon="mdi:eye-off-outline",
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up Blockingmachine switches."""
    coordinator: BlockingmachineDataUpdateCoordinator = hass.data[DOMAIN][entry.entry_id]

    async_add_entities(
        BlockingmachineSwitch(coordinator, entry, description)
        for description in SWITCH_DESCRIPTIONS
    )


class BlockingmachineSwitch(CoordinatorEntity[BlockingmachineDataUpdateCoordinator], SwitchEntity):
    """Representation of a Blockingmachine switch entity."""

    def __init__(
        self,
        coordinator: BlockingmachineDataUpdateCoordinator,
        entry: ConfigEntry,
        description: SwitchEntityDescription,
    ) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self.entity_description = description
        self._attr_unique_id = f"{entry.entry_id}_{description.key}"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": f"Blockingmachine ({coordinator.host})",
            "manufacturer": "Greigh Studios",
            "model": "Blockingmachine Defense Hub",
            "sw_version": "1.0.0",
        }
        self._is_on = True

    @property
    def is_on(self) -> bool:
        """Return switch state."""
        data = self.coordinator.data
        if not data:
            return self._is_on

        if self.entity_description.key == "protection_enabled":
            return data.get("protection", {}).get("enabled", True)
        if self.entity_description.key == "ai_radar_enabled":
            return data.get("aiRadar", {}).get("enabled", False)
        if self.entity_description.key == "browser_cosmetics":
            return self._is_on

        return self._is_on

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Turn switch on."""
        self._is_on = True
        if self.entity_description.key == "browser_cosmetics":
            await self.coordinator.async_set_browser_cosmetics(True)
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Turn switch off."""
        self._is_on = False
        if self.entity_description.key == "browser_cosmetics":
            await self.coordinator.async_set_browser_cosmetics(False)
        self.async_write_ha_state()
