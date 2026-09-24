"""Binary sensor platform for Blockingmachine."""
from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
    BinarySensorEntityDescription,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import BlockingmachineDataUpdateCoordinator

BINARY_SENSOR_DESCRIPTIONS: tuple[BinarySensorEntityDescription, ...] = (
    BinarySensorEntityDescription(
        key="hub_status",
        name="Hub Status",
        device_class=BinarySensorDeviceClass.CONNECTIVITY,
    ),
    BinarySensorEntityDescription(
        key="threat_detected",
        name="AI Threat Alert",
        device_class=BinarySensorDeviceClass.PROBLEM,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the Blockingmachine binary sensors."""
    coordinator: BlockingmachineDataUpdateCoordinator = hass.data[DOMAIN][entry.entry_id]

    async_add_entities(
        BlockingmachineBinarySensor(coordinator, entry, description)
        for description in BINARY_SENSOR_DESCRIPTIONS
    )


class BlockingmachineBinarySensor(CoordinatorEntity[BlockingmachineDataUpdateCoordinator], BinarySensorEntity):
    """Representation of a Blockingmachine Binary Sensor."""

    def __init__(
        self,
        coordinator: BlockingmachineDataUpdateCoordinator,
        entry: ConfigEntry,
        description: BinarySensorEntityDescription,
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

    @property
    def is_on(self) -> bool:
        """Return true if the binary sensor is on."""
        data = self.coordinator.data
        if not data:
            return False

        if self.entity_description.key == "hub_status":
            return data.get("status") == "online"
        if self.entity_description.key == "threat_detected":
            threats = data.get("rules", {}).get("quarantinedThreats", 0)
            return threats > 0

        return False
