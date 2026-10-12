# Installation - admin node

**Admin/Management node** is where you run Pulumi to create and update your infrastructure, most likely your laptop.

```sh
git clone https://github.com/OrangeLab-space/orange-lab
# build required after every change to packages/pulumi/
npm run build
```

## Prerequisites

Install dependencies on the admin node:

```sh
# Install required packages
brew install node pulumi kubectl

# (Recommended) Kubernetes UI
brew install k9s
flatpak install io.kinvolk.Headlamp

# (Optional) Use LLMs for upgrade migration and cluster troubleshooting
brew install opencode
```

### DevContainers (VSCode)

_Use this method when you have VSCode and Docker installed and don't want any other deopendencies on your system._

Make sure you have DevContainers extension installed (https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers).

Open project in VSCode. It will install the required dependencies and recommended extensions. You can then use the terminal inside VSCode to run commands.

## Pulumi

### Backend

Pulumi backend is used to store current state of your infrastructure. The easiest option is to create _Pulumi Cloud_ account (free).

More info at https://www.pulumi.com/docs/iac/concepts/state-and-backends/

Once you have an account, create access token at https://app.pulumi.com/account/tokens

Next step is to login:

```sh
# Login to Pulumi cloud. Used to store stack state.
pulumi login
```

### Stack

Stacks allow deploying the code with different configurations, like `dev`, `production`, etc.

More info at https://www.pulumi.com/docs/iac/concepts/stacks/

In our case there is only one enviroment, so call it for example `lab`:

```sh
# Initialize stack
pulumi stack init <stack-name>

# Select as active
pulumi stack select <stack-name>
```

## VPN

Used for remote access to your cluster as well as communication channel between distributed Kubernetes nodes.

Pick one control plane. The trade-offs of each combination are in
[Choosing a setup](../components/network/NETWORK.md#choosing-a-setup). A node
belongs to one control plane, so this is decided once, before any node joins.

### Tailscale

The default. Start Tailscale service:

```sh
sudo tailscale up --reset --operator=$USER --accept-routes
```

This will also need to be run on each cluster node. Check [Installation - Linux node configuration](./install-linux.md#tailscale) for more information.

Signing up defaults to a Google, Microsoft or GitHub account. To use your own
[Pocket ID](../components/security/pocket/pocket.md) instead, see
[Signing in without Google, Microsoft or GitHub](../components/network/tailscale/tailscale.md#signing-in-without-google-microsoft-or-github).

Join your client devices, then follow [Installation - K3s cluster](./install-k3s.md)
to add cluster nodes to this tailnet.

### Headscale

Self-hosted control plane, so no third-party coordination server or identity
provider is in the path. Sign in with
[Pocket ID](../components/security/pocket/pocket.md) or with its own local users.

Deploy it and make it reachable from outside the LAN, since clients off-LAN
complete sign-in through it:

```sh
pulumi config set headscale:enabled true
pulumi config set headscale:network/public true
pulumi config set headscale:baseDomain vpn.example.com

pulumi up
```

It also needs an explicit `headscale.<customDomain>` DNS record pointing at the
public IP. See [Headscale](../components/network/headscale/headscale.md) for
prerequisites and signing in.

Nodes register with a reusable preauth key rather than an interactive login,
since a headless server has no browser:

```sh
tailscale up --login-server https://headscale.<customDomain> --authkey <key>
```

Then follow [Installation - K3s cluster](./install-k3s.md) to add cluster nodes.

Already running Tailscale and moving over? That is a destructive cutover, not a
toggle — read [Migrating nodes to Headscale](./headscale-migration.md) first.
