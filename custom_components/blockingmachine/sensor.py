"""Sensor platform for Blockingmachine."""
from __future__ import annotations

from typing import Any
from homeassistant.components.sensor import (
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import BlockingmachineDataUpdateCoordinator

SENSOR_DESCRIPTIONS: tuple[SensorEntityDescription, ...] = (
    SensorEntityDescription(
        key="total_rules",
        name="Total Active Rules",
        icon="mdi:shield-check",
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="dns_rules",
        name="DNS Rules",
        icon="mdi:dns",
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="browser_rules",
        name="Browser Rules",
        icon="mdi:web",
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="quarantined_threats",
        name="Quarantined Threats",
        icon="mdi:shield-alert",
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="browser_trackers_blocked",
        name="Browser Trackers Blocked",
        icon="mdi:shield-bug",
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="browser_elements_hidden",
        name="Browser Elements Hidden",
        icon="mdi:eye-off",
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="last_compile",
        name="Last Compilation",
        icon="mdi:clock-check-outline",
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the Blockingmachine sensors."""
    coordinator: BlockingmachineDataUpdateCoordinator = hass.data[DOMAIN][entry.entry_id]

    async_add_entities(
        BlockingmachineSensor(coordinator, entry, description)
        for description in SENSOR_DESCRIPTIONS
    )


class BlockingmachineSensor(CoordinatorEntity[BlockingmachineDataUpdateCoordinator], SensorEntity):
    """Representation of a Blockingmachine Sensor."""

    def __init__(
        self,
        coordinator: BlockingmachineDataUpdateCoordinator,
        entry: ConfigEntry,
        description: SensorEntityDescription,
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
    def native_value(self) -> Any:
        """Return the state of the sensor."""
        data = self.coordinator.data
        if not data:
            return None

        rules = data.get("rules", {})
        browser = data.get("browserTelemetry", {})
        if self.entity_description.key == "total_rules":
            return rules.get("total", 0)
        if self.entity_description.key == "dns_rules":
            return rules.get("dns", 0)
        if self.entity_description.key == "browser_rules":
            return rules.get("browser", 0)
        if self.entity_description.key == "quarantined_threats":
            return rules.get("quarantinedThreats", 0)
        if self.entity_description.key == "browser_trackers_blocked":
            return browser.get("trackersBlocked", 0)
        if self.entity_description.key == "browser_elements_hidden":
            return browser.get("elementsHidden", 0)
        if self.entity_description.key == "last_compile":
            return data.get("lastCompile")

        return None
