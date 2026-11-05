#!/usr/bin/env python3
"""Merge the seeded webhook routes into the profile volume.

The route file is a map the dashboard writes too, so it cannot be copied once and
forgotten: a route this component declares has to reach an existing install on a
plain `pulumi up`, or the deploy silently keeps answering on the old route. The
copy step runs on `alpine`, which has no JSON parser, so the merge runs in the
app image instead.

Ownership: a route the seed names belongs to the deploy and is replaced when it
differs; every other route is left exactly as the operator wrote it. An emptied
or unreadable file is kept beside the seeded copy rather than silently dropped.
`recreateConfig` still means "the volume gets the deploy's file verbatim", which
discards routes the dashboard added.

Env: SEED_PATH, DATA_PATH, USER_ID, RECREATE_CONFIG.
"""

import json
import os
import sys

FILENAME = 'webhook_subscriptions.json'


def load_live(path):
    """The volume's routes, or None when there is nothing to merge with."""
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        return None
    try:
        with open(path, encoding='utf-8-sig') as handle:
            routes = json.load(handle)
    except ValueError as error:
        routes = None
        print(f'{FILENAME}: not valid JSON ({error})', file=sys.stderr)
    if not isinstance(routes, dict):
        if routes is not None:
            print(f'{FILENAME}: not a route map', file=sys.stderr)
        # The gateway cannot answer on this file either way; keep the bytes so
        # nothing the operator wrote is lost, and seed over it.
        os.replace(path, f'{path}.invalid')
        return None
    return routes


def write_routes(path, routes, user_id):
    """Replace the file atomically, so an interrupted start leaves no half map."""
    temp = f'{path}.tmp'
    with open(temp, 'w', encoding='utf-8') as handle:
        json.dump(routes, handle, indent=2, ensure_ascii=False)
        handle.write('\n')
    if user_id is not None:
        try:
            os.chown(temp, user_id, user_id)
        except PermissionError:
            pass
    os.chmod(temp, 0o644)
    os.replace(temp, path)


def main():
    seed_file = os.path.join(os.environ['SEED_PATH'], FILENAME)
    if not os.path.isfile(seed_file):
        print(f'{FILENAME}: no seeded copy, leaving the volume alone', file=sys.stderr)
        return
    with open(seed_file, encoding='utf-8') as handle:
        seed = json.load(handle)
    target = os.path.join(os.environ['DATA_PATH'], FILENAME)
    user_id = int(os.environ['USER_ID']) if os.environ.get('USER_ID') else None

    live = None
    if os.environ.get('RECREATE_CONFIG') != 'true':
        live = load_live(target)
    if live is None:
        write_routes(target, seed, user_id)
        print(f'{FILENAME}: seeded')
        return

    merged = dict(live)
    for name, route in seed.items():
        merged[name] = route
    if merged == live:
        return
    write_routes(target, merged, user_id)
    changed = [name for name, route in seed.items() if live.get(name) != route]
    replaced = ', '.join(sorted(changed))
    print(f'{FILENAME}: merged {replaced}')


if __name__ == '__main__':
    main()
