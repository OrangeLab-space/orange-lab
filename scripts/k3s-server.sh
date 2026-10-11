#!/bin/bash
set -euo pipefail

# Run this script where Pulumi is configured.
# Copy and execute the output on Kubernetes server.

CLUSTER_CIDR=$(pulumi config get k3s:clusterCidr)
SERVICE_CIDR=$(pulumi config get k3s:serviceCidr)

echo export NODE_IP='$(tailscale ip -4)'
echo export NODE_NAME='$(tailscale status --json | jq -r .Self.DNSName | sed "s/\.$//")'
echo export LAN_IP='$(hostname -I | cut -d" " -f1)'
echo export CLUSTER_CIDR=$CLUSTER_CIDR
echo export SERVICE_CIDR=$SERVICE_CIDR
echo
# bind-address listens on every interface so LAN clients can reach the API, while
# advertise-address stays on the tailnet address every node dials. The SAN list
# also carries the LAN IP as a recovery path if tailscaled is unavailable.
echo "curl -sfL https://get.k3s.io |  sh -s - \
--bind-address=0.0.0.0 \
--advertise-address=\$NODE_IP \
--node-ip=\$NODE_IP \
--tls-san=\$NODE_IP,\$NODE_NAME,\$LAN_IP \
--selinux \
--secrets-encryption \
--cluster-cidr=\$CLUSTER_CIDR \
--service-cidr=\$SERVICE_CIDR \
--flannel-iface=tailscale0 \
--disable=traefik \
--kube-apiserver-arg=enable-admission-plugins=DefaultTolerationSeconds \
--kube-apiserver-arg=default-not-ready-toleration-seconds=10 \
--kube-apiserver-arg=default-unreachable-toleration-seconds=10"
echo
echo systemctl restart k3s.service
echo systemctl enable k3s.service --now
