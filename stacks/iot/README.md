# IoT Stack

Components related to IoT (Internet of Things) sensors and home automation.

**Prerequisite**: Core stack must be deployed first (network, storage).

## Components

- [Home Assistant](./components/home-assistant/home-assistant.md) — Open source home automation platform that puts local control and privacy first
- [OpenThread Border Router](./components/openthread/openthread.md) — Thread border router for Home Assistant
- [Matter Server](./components/matter/matter.md) — Matter controller for Home Assistant
- [Mosquitto](./components/mosquitto/mosquitto.md) — MQTT broker for Home Assistant and Frigate
- [Frigate](./components/frigate/frigate.md) — Local NVR with realtime AI object detection for IP cameras

## Configure Applications

### Home Assistant

```sh
pulumi config set home-assistant:enabled true
pulumi up
```
