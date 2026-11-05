# Hermes Agent — operating notes

Agent-facing detail for [`components/hermes/hermes.md`](../components/hermes/hermes.md).

## White Noise connector

- Two artefacts from one [upstream release](https://github.com/marmot-protocol/mdk/releases):
  the `wn-agent` binary (transport, run as a sidecar) and `hermes-marmot-plugin`
  (the gateway adapter). `init/install-wn-agent.sh` installs and checksum-verifies
  both on every start. Installing only the binary leaves `platforms.marmot`
  configured but unregistered, so messages never arrive.
- Each profile in `hermes:profiles` gets its own connector: home under
  `/opt/data/marmot-agents/<profile>`, socket `<home>/dev/wn-agent.sock`, media
  directory and keypair. The launch profile keeps the app-name directory, whose
  keypair is the one already invited into groups.
- `init/seed-marmot-profiles.sh` writes the profile's `platforms.marmot` block into
  the profile's own `config.yaml`, the only file its scope reads. It runs as root
  before `fix-volume-permissions`, and chowns the profile directory to `USER_ID`;
  the image ships no privilege-drop tool.
- The sidecar creates `<home>/dev/outbound-media` before starting the connector. A
  missing allowed root aborts startup with `io_error NotFound`.
- After the control socket appears, the sidecar publishes the configured
  `marmot/profile/name` and `marmot/profile/picture` as the account's kind-0
  profile when the account has none, or when the config differs from the values
  recorded in `dev/profile-seed.json`. A change made elsewhere is kept across
  restarts; changing the config publishes again.
- `wn-agent bootstrap` creates the identity when missing and publishes the key
  package. Creating with `--no-publish-key-package` leaves invites failing with
  `there is no usable inbox relay for npub`; `scripts/wn-agent-npub.sh` bootstraps
  every connector home and prints one `profile npub` line each.
- `allowedUsers` and `welcomerAllowlist` are read from the process environment, so
  they apply to every profile; which profile answers follows from the npub that was
  invited into the group.
- Under the multiplexed gateway a profile's secret scope reads only its own
  `profiles/<profile>/.env` and does not fall back to the pod env, so the component
  seeds both allowlists there too. Missing them makes every sender on that profile
  read as `Unauthorized user`.

## Webhook routes

- `forgejo-pr` is seeded like `config.yaml`: written when the volume has none, and
  restored by `hermes:recreateConfig true`.
- `init/forgejo-pr.py` drops everything that is not a comment or review on a pull
  request, and flattens the payload into `repo`, `number`, `title`, `author`, `url`
  and `body`, which is what the route prompt reads.
- A comment whose author is the agent (`sender.login == agent`) never wakes it, so
  its own replies cannot start a loop.
- Both forges sign the raw body into `X-Hub-Signature-256` (`sha256=<hex>` HMAC) and
  name the event in `X-GitHub-Event`, so a GitHub-shaped hook works unchanged
  against Forgejo.
- Recreating the route by hand: `hermes webhook subscribe forgejo-pr --secret <value>`.
  Without `--secret` it mints a per-route secret that the existing hook does not
  sign with. Test a route without a sender with `hermes webhook test forgejo-pr`.

## API and profiles

- Each profile's key is written to its `.env` at pod start, so a profile created on
  the dashboard answers after the next deploy. A name in `hermes:profiles` with no
  profile behind it gets no key and stays unreachable.
- Provider name and model id are both the profile name, `hermes-agent` for the
  default profile. `clientPrefix` groups the catalog only; the provider, and so the
  key, stays per profile.
- The API port and the webhook listener stay cluster-only; only agentgateway (API)
  and in-cluster senders (webhooks) reach them.
