"""Button platform for Blockingmachine."""
from __future__ import annotations

import logging
from homeassistant.components.button import ButtonEntity, ButtonEntityDescription
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import BlockingmachineDataUpdateCoordinator

_LOGGER = logging.getLogger(__name__)

BUTTON_DESCRIPTIONS: tuple[ButtonEntityDescription, ...] = (
    ButtonEntityDescription(
        key="compile_rules",
        name="Compile Rules Now",
        icon="mdi:refresh-auto",
    ),
    ButtonEntityDescription(
        key="refresh_status",
        name="Refresh Hub Status",
        icon="mdi:sync",
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up Blockingmachine buttons."""
    coordinator: BlockingmachineDataUpdateCoordinator = hass.data[DOMAIN][entry.entry_id]

    async_add_entities(
        BlockingmachineButton(coordinator, entry, description)
        for description in BUTTON_DESCRIPTIONS
    )


class BlockingmachineButton(CoordinatorEntity[BlockingmachineDataUpdateCoordinator], ButtonEntity):
    """Representation of a Blockingmachine action button."""

    def __init__(
        self,
        coordinator: BlockingmachineDataUpdateCoordinator,
        entry: ConfigEntry,
        description: ButtonEntityDescription,
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

    async def async_press(self) -> None:
        """Handle button press."""
        if self.entity_description.key == "compile_rules":
            _LOGGER.info("Triggering compile rules via Home Assistant button")
            await self.coordinator.async_compile_rules()
        elif self.entity_description.key == "refresh_status":
            await self.coordinator.async_request_refresh()
