# Traefik

|               |                                                                               |
| ------------- | ----------------------------------------------------------------------------- |
| Homepage      | https://traefik.io/                                                           |
| Helm chart    | https://github.com/traefik/traefik-helm-chart                                 |
| Values        | https://github.com/traefik/traefik-helm-chart/blob/master/traefik/values.yaml |
| Documentation | https://doc.traefik.io/traefik/                                               |
| Dashboard     | https://traefik.<domain>/                                                     |

Traefik is a cloud-native edge router that handles external HTTP/HTTPS traffic to cluster.

This provider is an alternative to [Tailscale](../tailscale/tailscale.md) and supports custom domains.

## Installation

```sh
# Required settings
pulumi config set orangelab:routingProvider traefik
pulumi config set orangelab:customDomain example.com
pulumi config set traefik:enabled true

# (Optional) Limit which nodes should run Traefik. By default all nodes
pulumi config set traefik:requiredNodeLabel kubernetes.io/hostname=<host>

# (Optional) Change dashboard hostname (default: traefik)
pulumi config set traefik:hostname traefik

pulumi up
```

## Dashboard

The Traefik dashboard is read-only - it exposes no secrets and no destructive actions - so it is **not** protected by Pocket ID. The dashboard is reachable without authentication.

It is still registered as a Pocket ID app so it appears in **My Apps** for the `admin` group. From the repo root, create the launcher client:

```sh
./components/network/traefik/pocket-traefik.sh

# Register the app with the printed values
pulumi config set traefik:auth pocket
pulumi config set traefik:auth/clientId <client-id>
pulumi config set traefik:auth/clientSecret <client-secret> --secret
pulumi up
```

## Public exposure

By default everything Traefik serves is private — reachable only over the
tailnet, because the wildcard DNS record points at a tailnet IP. An application
opts into internet-facing traffic with a single setting:

```sh
pulumi config set <app>:network/public true
pulumi up
```

That does three things: labels the application's namespace
`orangelab.space/public=true`, adds an HTTPRoute on the public gateway, and keeps
the private route untouched. Removing the setting reverses all three.

Three layers keep public and private apart:

1. **Ports.** Public terminates on `10443`, private on `443`. Expose the public
   listener with a router port forward or a VPS proxy — see
   [Public services](../../../docs/public-services.md).
2. **Gateway listener.** `traefik-gateway-public` only accepts routes from
   namespaces labelled `orangelab.space/public`, so an app cannot become public
   by accident.
3. **Separate route objects.** Each public route is a distinct HTTPRoute
   (`<app>-http-public`) from its private counterpart, so dropping public
   exposure cannot disturb internal routing.

TCP and UDP follow the same split. A port marked `public` in a publicly exposed
application gets a second LoadBalancer publishing it at `<port> + 10000`; see
[TCP and UDP ports](../../../docs/public-services.md#tcp-and-udp-ports) for the
forward band and the VPS alternative.

## Uninstall

To uninstall Traefik and clean up its custom resource definitions:

```sh
pulumi config set traefik:enabled false
pulumi up

# Remove Traefik CRDs
kubectl delete crd \
  ingressroutes.traefik.io \
  ingressroutetcps.traefik.io \
  ingressrouteudps.traefik.io \
  middlewares.traefik.io \
  middlewaretcps.traefik.io \
  serverstransports.traefik.io \
  serverstransporttcps.traefik.io \
  tlsoptions.traefik.io \
  tlsstores.traefik.io \
  traefikservices.traefik.io

# Remove Traefik Hub CRDs (not used)
kubectl delete crd \
  accesscontrolpolicies.hub.traefik.io \
  aiservices.hub.traefik.io \
  apiauths.hub.traefik.io \
  apibundles.hub.traefik.io \
  apicatalogitems.hub.traefik.io \
  apiplans.hub.traefik.io \
  apiportalauths.hub.traefik.io \
  apiportals.hub.traefik.io \
  apiratelimits.hub.traefik.io \
  apis.hub.traefik.io \
  apiversions.hub.traefik.io \
  managedapplications.hub.traefik.io \
  managedsubscriptions.hub.traefik.io

# Remove Gateway API CRDs managed by Traefik
kubectl delete crd \
  backendtlspolicies.gateway.networking.k8s.io \
  gatewayclasses.gateway.networking.k8s.io \
  gateways.gateway.networking.k8s.io \
  grpcroutes.gateway.networking.k8s.io \
  httproutes.gateway.networking.k8s.io \
  referencegrants.gateway.networking.k8s.io \
  tcproutes.gateway.networking.k8s.io \
  tlsroutes.gateway.networking.k8s.io \
  udproutes.gateway.networking.k8s.io \
  xbackendtrafficpolicies.gateway.networking.x-k8s.io \
  xlistenersets.gateway.networking.x-k8s.io \
  xmeshes.gateway.networking.x-k8s.io
```

To reinstall after cleanup:

```sh
pulumi config set traefik:enabled true
pulumi up -r
```

The `-r` flag refreshes and recreates any HTTPRoutes that were deleted with the CRDs.
