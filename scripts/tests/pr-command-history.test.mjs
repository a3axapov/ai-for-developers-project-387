import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import * as budget from '../pr-command-limit.mjs';

const current = { id: 202, attempt: 2 };
const title = 'opencode PR #39';
const run = (id, run_attempt = 1, event = 'issue_comment') => ({
  id,
  run_attempt,
  event,
  display_title: title,
});
const receipt = (conclusion) => ({
  name: 'pr-command',
  steps: [
    {
      name: 'Record admitted PR command',
      conclusion,
      started_at: '2026-11-20T12:00:00Z',
    },
  ],
});

test('counts past run attempts including canceled and timed out calls and both channels', async () => {
  const runs = [
    run(201, 2),
    run(202, 2, 'pull_request_review_comment'),
    run(203),
    { ...run(204), display_title: `${title}0` },
  ];
  const reports = {
    '201/1': [receipt('success')],
    '201/2': [receipt('cancelled')],
    '202/1': [receipt('timed_out')],
    '203/1': [receipt('skipped')],
  };
  const seen = [];
  assert.equal(
    await budget.countAdmittedAttempts({
      title,
      current,
      runs,
      listJobs: async (id, attempt) => {
        const key = `${id}/${attempt}`;
        seen.push(key);
        assert.ok(reports[key], `unexpected run attempt ${key}`);
        return reports[key];
      },
    }),
    3,
  );
  assert.deepEqual(seen, Object.keys(reports));
});

test('five admissions exhaust the budget without counting the current or foreign runs', async () => {
  const runs = [run(202, 2), ...[1, 2, 3, 4, 5, 6].map((id) => run(id))];
  const checked = [];
  assert.equal(
    await budget.countAdmittedAttempts({
      title,
      current,
      runs,
      isTrustedRun: (record) => record.id !== 1,
      listJobs: async (id, attempt) => {
        checked.push(`${id}/${attempt}`);
        return [receipt('success')];
      },
    }),
    5,
  );
  assert.deepEqual(checked, ['202/1', '2/1', '3/1', '4/1', '5/1']);
});

test('incomplete Actions history fails closed instead of creating a new budget', async () => {
  for (const runs of [[], [run(202)], [run(202, 2), run(201, null)]]) {
    await assert.rejects(() =>
      budget.countAdmittedAttempts({
        title,
        current,
        runs,
        listJobs: async () => [],
      }),
    );
  }
});

test('workflow CLI refuses the sixth attempt using read-only Actions history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pr-command-history-'));
  try {
    const event = join(root, 'event.json');
    const output = join(root, 'output');
    const logs = [
      ...[1, 2, 3, 4].map((id) => run(id)),
      run(current.id, current.attempt, 'pull_request_review_comment'),
    ].map((item) => ({
      ...item,
      head_branch: item.event === 'issue_comment' ? 'main' : 'fix/calendar',
      head_repository: { full_name: 'acme/calendar' },
    }));
    const pr = {
      number: 39,
      state: 'OPEN',
      headRepository: { nameWithOwner: 'acme/calendar' },
      headRefName: 'fix/calendar',
      baseRefName: 'main',
      headRefOid: 'a'.repeat(40),
      createdAt: '2026-11-20T12:00:00Z',
    };
    const command = {
      action: 'created',
      pull_request: { number: 39 },
      comment: {
        id: 456,
        body: '/oc REV-1',
        author_association: 'OWNER',
        user: { type: 'User' },
      },
      repository: { full_name: 'acme/calendar', default_branch: 'main' },
    };
    await writeFile(event, JSON.stringify(command));
    await writeFile(
      join(root, 'gh'),
      `#!/bin/sh
case "$*" in
  'pr view 39 '*) printf '%s\\n' '${JSON.stringify(pr)}';;
  'api --paginate --slurp repos/acme/calendar/actions/workflows/opencode.yml/runs?'*) printf '%s\\n' '${JSON.stringify([{ total_count: 5, workflow_runs: logs }])}';;
  'api --paginate --slurp repos/acme/calendar/actions/runs/'*'/attempts/1/jobs?'*) printf '%s\\n' '${JSON.stringify([{ total_count: 1, jobs: [receipt('success')] }])}';;
  *) exit 3;;
esac
`,
      { mode: 0o700 },
    );
    execFileSync(process.execPath, ['scripts/pr-command-limit.mjs'], {
      env: {
        ...process.env,
        PATH: `${root}${delimiter}${process.env.PATH}`,
        GITHUB_EVENT_PATH: event,
        GITHUB_EVENT_NAME: 'pull_request_review_comment',
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: 'acme/calendar',
        GITHUB_RUN_ID: String(current.id),
        GITHUB_RUN_ATTEMPT: String(current.attempt),
      },
    });
    assert.equal(
      await readFile(output, 'utf8'),
      `sha=${pr.headRefOid}\ndecision=limit_exhausted\nbase_ref=main\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
