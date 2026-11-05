#!/bin/sh
set -eu

# Env:
#   DATA_PATH        writable profile volume
#   SEED_PATH        read-only seeded config volume
#   USER_ID          uid/gid that owns the seeded files
#   RECREATE_CONFIG  "true" overwrites config.yaml, otherwise only when missing

mkdir -p "$DATA_PATH/workspace" "$DATA_PATH/scripts"

if [ "$RECREATE_CONFIG" = "true" ]; then
    cp -f "$SEED_PATH/config.yaml" "$DATA_PATH/config.yaml"
elif [ ! -s "$DATA_PATH/config.yaml" ]; then
    cp "$SEED_PATH/config.yaml" "$DATA_PATH/config.yaml"
fi

# Routes are not copied here: `webhook_subscriptions.json` is a map the dashboard
# also writes, so the `seed-routes` step merges the deploy's routes into the
# volume copy instead (this image has no JSON parser).

# A route script has to sit under $DATA_PATH/scripts; the gateway resolves the
# name against that directory and refuses a path outside it.
if [ -f "$SEED_PATH/forgejo-pr.py" ]; then
    cp -f "$SEED_PATH/forgejo-pr.py" "$DATA_PATH/scripts/forgejo-pr.py"
    chmod 755 "$DATA_PATH/scripts/forgejo-pr.py"
    chown "$USER_ID:$USER_ID" "$DATA_PATH/scripts/forgejo-pr.py"
fi

[ -s "$DATA_PATH/SOUL.md" ] || cp "$SEED_PATH/SOUL.md" "$DATA_PATH/SOUL.md"

# Hermes strips credentials from tool subprocesses, so each token also lives in
# .env, where the bundled skill for that host reads it. A key that comes from a
# Secret replaces whatever the agent wrote there.
seed_env_into() {
    env_file=$1
    target=$2
    [ -f "$env_file" ] || return 0
    keys=$(cut -d= -f1 "$env_file" | paste -sd'|' -)
    touch "$target"
    grep -v -E "^(${keys})=" "$target" > "$target.tmp" || true
    cat "$env_file" >> "$target.tmp"
    mv "$target.tmp" "$target"
    chown "$USER_ID:$USER_ID" "$target"
}

seed_env_into "$SEED_PATH/github.env" "$DATA_PATH/.env"
seed_env_into "$SEED_PATH/forgejo.env" "$DATA_PATH/.env"
seed_env_into "$SEED_PATH/api-server.env" "$DATA_PATH/.env"
seed_env_into "$SEED_PATH/marmot.env" "$DATA_PATH/.env"

# A profile reads only its own .env, so the key serving it over /p/<profile>/v1
# is seeded there rather than in the default profile's file. A profile directory
# that does not exist yet is skipped: creating one here would leave a half
# profile behind instead of just waiting for the next start.
for seed_file in "$SEED_PATH"/api-server-*.env; do
    [ -f "$seed_file" ] || continue
    profile=$(basename "$seed_file" .env)
    profile=${profile#api-server-}
    [ -d "$DATA_PATH/profiles/$profile" ] || continue
    seed_env_into "$seed_file" "$DATA_PATH/profiles/$profile/.env"
done

chown -R "$USER_ID:$USER_ID" "$DATA_PATH/workspace" "$DATA_PATH/config.yaml" "$DATA_PATH/SOUL.md"
