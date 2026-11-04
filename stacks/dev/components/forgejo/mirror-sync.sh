#!/bin/sh
#
# Fast-forward branches of a repository from an upstream remote, and push the
# result on to a sink when both ends are given.
#
# The job never forces. A branch is pushed only when the upstream tip is a
# descendant of the copy the target already has, so commits made directly in the
# target are never thrown away: a branch that has moved on both sides is reported
# as DIVERGED and left alone for a human to reconcile.
#
set -eu

# Settings come from a mounted file, one per direction, so a direction is
# described in one place instead of scattered through the pod spec.
settings=${1:-/config/mirror-sync.env}
[ -r "$settings" ] || {
    printf 'no settings file at %s\n' "$settings" >&2
    exit 2
}
# shellcheck source=/dev/null
. "$settings"

: "${UPSTREAM_URL:?UPSTREAM_URL is required}"
: "${TARGET_URL:?TARGET_URL is required}"
: "${TARGET_TOKEN:?TARGET_TOKEN is required}"
: "${BRANCHES:?BRANCHES is required}"

TARGET_USERNAME=${TARGET_USERNAME:-oauth2}
UPSTREAM_USERNAME=${UPSTREAM_USERNAME:-oauth2}

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

# Credentials are handed to git through askpass, so no secret ever lands in a
# remote URL, in .git/config, or on a command line visible in the pod.
cat >"$workdir/askpass-target.sh" <<'ASKPASS'
#!/bin/sh
case "$1" in
Username*) printf '%s\n' "$TARGET_USERNAME" ;;
*) printf '%s\n' "$TARGET_TOKEN" ;;
esac
ASKPASS

cat >"$workdir/askpass-upstream.sh" <<'ASKPASS'
#!/bin/sh
case "$1" in
Username*) printf '%s\n' "$UPSTREAM_USERNAME" ;;
*) printf '%s\n' "$UPSTREAM_TOKEN" ;;
esac
ASKPASS

chmod 0500 "$workdir"/askpass-target.sh "$workdir"/askpass-upstream.sh

repo="$workdir/repo.git"
git init --quiet --bare "$repo"
git -C "$repo" remote add upstream "$UPSTREAM_URL"
git -C "$repo" remote add target "$TARGET_URL"

export GIT_TERMINAL_PROMPT=0

if [ -n "${UPSTREAM_TOKEN:-}" ]; then
    GIT_ASKPASS="$workdir/askpass-upstream.sh" git -C "$repo" fetch --quiet --prune \
        upstream '+refs/heads/*:refs/heads/upstream/*'
else
    git -C "$repo" fetch --quiet --prune upstream '+refs/heads/*:refs/heads/upstream/*'
fi

GIT_ASKPASS="$workdir/askpass-target.sh" git -C "$repo" fetch --quiet --prune \
    target '+refs/heads/*:refs/heads/target/*'

short() {
    printf '%.7s' "$1"
}

failed=0
for branch in $(printf '%s' "$BRANCHES" | tr ',' ' '); do
    upstream_ref="refs/heads/upstream/$branch"
    target_ref="refs/heads/target/$branch"

    upstream_tip=$(git -C "$repo" rev-parse --verify --quiet "$upstream_ref") || {
        printf 'MISSING %s: upstream has no branch %s\n' "$branch" "$branch"
        failed=1
        continue
    }
    target_tip=$(git -C "$repo" rev-parse --verify --quiet "$target_ref" || true)

    if [ -z "$target_tip" ]; then
        printf 'NEW %s %s\n' "$branch" "$(short "$upstream_tip")"
    elif [ "$target_tip" = "$upstream_tip" ]; then
        printf 'SAME %s %s\n' "$branch" "$(short "$upstream_tip")"
        continue
    elif git -C "$repo" merge-base --is-ancestor "$target_tip" "$upstream_tip"; then
        printf 'FAST-FORWARD %s %s..%s\n' \
            "$branch" "$(short "$target_tip")" "$(short "$upstream_tip")"
    else
        printf 'DIVERGED %s: target %s, upstream %s — left alone, reconcile by hand\n' \
            "$branch" "$(short "$target_tip")" "$(short "$upstream_tip")"
        failed=1
        continue
    fi

    if GIT_ASKPASS="$workdir/askpass-target.sh" git -C "$repo" push --quiet \
        target "$upstream_ref:refs/heads/$branch"; then
        printf 'PUSHED %s %s\n' "$branch" "$(short "$upstream_tip")"
    else
        printf 'FAILED %s: push rejected\n' "$branch"
        failed=1
    fi
done

exit "$failed"
