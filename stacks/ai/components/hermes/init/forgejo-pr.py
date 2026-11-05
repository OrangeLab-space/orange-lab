#!/usr/bin/env python3
"""Normalise a Forgejo pull request event into the fields the route prompt reads.

Hermes runs this before rendering the prompt: the JSON object printed here
replaces the provider payload. Empty stdout drops the event, so a push, a label
or a plain issue comment never wakes the agent.

Forgejo puts a timeline comment on a pull request in either `issue_comment`
(with `is_pull: true`, no `pull_request` block) or `pull_request_comment`
(with both), and a review in `pull_request_review_*`; all three are handled here
so the route sees one shape whichever event the instance sends.
"""

import json
import sys


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

    is_pull = (
        payload.get('is_pull') is True
        or bool(pull)
        or isinstance(issue.get('pull_request'), dict)
    )
    if not is_pull:
        return 0

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
    if not body:
        body = '(no text — an inline review comment, read it on the thread)'

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
