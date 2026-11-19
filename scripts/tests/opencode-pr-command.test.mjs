import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TRUSTED_ASSOCIATIONS, decidePrCommand } from '../pr-command-gate.mjs';
import { readWorkflow } from './workflow-yaml.mjs';

const sameRepo = { nameWithOwner: 'acme/app' };

function event(overrides = {}) {
  return {
    issue: {
      number: 7,
      pull_request: {
        url: 'https://api.github.com/repos/acme/app/pulls/7',
      },
    },
    comment: {
      body: '/oc исправь REV-1',
      author_association: 'MEMBER',
      user: { type: 'User', login: 'maintainer' },
    },
    repository: { full_name: 'acme/app' },
    ...overrides,
  };
}

function pullRequest(overrides = {}) {
  return {
    number: 7,
    state: 'OPEN',
    headRepository: sameRepo,
    baseRepository: sameRepo,
    isCrossRepository: false,
    ...overrides,
  };
}

function decide(overrides = {}) {
  return decidePrCommand({
    event: event(overrides.event),
    pullRequest: pullRequest(overrides.pullRequest),
    eventName: overrides.eventName ?? 'issue_comment',
  });
}

function environmentWithout(...names) {
  const env = { ...process.env };
  for (const name of names) delete env[name];
  return env;
}

async function writeGateFixture(directory, prOverrides = {}) {
  const eventPath = join(directory, 'event.json');
  const prPath = join(directory, 'pr.json');
  await writeFile(eventPath, JSON.stringify(event()));
  await writeFile(prPath, JSON.stringify(pullRequest(prOverrides)));
  return { eventPath, prPath };
}

test('trusted authors in a same-repository pull request are allowed', () => {
  assert.deepEqual(TRUSTED_ASSOCIATIONS, ['OWNER', 'MEMBER', 'COLLABORATOR']);
  for (const association of TRUSTED_ASSOCIATIONS) {
    const result = decide({
      event: {
        comment: {
          ...event().comment,
          author_association: association,
        },
      },
    });
    assert.deepEqual(result, { allowed: true, reasons: [] }, association);
  }
});

test('a pull request from a fork is denied', () => {
  const result = decide({
    pullRequest: {
      headRepository: { nameWithOwner: 'fork/app' },
    },
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('pull-request:fork'));
});

test('a cross-repository flag denies even when names look equal', () => {
  const result = decide({ pullRequest: { isCrossRepository: true } });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('pull-request:fork'));
});

test('a bot comment is denied', () => {
  const result = decide({
    event: {
      comment: {
        ...event().comment,
        user: { type: 'Bot', login: 'github-actions[bot]' },
      },
    },
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('author:bot'));
});

test('an author without write access is denied', () => {
  for (const association of ['CONTRIBUTOR', 'FIRST_TIMER', 'NONE', '']) {
    const result = decide({
      event: {
        comment: {
          ...event().comment,
          author_association: association,
        },
      },
    });
    assert.equal(result.allowed, false, association);
    assert.ok(result.reasons.includes('author:untrusted'), association);
  }
});

test('a comment on a plain issue is denied', () => {
  const result = decide({
    event: {
      issue: { number: 7 },
    },
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('event:not-a-pull-request'));
});

test('a comment without the command mention is denied', () => {
  const result = decide({
    event: {
      comment: { ...event().comment, body: 'выглядит хорошо' },
    },
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('command:missing'));
});

test('a closed pull request is denied', () => {
  for (const state of ['CLOSED', 'MERGED', 'closed']) {
    const result = decide({ pullRequest: { state } });
    assert.equal(result.allowed, false, state);
    assert.ok(result.reasons.includes('pull-request:not-open'), state);
  }
});

test('an event other than issue_comment is denied', () => {
  const result = decide({ eventName: 'pull_request' });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('event:not-issue-comment'));
});

test('a missing pull request payload is denied', () => {
  const result = decidePrCommand({
    event: event(),
    pullRequest: null,
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('pull-request:missing'));
});

test('gate CLI prints the decision and exits zero for denied input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pr-gate-'));
  try {
    const { eventPath, prPath } = await writeGateFixture(directory, {
      headRepository: { nameWithOwner: 'fork/app' },
    });
    const result = spawnSync(
      process.execPath,
      ['scripts/pr-command-gate.mjs', '--event', eventPath, '--pr', prPath],
      { encoding: 'utf8', env: environmentWithout('GITHUB_EVENT_NAME') },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      allowed: false,
      reasons: ['pull-request:fork'],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('gate CLI obeys --event-name over an unrelated GITHUB_EVENT_NAME', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pr-gate-'));
  try {
    const { eventPath, prPath } = await writeGateFixture(directory, {
      headRepository: { nameWithOwner: 'fork/app' },
    });
    const result = spawnSync(
      process.execPath,
      [
        'scripts/pr-command-gate.mjs',
        '--event',
        eventPath,
        '--pr',
        prPath,
        '--event-name',
        'issue_comment',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request' },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      allowed: false,
      reasons: ['pull-request:fork'],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('gate CLI defaults to issue_comment when GITHUB_EVENT_NAME is unset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pr-gate-'));
  try {
    const { eventPath, prPath } = await writeGateFixture(directory, {
      headRepository: { nameWithOwner: 'fork/app' },
    });
    const result = spawnSync(
      process.execPath,
      ['scripts/pr-command-gate.mjs', '--event', eventPath, '--pr', prPath],
      { encoding: 'utf8', env: environmentWithout('GITHUB_EVENT_NAME') },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      allowed: false,
      reasons: ['pull-request:fork'],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('gate CLI exits non-zero for unusable input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pr-gate-'));
  try {
    const eventPath = join(directory, 'event.json');
    await writeFile(eventPath, '{not json');
    for (const args of [
      [],
      ['--event', eventPath],
      ['--event', join(directory, 'missing.json'), '--pr', eventPath],
      ['--event', eventPath, '--pr', eventPath],
      ['--event', eventPath, '--pr', eventPath, '--event-name'],
      ['--event', eventPath, '--pr', eventPath, '--event-name', 'pull_request'],
    ]) {
      const result = spawnSync(
        process.execPath,
        ['scripts/pr-command-gate.mjs', ...args],
        { encoding: 'utf8', env: environmentWithout('GITHUB_EVENT_NAME') },
      );
      assert.notEqual(result.status, 0, args.join(' '));
      assert.match(result.stderr, /\S/);
      assert.equal(result.stdout.trim(), '');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const WORKFLOW_PATH = resolve('.github/workflows/opencode.yml');
const PR_JOB = 'pr-command';
const PR_COMMAND = 'docs/agents/pr-command.md';

function stepRuns(job) {
  return (job.steps ?? []).map((step) => String(step.run ?? ''));
}

function assertNoMainPush(job) {
  for (const run of stepRuns(job)) {
    assert.doesNotMatch(run, /git\s+push\b[^\n]*\bmain\b/);
    assert.doesNotMatch(run, /git\s+push\b[^\n]*(--force\b|\s-f\b)/);
  }
}

export function assertPrCommandWorkflow(workflow) {
  assert.deepEqual(Object.keys(workflow.on), ['issue_comment']);
  assert.deepEqual(workflow.on.issue_comment.types, ['created']);
  assert.equal(
    JSON.stringify(workflow).includes('pull_request_target'),
    false,
    'pull_request_target must not appear anywhere',
  );

  const issueJob = workflow.jobs.opencode;
  assert.ok(issueJob, 'issue job must stay');
  assert.match(
    String(issueJob.if),
    /github\.event\.issue\.pull_request == null/,
    'the issue job must keep excluding PR comments',
  );

  const gate = workflow.jobs.gate;
  assert.ok(gate, 'gate job must exist');
  assert.deepEqual(gate.permissions, {
    contents: 'read',
    'pull-requests': 'read',
  });
  assert.equal(gate.outputs?.allowed, '${{ steps.gate.outputs.allowed }}');
  const gateRuns = stepRuns(gate);
  assert.ok(
    gateRuns.some((run) => run.includes('scripts/pr-command-gate.mjs')),
    'the gate job must run the decision script',
  );
  assert.ok(
    gateRuns.some(
      (run) => run.includes('gh pr view') && run.includes('headRepository'),
    ),
    'the gate needs head repository data for the same-repository check',
  );

  const job = workflow.jobs[PR_JOB];
  assert.ok(job, 'the PR command job must exist separately');
  assert.equal(job.needs, 'gate');
  assert.equal(job.if, "needs.gate.outputs.allowed == 'true'");
  assert.deepEqual(job.permissions, {
    contents: 'write',
    'pull-requests': 'write',
    issues: 'write',
    actions: 'read',
    checks: 'read',
    'id-token': 'write',
  });
  assert.equal(job['timeout-minutes'], 120);
  assert.deepEqual(job.concurrency, {
    group: 'opencode-pr-${{ github.event.issue.number }}',
    'cancel-in-progress': false,
  });

  const checkout = job.steps.find((step) =>
    String(step.uses ?? '').includes('actions/checkout'),
  );
  assert.ok(checkout, 'the PR job must check out the pull request head');
  assert.equal(
    checkout.with.ref,
    'refs/pull/${{ github.event.issue.number }}/head',
  );
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.equal(checkout.with['persist-credentials'], false);

  const prepare = job.steps.find((step) =>
    String(step.run ?? '').includes('git fetch'),
  );
  assert.ok(prepare, 'the PR job must fetch the base branch');
  assert.match(String(prepare.run), /baseRefName|baseRefOid/);
  assert.ok(
    job.steps.some(
      (step) =>
        String(step.run ?? '').includes('GITHUB_OUTPUT') &&
        /base_sha/.test(String(step.run)),
    ),
    'the PR job must record the base SHA',
  );

  const agent = job.steps.find(
    (step) => String(step.run ?? '').trim() === 'opencode github run',
  );
  assert.ok(agent, 'the agent step must run opencode github run');
  assert.equal(agent['timeout-minutes'], 60);
  assert.equal(agent.env.SHARE, 'false');
  assert.equal(agent.env.MENTIONS, '/opencode,/oc');
  assert.equal(agent.env.MODEL, 'opencode/deepseek-v4.1-flash');
  const config = JSON.parse(agent.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.instructions, [PR_COMMAND]);
  assert.equal(config.permission.external_directory, 'deny');
  assert.equal(config.permission.doom_loop, 'deny');

  assert.equal(job.permissions['id-token'], 'write');
  assertNoMainPush(job);
}

test('the /oc PR workflow satisfies the contract', async () => {
  assertPrCommandWorkflow(await readWorkflow(WORKFLOW_PATH));
});

test('the contract rejects unsafe workflow variants', async () => {
  const workflow = await readWorkflow(WORKFLOW_PATH);
  const variants = {
    'pull_request_target trigger': (clone) => {
      clone.on.pull_request_target = { types: ['created'] };
    },
    'no gate wiring': (clone) => {
      delete clone.jobs[PR_JOB].needs;
      delete clone.jobs[PR_JOB].if;
    },
    'read-only contents': (clone) => {
      clone.jobs[PR_JOB].permissions.contents = 'read';
    },
    'cancelling concurrency': (clone) => {
      clone.jobs[PR_JOB].concurrency['cancel-in-progress'] = true;
    },
    'agent step without the instruction file': (clone) => {
      const agent = clone.jobs[PR_JOB].steps.find(
        (step) => String(step.run ?? '').trim() === 'opencode github run',
      );
      agent.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        permission: { external_directory: 'deny', doom_loop: 'deny' },
      });
    },
    'push to main in a step': (clone) => {
      clone.jobs[PR_JOB].steps.push({ run: 'git push origin HEAD:main' });
    },
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const clone = JSON.parse(JSON.stringify(workflow));
    mutate(clone);
    assert.throws(
      () => assertPrCommandWorkflow(clone),
      assert.AssertionError,
      name,
    );
  }
});

test('the agent instructions demand verifiable evidence and safe boundaries', async () => {
  const instructions = await readFile(PR_COMMAND, 'utf8');
  for (const requirement of [
    'REVIEW.md',
    'BASE_REF_NAME',
    'BASE_SHA',
    'git rev-parse HEAD',
    'mise run test:tools',
    'npm run lint',
    'mise run check',
    'код возврата',
    'число тестов',
    'gh pr checks',
    'Conventional Commits',
    'отдельн',
  ]) {
    assert.ok(
      instructions.includes(requirement),
      `instructions must mention ${requirement}`,
    );
  }
  assert.match(instructions, /не\s+(?:мержить|выполнять\s+merge)/i);
  assert.match(instructions, /не\s+пушить\s+в\s+`?main`?/i);
  assert.match(instructions, /не\s+(?:выдумывать|придумывать)/i);
});

test('gate accepts the gh pr view shape, which has no baseRepository field', () => {
  const result = decidePrCommand({
    event: event(),
    pullRequest: {
      number: 7,
      state: 'OPEN',
      isCrossRepository: false,
      headRepository: { nameWithOwner: 'acme/app' },
    },
  });
  assert.deepEqual(result, { allowed: true, reasons: [] });
});

test('gate denies a fork when the base comes from the event repository', () => {
  const result = decidePrCommand({
    event: event({ repository: { full_name: 'acme/app' } }),
    pullRequest: {
      number: 7,
      state: 'OPEN',
      isCrossRepository: true,
      headRepository: { nameWithOwner: 'fork/app' },
    },
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('pull-request:fork'));
});
