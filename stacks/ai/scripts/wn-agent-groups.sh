#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<EOF
Usage: $0 [options]

List the Marmot groups a wn-agent connector has received messages from, most
recent first. Use a group id as the agent's home channel.

Optional parameters (defaults match the AI stack):
  --namespace <ns>        Kubernetes namespace (default: hermes)
  --deployment <name>     Deployment whose pod runs the connector (default: hermes)
  --home <path>           Connector home (default: /opt/data/marmot-agents/hermes)
  --container <name>      Container holding the inbound spool (default: hermes)
  -h, --help              Show this help
EOF
}

namespace='hermes'
deployment='hermes'
container='hermes'
home='/opt/data/marmot-agents/hermes'

while (($# > 0)); do
    case "$1" in
        --namespace) namespace="$2"; shift 2 ;;
        --deployment) deployment="$2"; shift 2 ;;
        --container) container="$2"; shift 2 ;;
        --home) home="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *)
            printf 'Unknown argument: %s\n\n' "$1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

exec_args=(exec "deploy/$deployment")
if [[ -n $container ]]; then
    exec_args+=(-c "$container")
fi

#
# The spool is SQLite; read it in place (read-only) and print group, count and
# last message time. Group ids are public identifiers, safe to share.
#
kubectl -n "$namespace" "${exec_args[@]}" -- python3 -c '
import sqlite3, sys, time

db = sys.argv[1]
conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
rows = conn.execute(
    "select group_id, count(*), max(created_at) from events "
    "group by group_id order by max(created_at) desc"
).fetchall()
for group, count, seen in rows:
    stamp = time.strftime("%Y-%m-%d %H:%M", time.localtime(seen))
    print(f"{group}  {count:>4}  {stamp}")
' "$home/hermes/inbound-spool-v1.sqlite3"
