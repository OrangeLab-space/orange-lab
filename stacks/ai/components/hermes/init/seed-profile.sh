#!/bin/sh
set -eu

# Env:
#   DATA_PATH        writable profile volume
#   SEED_PATH        read-only seeded config volume
#   USER_ID          uid/gid that owns the seeded files
#   RECREATE_CONFIG  "true" overwrites config.yaml, otherwise only when missing

mkdir -p "$DATA_PATH/workspace"

if [ "$RECREATE_CONFIG" = "true" ]; then
    cp -f "$SEED_PATH/config.yaml" "$DATA_PATH/config.yaml"
elif [ ! -s "$DATA_PATH/config.yaml" ]; then
    cp "$SEED_PATH/config.yaml" "$DATA_PATH/config.yaml"
fi

[ -s "$DATA_PATH/SOUL.md" ] || cp "$SEED_PATH/SOUL.md" "$DATA_PATH/SOUL.md"

# Hermes strips credentials from tool subprocesses, so each token also lives in
# .env, where the bundled skill for that host reads it. A key that comes from a
# Secret replaces whatever the agent wrote there.
seed_env() {
    env_file=$1
    [ -f "$env_file" ] || return 0
    keys=$(cut -d= -f1 "$env_file" | paste -sd'|' -)
    touch "$DATA_PATH/.env"
    grep -v -E "^(${keys})=" "$DATA_PATH/.env" > "$DATA_PATH/.env.tmp" || true
    cat "$env_file" >> "$DATA_PATH/.env.tmp"
    mv "$DATA_PATH/.env.tmp" "$DATA_PATH/.env"
    chown "$USER_ID:$USER_ID" "$DATA_PATH/.env"
}

seed_env "$SEED_PATH/github.env"
seed_env "$SEED_PATH/forgejo.env"

chown -R "$USER_ID:$USER_ID" "$DATA_PATH/workspace" "$DATA_PATH/config.yaml" "$DATA_PATH/SOUL.md"
