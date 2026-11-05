---
name: pull-request
description: Use when opening a pull request in the orange-lab repo, writing or rewriting its description, replying to a review comment, or reporting what a push changed. Trigger on phrases like "open a PR", "update the PR body", "reply on the PR", "comment on #<n>", "push the fix".
---

# Pull Requests

The body is read later, by someone who finds the change in the repo; a comment is
read now, by the person who asked for the work. Both are short, and both answer
the reader's question before anything else.

## Body

Four sections, in this order, and no others:

- `## Problem` — the defect in the vocabulary of the code and the API: a port
  that cannot be probed, a readiness path that reports the wrong thing. Not this
  cluster's hostnames, node names, measurements or incident timeline.
- `## Proposed solution` — what the diff does, one bullet per file group, and one
  clause on why this shape over the obvious alternative.
- `## Blast radius` — what changes **on apply**. Say "inert" when an install that
  does not enable the feature sees nothing. Correct a claim the moment it turns
  out false; a body that promises more than the diff does is worse than no body.
- `## Configuration changes` — the keys the deployer sets, or `None`.

No `## Verification`, `## Evidence` or `## Notes` section: a reviewer assumes the
change was tested, and the run belongs in the comment. About one screen — a body
that needs scrolling is retelling the diff the reviewer is about to read.

## Comment

A comment on a finished push is a report, three lines, in this order:

1. what changed,
2. what was verified, with the one number that makes it credible,
3. what is left — a bug left alone, an assumption, the next step.

```
Trimmed the comments and the doc section, 80 lines out.
Fixed `seed-image.sh` reading `$DATA_PATH`, which the init container never sets.
Verified against the live ComfyUI: 37.6 s, 1400965-byte PNG back.
Left alone: `extra.workflow` still names z-image-turbo under another model, and
`Flux2Scheduler` keeps 1024x1024 while the latent is resized to the aspect.
```

- Change first; the reader stops once their question is answered.
- One line per item. The diff, the log and the command output are the evidence —
  quote the failing line (`set -u` killed the step) instead of narrating the
  investigation that found it.
- Numbers over adjectives: `80 lines`, `37.6 s`, `1400965-byte`.
- Always name what was not done. A report with nothing outstanding says so in a
  line; an unmentioned gap is the one the reviewer finds later.
- Answer the point that was raised, in the thread it was raised in, naming the
  commit it landed in. Do not restate the body.

## Before the push

`npx prettier --check` on the touched markdown; type-check and `eslint` when code
moved. Confirm the PR's shape from the API — `changed_files`, `mergeable`,
`head.sha` — rather than from a local diff against a ref that may be stale.
