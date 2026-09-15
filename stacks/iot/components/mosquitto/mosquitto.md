# Mosquitto

|               |                                                        |
| ------------- | ------------------------------------------------------ |
| Homepage      | https://mosquitto.org/                                 |
| Source code   | https://github.com/eclipse-mosquitto/mosquitto         |
| Documentation | https://mosquitto.org/documentation/                   |
| Configuration | https://mosquitto.org/man/mosquitto-conf-5.html        |
| Docker Image  | https://hub.docker.com/_/eclipse-mosquitto             |
| Endpoints     | `mqtt://mosquitto.mosquitto:1883` (cluster-internal)   |

Eclipse Mosquitto is an MQTT broker used to connect [Frigate](../frigate/frigate.md)
and [Home Assistant](../home-assistant/home-assistant.md). The broker is only
reachable inside the cluster and requires a username and password.

## Installation

```sh
cd stacks/iot

pulumi config set mosquitto:enabled true

# Required: generate and store the broker password before the first deploy
pulumi config set --secret mosquitto:password "$(openssl rand -base64 24)"

pulumi up
```

## Credentials

The broker user defaults to `mqtt`; change it with `mosquitto:user`. The password
is required and must be stable, so every consumer (Frigate, Home Assistant) can
authenticate. Retrieve it with:

```sh
pulumi stack output mqtt --show-secrets --json | jq -r '.password'
```

## Wiring to Home Assistant

Add the **MQTT** integration in Home Assistant with:

| Setting  | Value                    |
| -------- | ------------------------ |
| Broker   | `mosquitto.mosquitto`    |
| Port     | `1883`                   |
| Username | `mosquitto:user` (default `mqtt`) |
| Password | value from `mqtt` output |

Frigate connects automatically when both components are enabled.

## Manual and debugging

The broker's password file is generated at startup by the `init-password` init
container, which hashes `mosquitto:password` with `mosquitto_passwd` and writes
`/mosquitto/data/passwd`. The `fix-volume-permissions` init container then owns
the data volume. To debug startup or authentication:

```sh
kubectl logs -n mosquitto deploy/mosquitto -c init-password
kubectl logs -n mosquitto deploy/mosquitto
```

To change the password, update `mosquitto:password` (and any consumer that uses
it) and `pulumi up`.
