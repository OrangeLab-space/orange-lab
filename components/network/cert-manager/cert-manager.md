# Cert-manager

|                         |                                                                |
| ----------------------- | -------------------------------------------------------------- |
| Homepage                | https://cert-manager.io/                                       |
| Helm chart              | https://artifacthub.io/packages/helm/cert-manager/cert-manager |
| Supported DNS providers | https://cert-manager.io/docs/configuration/acme/dns01/         |

Cert-manager is a Kubernetes certificate management controller that automates the management and issuance of TLS certificates.

It is required by [Traefik](../traefik/traefik.md) and by the AMD GPU operator.

```sh
pulumi config set cert-manager:enabled true
pulumi up
```

## Custom domains

Cert-manager can be used to manage SSL certificates for your custom domain using Let's Encrypt.

You will need to create a `ClusterIssuer` depending on your DNS provider.

Currently only DNS challenges are supported, as HTTP require a public endpoint and at this point only private ones on Tailnet can be created.

You can find supported providers at https://cert-manager.io/docs/configuration/acme/dns01/

### CloudFlare

For example, to use CloudFlare you need to create an API token (https://dash.cloudflare.com/profile/api-tokens) then create `ClusterIssuer` resources using this token and DNS solver.

Create both staging and production issuers at once (staging first for testing, production for actual use):

```sh
apiVersion: v1
kind: Secret
metadata:
    name: cloudflare-api-secret
    namespace: cert-manager
type: Opaque
stringData:
    api-token: <cloudflare_api_token>
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
    name: letsencrypt-staging-issuer # referenced in Pulumi.yaml, you can override it with cert-manager:clusterIssuer
    namespace: cert-manager
spec:
    acme:
        server: https://acme-staging-v02.api.letsencrypt.org/directory
        email: <valid_email>
        privateKeySecretRef:
            name: letsencrypt-account-key
        solvers:
            - dns01:
                  cloudflare:
                      apiTokenSecretRef:
                          name: cloudflare-api-secret
                          key: api-token
              selector:
                  dnsZones:
                      - <your_custom_domain_name>
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
    name: letsencrypt-issuer # referenced in Pulumi.yaml, you can override it with cert-manager:clusterIssuer
    namespace: cert-manager
spec:
    acme:
        server: https://acme-v02.api.letsencrypt.org/directory
        email: <valid_email>
        privateKeySecretRef:
            name: letsencrypt-account-key
        solvers:
            - dns01:
                  cloudflare:
                      apiTokenSecretRef:
                          name: cloudflare-api-secret
                          key: api-token
              selector:
                  dnsZones:
                      - <your_custom_domain_name>
```

Save this as `cloudflare.yml` replacing `cloudflare_api_token`, `valid_email` and `your_custom_domain_name`.

Use `kubectl apply -f cloudflare.yml` to create the issuer.

**Verify the issuers are ready:**

```sh
kubectl get clusterissuer
```

Both should show `Ready: True`. If not, check with:

```sh
kubectl describe clusterissuer letsencrypt-staging-issuer
kubectl describe clusterissuer letsencrypt-issuer
```

It's recommended to start with `acme-staging-v02` server to make sure everything works as expected, then switch to production `acme-v02` server to generate valid certificates. This helps to avoid getting throttled when configuration is incorrect.

More information at https://cert-manager.io/docs/configuration/acme/dns01/cloudflare/

Use `ClusterIssuer` rather than `Issuer`, which is namespace scoped, so one issuer serves certificates in every namespace.

## Uninstall

To uninstall cert-manager and clean up its custom resource definitions:

```sh
pulumi config set cert-manager:enabled false
pulumi up

kubectl delete crd \
  certificaterequests.cert-manager.io \
  certificates.cert-manager.io \
  challenges.acme.cert-manager.io \
  clusterissuers.cert-manager.io \
  issuers.cert-manager.io \
  orders.acme.cert-manager.io
```
