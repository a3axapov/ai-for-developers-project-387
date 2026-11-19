# Issue tracker: GitHub

Issues and specs live in GitHub Issues for
`a3axapov/ai-for-developers-project-387`.

Use the `gh` CLI from the repository root through mise:
`mise exec github-cli@latest -- gh <command>`.
Ensure the mise executable directory is on PATH.

## Conventions

Before the first issue creation in a session, verify the target:
`gh repo view --json nameWithOwner`.
It must be `a3axapov/ai-for-developers-project-387`.

Commands below use `gh` as shorthand for the mise invocation above.

- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels`.
- Comment: `gh issue comment <number> --body-file <file>`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or
  `--remove-label "..."`.
- Close: post an explanation with `gh issue comment`, then run
  `gh issue close <number>`. Comment separately even if already closed.
- Sub-issues: use GitHub's native parent/child relationships.
  If unavailable, put `Part of #<parent>` at the top of the child body
  and link the child in the parent's task list.
- Blocking: use GitHub's native issue dependencies.
  If unavailable, put `Blocked by: #<number>, #<number>` at the top
  of the issue body. Work is unblocked when every blocker is closed.

## Pull requests as a triage surface

**PRs as a request surface: no.**

`/oc` or `/opencode` in a pull-request comment is a maintenance command for that
PR (`docs/agents/pr-command.md`), not a request surface and not triage. It does
not accept new requests, does not create issues, and does not change this rule.

## Skill instructions

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the GitHub issue.

## Source project

The specification and decisions from the first project are indexed in
[source-project.md](source-project.md). Issue numbers `#13`–`#36` in
`workflow.md` and `retro-regressions.md` refer to that project until the
corresponding tasks are created in this tracker.
