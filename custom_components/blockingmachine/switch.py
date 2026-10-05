"""Switch platform for Blockingmachine."""
from __future__ import annotations

from typing import Any
from homeassistant.components.switch import SwitchEntity, SwitchEntityDescription
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import BlockingmachineDataUpdateCoordinator

SWITCH_DESCRIPTIONS: tuple[SwitchEntityDescription, ...] = (
    SwitchEntityDescription(
        key="protection_enabled",
        name="Network Protection",
        icon="mdi:shield-check",
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
        # Cosmetic state lives in the connected browser extensions, not on the hub — the
        # POST broadcasts the intent over SSE and nothing reports the result back. The
        # honest HA model for "commanded but unverifiable" is assumed_state.
        if description.key == "browser_cosmetics":
            self._attr_assumed_state = True
        self._is_on = True

    @property
    def is_on(self) -> bool:
        """Return switch state."""
        data = self.coordinator.data
        if not data:
            return self._is_on

        if self.entity_description.key == "protection_enabled":
            enabled = data.get("protection", {}).get("enabled")
            return bool(enabled) if enabled is not None else self._is_on

        return self._is_on

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Turn switch on."""
        if self.entity_description.key == "protection_enabled":
            if await self.coordinator.async_set_protection(True):
                self._is_on = True
        elif self.entity_description.key == "browser_cosmetics":
            if await self.coordinator.async_set_browser_cosmetics(True):
                self._is_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Turn switch off."""
        if self.entity_description.key == "protection_enabled":
            if await self.coordinator.async_set_protection(False):
                self._is_on = False
        elif self.entity_description.key == "browser_cosmetics":
            if await self.coordinator.async_set_browser_cosmetics(False):
                self._is_on = False
        self.async_write_ha_state()
