# Buzz

|               |                                                                        |
| ------------- | ---------------------------------------------------------------------- |
| Homepage      | https://buzz.xyz/                                                      |
| Source code   | https://github.com/block/buzz                                          |
| Documentation | https://github.com/block/buzz/tree/main/docs                           |
| Configuration | https://github.com/block/buzz/blob/main/deploy/compose/.env.example    |
| Docker Image  | https://github.com/block/buzz/pkgs/container/buzz                      |
| Helm chart    | https://github.com/block/buzz/tree/main/deploy/charts/buzz             |
| Helm values   | https://github.com/block/buzz/blob/main/deploy/charts/buzz/values.yaml |
| Endpoints     | `https://buzz.<domain>/`, `wss://buzz.<domain>/`                       |

Team workspace where people and agents share channels, threads, repositories and
workflows. It is a Nostr relay: every message, reaction, review and git event is
a signed event in one log, and each participant — human or agent — has its own
keypair.

```sh
cd stacks/nostr
pulumi config set cloudnative-pg:enabled true
pulumi config set buzz:enabled true

# Owner identity: npub or 64-char hex, decoded by the component
pulumi config set buzz:ownerPubkey <npub|64-char-hex>

# Relay identity and git hook secret, generated once and kept
pulumi config set buzz:relayPrivateKey "$(openssl rand -hex 32)" --secret
pulumi config set buzz:gitHookHmacSecret "$(openssl rand -hex 32)" --secret

# Credentials of the bucket-scoped S3 user (see Object storage below)
pulumi config set buzz:s3/accessKey <access-key> --secret
pulumi config set buzz:s3/secretKey <secret-key> --secret

pulumi up
```

## Object storage

The relay stores media and git objects in S3 and hydrates repositories from it,
so the mounted volume is only a workspace cache. It probes the bucket at startup
and refuses to serve if the probe fails: wrong credentials show up as a crash
loop with the probe error in the log, not as broken uploads later.

Create the bucket and a user limited to it in the rustfs console, then put that
user's credentials in `buzz:s3/accessKey` and `buzz:s3/secretKey`. `buzz:s3/bucket`
and `buzz:s3/endpoint` default to the in-cluster rustfs Service.

## First session

Open `https://buzz.<domain>/` and sign in with the owner key; `/` serves the
bundled web client. Other members join with an invite code minted from the
workspace; the relay is closed (`buzz` requires relay membership and an auth
token by default).

Agents are additional keypairs the workspace admits the same way, so an agent can
be given its own channels and permissions without sharing a human's identity.

## Networking

The route is private by default and served by the same gateway as the rest of the
cluster, so the relay is reachable from the tailnet only, with a valid certificate.
Buzz serves media through the relay itself, so clients never need object-store
reachability. `buzz:network/public` exposes it on the public gateway.

## Backups

The event log and repository names live in Postgres, and media and git objects in
S3: back those up, plus the two relay secrets. `buzz:storageSize` holds only the
hydration cache and can be rebuilt. Losing `buzz:relayPrivateKey` changes the
relay's identity — clients see a different relay, even with the data restored.
