#!/bin/sh
set -eu

# Env:
#   MARMOT_HOME      connector home; dev/ holds the control socket and seed state
#   MARMOT_SOCKET    control socket the gateway connects to
#   WN_AGENT_BIN     installed wn-agent binary
#   PLUGIN_PATH      directory holding the marmot plugin's Python client
#   PROFILE_NAME     Nostr profile name seeded when the account has none
#   PROFILE_PICTURE  picture URL seeded with the name

sock=$MARMOT_SOCKET

# A socket left by a dead process blocks bind; the connector is the only writer.
rm -f "$sock"

# A missing allowed root stops the connector at startup; a fresh profile has none.
mkdir -p "$MARMOT_HOME/dev/outbound-media"

"$WN_AGENT_BIN" --version
"$WN_AGENT_BIN" \
    --home "$MARMOT_HOME" \
    --socket "$sock" \
    --media-allowed-root "$MARMOT_HOME/dev/outbound-media" \
    --relay wss://relay.eu.whitenoise.chat \
    --relay wss://relay.us.whitenoise.chat &
agent=$!
trap 'kill $agent 2>/dev/null' TERM INT

# The account loads asynchronously; wait briefly for the control socket.
i=0
while [ ! -S "$sock" ] && [ "$i" -lt 150 ]; do
    sleep 0.2
    i=$((i + 1))
done

if [ -n "${PROFILE_NAME:-}" ] && [ -S "$sock" ]; then
    /opt/hermes/.venv/bin/python3 - "$PLUGIN_PATH" <<'PY' || true
import asyncio, json, os, pathlib, sys

sys.path.insert(0, sys.argv[1])
from marmot.agent_control import MarmotAgentControlClient


async def publish():
    client = MarmotAgentControlClient(os.environ["MARMOT_SOCKET"])
    wanted = {
        "name": os.environ["PROFILE_NAME"],
        "picture": os.environ.get("PROFILE_PICTURE"),
    }
    state = pathlib.Path(os.environ["MARMOT_HOME"]) / "dev" / "profile-seed.json"
    try:
        seeded = json.loads(state.read_text())
    except (OSError, ValueError):
        seeded = None
    for _ in range(10):
        accounts = (await client.account_list()).get("accounts") or []
        if len(accounts) == 1:
            break
        await asyncio.sleep(0.5)
    else:
        return
    account = accounts[0]["account_id_hex"]
    lookup = await client.account_lookup_profile(account)
    if lookup.get("status") == "indeterminate":
        return
    if seeded == wanted and lookup.get("status") == "profile_found":
        return
    await client.account_publish_profile(
        account,
        wanted["name"],
        display_name=wanted["name"],
        picture=wanted["picture"] or None,
    )
    state.write_text(json.dumps(wanted))


asyncio.run(publish())
PY
fi

wait "$agent"
