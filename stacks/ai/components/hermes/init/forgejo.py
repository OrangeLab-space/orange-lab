#!/usr/bin/env python3
"""Normalise a Forgejo comment or review event into the fields the route prompt reads.

Hermes runs this before rendering the prompt: the JSON object printed here
replaces the provider payload. Empty stdout drops the event, so a push, a label
or a comment on a thread the agent has no part in never wakes it.

Forgejo puts a timeline comment on a pull request in either `issue_comment`
(with `is_pull: true`, no `pull_request` block) or `pull_request_comment`
(with both), a review in `pull_request_review_*`, and a comment on a plain issue
in the same `issue_comment`; all of them are flattened here, so the route sees
one shape whichever event the instance sends.

Who wakes it: a thread the agent opened, or a comment that names it. The route is
added per repository by whoever administers that repository, so the script is the
only place that can tell a request addressed to the agent from traffic on someone
else's issue. `sender.login` cannot carry this: the route filter drops the agent's
own comments, and the issue's opener is a different field.
"""

import json
import os
import re
import sys

# The forge login the agent posts as (`payload.sender.login` in the route filter,
# config `hermes:forgejo/agentLogin`, default `agent`) and the mention that calls
# it by name, case-insensitively. The trailing guard keeps `@agent-smith` and a
# longer login starting with this one from counting as a mention.
AGENT_LOGIN = (os.environ.get('FORGEJO_AGENT_LOGIN') or 'agent').strip() or 'agent'
AGENT_MENTION = re.compile(r'@' + re.escape(AGENT_LOGIN) + r'(?![\w-])', re.IGNORECASE)


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0
    if not isinstance(payload, dict):
        return 0

    pull = payload.get('pull_request')
    pull = pull if isinstance(pull, dict) else {}
    issue = payload.get('issue')
    issue = issue if isinstance(issue, dict) else {}

    number = pull.get('number') or issue.get('number') or payload.get('number')
    if not number:
        return 0

    comment = payload.get('comment')
    comment = comment if isinstance(comment, dict) else {}
    review = payload.get('review')
    review = review if isinstance(review, dict) else {}

    html_url = pull.get('html_url') or issue.get('html_url') or ''
    if review:
        kind = 'review'
        body = review.get('body') or review.get('content') or ''
        url = review.get('html_url') or html_url
    elif comment:
        kind = 'comment'
        body = comment.get('body') or ''
        url = comment.get('html_url') or html_url
    else:
        # Opened, synchronised, labelled, approved without text: nothing to answer.
        return 0

    body = str(body).strip()
    mentioned = AGENT_MENTION.search(body) is not None
    if not body:
        body = '(no text — an inline review comment, read it on the thread)'

    # "Created by you" is about the issue or the pull request, not the comment: a
    # thread the agent opened is one it belongs to, and anywhere else it has to be
    # named before a turn is spent on it.
    opener = issue.get('user') or pull.get('user')
    opener = opener.get('login') if isinstance(opener, dict) else None
    if not mentioned and opener != AGENT_LOGIN:
        return 0

    print(json.dumps({
        'event': payload.get('action') or '',
        'kind': kind,
        'repo': (payload.get('repository') or {}).get('full_name') or '',
        'number': number,
        'title': pull.get('title') or issue.get('title') or '',
        'url': url,
        'author': (payload.get('sender') or {}).get('login') or '',
        'body': body,
    }))
    return 0


if __name__ == '__main__':
    sys.exit(main())
