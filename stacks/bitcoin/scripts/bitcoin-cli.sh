#!/bin/bash

# Wrapper for bitcoin-cli to set RPC authentication
# Run from stacks/bitcoin/

# Get Bitcoin RPC endpoint (supports both bitcoin-knots and bitcoin-core)
RPC_ENDPOINT=$(pulumi stack output endpoints --json | jq -r '.cluster."bitcoin-knots-rpc" // .cluster."bitcoin-core-rpc"')

# Get admin password (requires --show-secrets)
ADMINPASSWORD=$(pulumi stack output apps --show-secrets | jq -r '.bitcoin.users.admin')

bitcoin-cli -rpcconnect="${RPC_ENDPOINT%%:*}" -rpcport="${RPC_ENDPOINT##*:}" -rpcuser=admin -rpcpassword="${ADMINPASSWORD}" "${@:---help}"
