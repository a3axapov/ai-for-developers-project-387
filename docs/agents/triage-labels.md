# Triage labels

| Canonical role    | GitHub label      | Meaning                                  |
| ----------------- | ----------------- | ---------------------------------------- |
| `needs-triage`    | `needs-triage`    | Maintainer needs to evaluate the issue   |
| `needs-info`      | `needs-info`      | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `ready-for-human` | Requires human implementation            |
| `wontfix`         | `wontfix`         | Will not be actioned                     |

When a skill mentions a triage role, use its mapped GitHub label.

## Setup

Create the labels once if they are missing:

```sh
gh label create needs-triage --description "Maintainer needs to evaluate the issue" --color FBCA04
gh label create needs-info --description "Waiting on reporter for more information" --color D4C5F9
gh label create ready-for-human --description "Requires human implementation" --color 1D76DB
```

Tickets published by `to-tickets` carry `ready-for-agent` from creation. Auto-triage
(`.github/workflows/opencode-triage.yml`) skips issues that already have any state
label from the table above, so those tickets are not re-triaged.
