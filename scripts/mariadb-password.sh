#!/bin/bash

# Script to set MariaDB root password from Kubernetes secret to Pulumi config
# Usage: mariadb-password.sh <app-name>

appName=$1

if [ -z "$appName" ]; then
  echo "Error: Application name is required"
  echo "Usage: mariadb-password.sh <app-name>"
  exit 1
fi

# Check if password is already set
existingPassword=$(pulumi config get $appName:db/rootPassword 2>/dev/null)

if [ $? -eq 0 ] && [ -n "$existingPassword" ]; then
    echo "Error: db/rootPassword is already set for app: $appName"
    exit 1
fi


# Read rootPassword from DB secret
echo "Retrieving MariaDB root password from secret for app: $appName"
secret=$(kubectl get secret -n "$appName" "$appName-db-secret" -o jsonpath='{.data.rootPassword}')

if [ $? -ne 0 ]; then
    echo "Error: Failed to retrieve root password from secret"
    exit 1
fi

rootPassword=$(echo "$secret" | base64 -d)

if [ -z "$rootPassword" ]; then
    echo "Error: Retrieved root password is empty"
    exit 1
fi

# Set db/rootPassword in Pulumi config
echo "Setting db/rootPassword in Pulumi config for app: $appName"
pulumi config set --secret $appName:db/rootPassword "$rootPassword"

if [ $? -eq 0 ]; then
    echo "MariaDB root password set successfully"
else
    echo "Error: Failed to set Pulumi config"
    exit 1
fi
