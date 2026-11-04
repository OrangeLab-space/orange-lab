#!/bin/sh
#
# Fast-forward branches of a repository from a source remote, and push the
# result on to the target remote.
#
# The script knows no direction of its own: the pull stage runs it with the
# upstream as SOURCE_URL and the local repository as TARGET_URL, the push stage
# the other way round. Both ends are named by their role, so the same words mean
# the same thing in either settings file.
#
# It never forces. A branch is pushed only when the source tip is a descendant
# of the copy the target already has, so commits made directly in the target are
# never thrown away: a branch that has moved on both sides is reported as
# DIVERGED and left alone for a human to reconcile.
#
set -eu

# Settings come from a mounted file, one per direction, so a direction is
# described in one place instead of scattered through the pod spec.
settings=${1:-/config/pull.env}
[ -r "$settings" ] || {
    printf 'no settings file at %s\n' "$settings" >&2
    exit 2
}
# shellcheck source=/dev/null
. "$settings"

: "${SOURCE_URL:?SOURCE_URL is required}"
: "${TARGET_URL:?TARGET_URL is required}"
: "${TARGET_TOKEN:?TARGET_TOKEN is required}"
: "${BRANCHES:?BRANCHES is required}"

TARGET_USERNAME=${TARGET_USERNAME:-oauth2}
SOURCE_USERNAME=${SOURCE_USERNAME:-oauth2}

# The askpass scripts below are separate processes, so anything they read has to
# be in the environment, not merely a shell variable. Unexported, the username
# comes back empty, git hands the remote ":" as the credential and never uses
# the token at all - a read-only remote still serves the fetch anonymously, so
# the first push is where it surfaces, as "No anonymous write access".
export TARGET_USERNAME SOURCE_USERNAME TARGET_TOKEN
if [ -n "${SOURCE_TOKEN:-}" ]; then
    export SOURCE_TOKEN
fi

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

cat >"$workdir/askpass-source.sh" <<'ASKPASS'
#!/bin/sh
case "$1" in
Username*) printf '%s\n' "$SOURCE_USERNAME" ;;
*) printf '%s\n' "$SOURCE_TOKEN" ;;
esac
ASKPASS

chmod 0500 "$workdir"/askpass-target.sh "$workdir"/askpass-source.sh

repo="$workdir/repo.git"
git init --quiet --bare "$repo"
git -C "$repo" remote add source "$SOURCE_URL"
git -C "$repo" remote add target "$TARGET_URL"

export GIT_TERMINAL_PROMPT=0

if [ -n "${SOURCE_TOKEN:-}" ]; then
    GIT_ASKPASS="$workdir/askpass-source.sh" git -C "$repo" fetch --quiet --prune \
        source '+refs/heads/*:refs/heads/source/*'
else
    git -C "$repo" fetch --quiet --prune source '+refs/heads/*:refs/heads/source/*'
fi

GIT_ASKPASS="$workdir/askpass-target.sh" git -C "$repo" fetch --quiet --prune \
    target '+refs/heads/*:refs/heads/target/*'

short() {
    printf '%.7s' "$1"
}

failed=0
for branch in $(printf '%s' "$BRANCHES" | tr ',' ' '); do
    source_ref="refs/heads/source/$branch"
    target_ref="refs/heads/target/$branch"

    source_tip=$(git -C "$repo" rev-parse --verify --quiet "$source_ref") || {
        printf 'MISSING %s: source has no branch %s\n' "$branch" "$branch"
        failed=1
        continue
    }
    target_tip=$(git -C "$repo" rev-parse --verify --quiet "$target_ref" || true)

    if [ -z "$target_tip" ]; then
        printf 'NEW %s %s\n' "$branch" "$(short "$source_tip")"
    elif [ "$target_tip" = "$source_tip" ]; then
        printf 'SAME %s %s\n' "$branch" "$(short "$source_tip")"
        continue
    elif git -C "$repo" merge-base --is-ancestor "$target_tip" "$source_tip"; then
        printf 'FAST-FORWARD %s %s..%s\n' \
            "$branch" "$(short "$target_tip")" "$(short "$source_tip")"
    else
        printf 'DIVERGED %s: target %s, source %s — left alone, reconcile by hand\n' \
            "$branch" "$(short "$target_tip")" "$(short "$source_tip")"
        failed=1
        continue
    fi

    if GIT_ASKPASS="$workdir/askpass-target.sh" git -C "$repo" push --quiet \
        target "$source_ref:refs/heads/$branch"; then
        printf 'PUSHED %s %s\n' "$branch" "$(short "$source_tip")"
    else
        printf 'FAILED %s: push rejected\n' "$branch"
        failed=1
    fi
done

exit "$failed"
