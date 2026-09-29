# @orangelab/pulumi

Reusable components for deploying applications on Kubernetes with Pulumi.

This package is used by OrangeLab stacks. See the [main repository](https://orangelab.space/) for documentation.

## Features

- provides DSL to define distributed applications and their dependencies ([Application](./src/application.ts) class)
- creates Kubernetes manifests based on your `Pulumi.<stack>.yaml` configuration
- uses Pulumi to show instrastructure changes and deploys them
- provisions databases needed by applications (MySQL, PostgreSQL, Redis)
- supports Helm charts as well as simple Docker images
- uses Kubernetes labels to target deployments based on `<app>:requiredNodeLabel` (f.e. `kubernetes.io/hostname` or `topology.kubernetes.io/zone`)
- supports multiple routing providers and app-specific overrides (Tailscale, Traefik)

## Configuration

Application configuration options are documented in [docs/configuration.md](https://github.com/OrangeLab-space/orange-lab/blob/main/docs/configuration.md).
