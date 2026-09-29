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

## Tailscale

Used for remote access to your cluster as well as communication channel between distributed Kubernetes nodes.

Start Tailscale service:

```sh
sudo tailscale up --reset --operator=$USER --accept-routes
```

This will also need to be run on each cluster node. Check [Installation - Linux node configuration](./install-linux.md#tailscale) for more information.
