# Tailscale Kubernetes-operator

|                |                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------ |
| Homepage       | https://tailscale.com/kb/1236/kubernetes-operator                                          |
| Versions       | https://tailscale.com/changelog                                                            |
| Default values | https://github.com/tailscale/tailscale/blob/main/cmd/k8s-operator/deploy/chart/values.yaml |
| Endpoints      | `https://k8s.<tsnet>.ts.net/`                                                              |

The operator manages cluster ingress endpoints on Tailnet as well as adds Tailscale authenticated Kubernetes API endpoint.

## When to Use

- **Use Tailscale** when you don't have a custom domain or public IP, and want secure access via Tailscale mesh VPN
- **Optional** when using [Traefik](../traefik/traefik.md) with a custom domain - TCP services will use k3s ServiceLB instead

When custom domain is configured, Traefik replaces Tailscale for application endpoints.

## Public exposure with Funnel

When Tailscale is the routing provider, `<app>:network/public: true` enables
[Tailscale Funnel](https://tailscale.com/kb/1223/tailscale-funnel) on that app's
ingress by adding the `tailscale.com/funnel: "true"` annotation.

Funnel does **not** replace the `ts.net` name. The app is still served at
`<app>.<tailnet>.ts.net` inside the tailnet; Funnel additionally publishes that
same name to the public internet through Tailscale's relay servers. One hostname,
reachable both ways, and your home IP stays hidden.

### Requirements

Funnel needs a node attribute in the tailnet policy file granting it to the
operator's tag — the `tag:orangelab` this component applies by default:

```json
"nodeAttrs": [
  { "target": ["tag:orangelab"], "attr": ["funnel"] },
]
```

`autogroup:member` does not cover tagged devices, so granting it to members
alone is not enough.

### Limitations

- Only ports **443**, **8443** and **10000**, HTTPS only.
- Traffic is relayed through Tailscale, which cannot read it but does see
  connection metadata.
- Serve and Funnel cannot share a port: whichever ran last wins, so a port
  configured for Serve becomes fully private again.

With Traefik as the routing provider, `network/public` is handled by Traefik's
public gateway instead and Funnel is not used.

## Installation

### DNS/HTTPS

Enable MagicDNS and HTTPS certificates on https://login.tailscale.com/admin/dns

### Tags

Add `orangelab` tag to your Tailnet ACLs (https://login.tailscale.com/admin/acls/file):

```json
"tagOwners": {
    "tag:orangelab":   [],
}
```

### OAuth token

Create Tailscale OAuth token for OrangeLab (https://login.tailscale.com/admin/settings/trust-credentials)

<img src="./tailscale-oauth.png" alt="New Tailscale OAuth token screen" style="width:50%;border:1px solid orange;margin-bottom:1em;" />

Make sure token has write permissions for `Devices/Core` and `Keys/Auth keys`.

Assign `orangelab` tag as well.

<img src="./tailscale-oauth-devices.png" alt="New Tailscale OAuth devices permission" style="width:50%;border:1px solid orange;margin-bottom:1em;" />

You can find Tailnet DNS name at https://login.tailscale.com/admin/dns

```sh
pulumi config set orangelab:routingProvider tailscale
pulumi config set tailscale:tailnet <*.ts.net*>
pulumi config set tailscale:oauthClientId <OAUTH_CLIENT_ID>
pulumi config set tailscale:oauthClientSecret <OAUTH_CLIENT_SECRET> --secret
pulumi config set tailscale:enabled true

pulumi up
```

## Kubernetes API access (optional)

After deploying the operator, you can use new endpoint for Kubernetes API, `https://k8s.<tailnet>.ts.net` for non-admin users.

Add this grant to your Tailscale ACLs:

```json
"grants": [{
    "src": ["autogroup:member"],
    "dst": ["tag:orangelab"],
    "app": {
        "tailscale.com/cap/kubernetes": [{
            "impersonate": {
                "groups": ["orangelab:users"],
            },
        }],
    },
}]
```

To be able to connect to the cluster as a read-only user, generate `~/.kube/config` with:

```sh
tailscale configure kubeconfig k8s
```

## Uninstall

```sh
pulumi config set tailscale:enabled false
pulumi up

kubectl delete crd \
  connectors.tailscale.com \
  dnsconfigs.tailscale.com \
  proxyclasses.tailscale.com \
  proxygroups.tailscale.com \
  recorders.tailscale.com

kubectl delete clusterrole \
  tailscale-auth-proxy \
  tailscale-operator

kubectl delete clusterrolebinding \
  tailscale-auth-proxy \
  tailscale-operator

# This will remove all existing ingress instances using tailscale class
# They will be recreated once tailscale-operator is installed again
kubectl delete ingressclass tailscale
```

**Important:** Remove any leftover nodes with `tag:orangelab` at https://login.tailscale.com/admin/machines, otherwise Tailscale will create `<app>-1` entries and connections will fail.
