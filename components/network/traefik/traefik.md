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

## Dashboard SSO (Pocket ID)

Once configured, the dashboard requires Pocket ID sign-in and is limited to the Pocket ID `admin` group (see [Pocket ID](../../security/pocket/pocket.md)). Without it, the dashboard is reachable without authentication.

From the repo root, provision the OIDC client:

```sh
./components/network/traefik/pocket-traefik.sh

# Configure the OIDC client
pulumi config set traefik:auth pocket
pulumi config set traefik:auth/clientId <client-id>
pulumi config set traefik:auth/clientSecret <client-secret> --secret
pulumi up
```

Restrict the Pocket ID OIDC client to the groups that should access the dashboard. Group access is managed in Pocket ID under **Settings -> OIDC Clients**.

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
