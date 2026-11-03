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

# Hermes strips GitHub credentials from tool subprocesses, so the token also
# lives in .env, where the bundled GitHub skill reads it.
if [ -f "$SEED_PATH/github.env" ]; then
    touch "$DATA_PATH/.env"
    grep -v -e '^GH_TOKEN=' -e '^GITHUB_TOKEN=' "$DATA_PATH/.env" > "$DATA_PATH/.env.tmp" || true
    cat "$SEED_PATH/github.env" >> "$DATA_PATH/.env.tmp"
    mv "$DATA_PATH/.env.tmp" "$DATA_PATH/.env"
    chown "$USER_ID:$USER_ID" "$DATA_PATH/.env"
fi

chown -R "$USER_ID:$USER_ID" "$DATA_PATH/workspace" "$DATA_PATH/config.yaml" "$DATA_PATH/SOUL.md"
