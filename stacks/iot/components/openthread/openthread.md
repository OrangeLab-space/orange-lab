# OpenThread Border Router

|              |                                                       |
| ------------ | ----------------------------------------------------- |
| Homepage     | https://openthread.io/                                |
| Source code  | https://github.com/openthread/ot-br-posix             |
| Docker Image | https://hub.docker.com/r/openthread/border-router     |
| REST API     | `http://openthread.openthread:8081`                   |

OpenThread Border Router (OTBR) owns the Thread radio and provides the REST API
used by Home Assistant. The adapter must run Thread RCP firmware and cannot be
used by Home Assistant directly at the same time.

## Installation

Example: connect a [Home Assistant Connect
ZBT-2](https://support.nabucasa.com/hc/en-us/sections/31591958711581-Installation).
The adapter must be plugged into the node where OTBR is scheduled. Use its stable
`/dev/serial/by-id/...` path and pin OTBR to that node:

```sh
pulumi config set openthread:enabled true
pulumi config set openthread:device /dev/serial/by-id/<zbt-2-device>
pulumi config set openthread:OT_INFRA_IF <lan-interface>
pulumi config set openthread:requiredNodeLabel "kubernetes.io/hostname=<node>"
pulumi up
```

| Setting                        | Description |
| ------------------------------ | ----------- |
| `openthread:device`            | Required. RCP adapter serial device on the pinned node. |
| `openthread:OT_INFRA_IF`       | Required. Host interface connected to the normal IP network (e.g. `enp3s0`). |
| `openthread:requiredNodeLabel` | Pin OTBR to the node with the adapter. |

Point `openthread:device` at the adapter's `/dev/serial/by-id/...` symlink (e.g.
`/dev/serial/by-id/usb-Nabu_Casa_ZBT-2_<serial>-if00`) so it always resolves to
the same device; `/dev/ttyACM*` is reassigned by USB enumeration order and can
change across reboots or when other adapters are added. The link runs at a fixed
460800 baud.

## Home Assistant integration

Configure the [OpenThread Border Router
integration](https://www.home-assistant.io/integrations/otbr) with the REST API
URL:

```sh
# From stacks/iot
pulumi stack output endpoints --json | jq -r '.cluster."openthread-rest"'
# http://openthread.openthread:8081
```

Home Assistant and OTBR must use the same node label so the REST service and USB
radio remain on the same node. The node and network must support IPv6 forwarding,
multicast, and mDNS.
