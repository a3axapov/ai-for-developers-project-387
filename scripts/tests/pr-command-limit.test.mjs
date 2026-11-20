import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { reservePrCommand } from '../pr-command-limit.mjs';

const sha = 'a'.repeat(40);
const newSha = 'b'.repeat(40);
const runUrl = 'https://github.com/acme/app/actions/runs/123/attempts/1';
const repo = { nameWithOwner: 'acme/app' };

function journal() {
  const comments = [];
  const bot = { login: 'github-actions[bot]', type: 'Bot' };
  const state = {
    comments,
    pr: {
      number: 7,
      state: 'OPEN',
      headRepository: repo,
      headRefName: 'fix/calendar',
      baseRefName: 'main',
      headRefOid: sha,
    },
    async getPullRequest() {
      return state.pr;
    },
    async listComments() {
      return comments;
    },
    async postComment(_number, body) {
      comments.push({ body, user: bot });
    },
    command(id, eventName = 'issue_comment') {
      return reservePrCommand({
        event: {
          action: 'created',
          repository: { full_name: 'acme/app', default_branch: 'main' },
          issue: { number: 7, pull_request: {} },
          pull_request: { number: 7 },
          comment: {
            id,
            body: '/oc исправь REV-1',
            author_association: 'MEMBER',
            user: { type: 'User' },
          },
        },
        eventName,
        runUrl,
        github: state,
      });
    },
  };
  return state;
}

test('general and inline commands exhaust the same PR budget across head commits', async () => {
  const pr = journal();
  // Same numeric ID in the two GitHub APIs must not identify the same comment.
  assert.equal((await pr.command(1)).decision, 'allow');
  assert.equal(
    (await pr.command(1, 'pull_request_review_comment')).decision,
    'allow',
  );
  for (const id of [2, 3, 4]) {
    assert.equal((await pr.command(id)).decision, 'allow');
  }
  pr.pr.headRefOid = newSha;
  const rejected = await pr.command(5, 'pull_request_review_comment');
  assert.equal(rejected.decision, 'limit-reached');
  assert.match(rejected.message, /budget-exhausted.*5\/5/);
  assert.ok(rejected.message.includes(newSha));
  assert.ok(rejected.message.includes(runUrl));
  assert.equal(pr.comments.length, 5);
});

test('retry after a reservation does not call the model or spend again', async () => {
  const pr = journal();
  // Cancellation after the marker POST: no model result or completion marker.
  assert.equal((await pr.command(42)).decision, 'allow');
  pr.pr.headRefOid = newSha;
  assert.equal((await pr.command(42)).decision, 'already-reserved');
  assert.equal(pr.comments.length, 1);
  assert.equal((await pr.command(43)).decision, 'allow');
});

test('an interrupted or failed read or reservation never authorizes inference', async () => {
  const pr = journal();
  const apiError = async () => {
    throw new Error('GitHub unavailable');
  };
  const { listComments, postComment } = pr;
  pr.listComments = apiError;
  assert.equal((await pr.command(42)).decision, 'error');
  pr.listComments = listComments;
  pr.postComment = apiError;
  assert.equal((await pr.command(42)).decision, 'error');
  pr.postComment = postComment;
  assert.equal(pr.comments.length, 0);
  assert.equal((await pr.command(42)).decision, 'allow');
});

test('manual or autoreview markers cannot consume command budget', async () => {
  const pr = journal();
  assert.equal((await pr.command(1)).decision, 'allow');
  const { body, user } = pr.comments[0];
  pr.comments[0] = { body, user: { login: 'user', type: 'User' } };
  pr.comments.push({
    body: `<!-- review-run-limit pr=7 run=123.1 sha=${sha} -->`,
    user,
  });
  assert.equal((await pr.command(1)).decision, 'allow');
});

test('trust is checked again after queuing, before reserving', async () => {
  const pr = journal();
  for (const update of [
    { state: 'CLOSED' },
    { isCrossRepository: true },
    { headRefName: 'main' },
  ]) {
    const original = { ...pr.pr };
    Object.assign(pr.pr, update);
    assert.equal((await pr.command(42)).decision, 'denied');
    assert.equal(pr.comments.length, 0);
    pr.pr = original;
  }
});

test('the workflow CLI posts an exhaustion notice without an allow output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pr-command-limit-'));
  try {
    const state = journal();
    for (const id of [1, 2, 3, 4, 5]) await state.command(id);
    const files = Object.fromEntries(
      ['event', 'pr', 'comments', 'notice', 'summary', 'output'].map((name) => [
        name,
        join(root, name),
      ]),
    );
    await Promise.all([
      writeFile(files.pr, JSON.stringify({ ...state.pr, headRefOid: newSha })),
      writeFile(files.comments, JSON.stringify([state.comments])),
      writeFile(
        files.event,
        JSON.stringify({
          action: 'created',
          repository: { full_name: 'acme/app', default_branch: 'main' },
          pull_request: { number: 7 },
          comment: {
            id: 42,
            body: '/opencode REV-2',
            author_association: 'OWNER',
            user: { type: 'User' },
          },
        }),
      ),
      writeFile(files.output, ''),
      writeFile(
        join(root, 'gh'),
        `#!/bin/sh
case "$1 $2" in
  'pr view') cat "$FIXTURE_PR";;
  'api --paginate') cat "$FIXTURE_COMMENTS";;
  'api --method') printf '%s' "\${6#body=}" > "$FIXTURE_NOTICE"
                  printf '{}\\n';;
  *) exit 2;;
esac
`,
        { mode: 0o700 },
      ),
    ]);
    const log = execFileSync(
      process.execPath,
      ['scripts/pr-command-limit.mjs'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${root}${delimiter}${process.env.PATH}`,
          GITHUB_EVENT_NAME: 'pull_request_review_comment',
          GITHUB_EVENT_PATH: files.event,
          GITHUB_OUTPUT: files.output,
          GITHUB_STEP_SUMMARY: files.summary,
          GITHUB_SERVER_URL: 'https://github.com',
          GITHUB_REPOSITORY: 'acme/app',
          GITHUB_RUN_ID: '123',
          GITHUB_RUN_ATTEMPT: '1',
          FIXTURE_PR: files.pr,
          FIXTURE_COMMENTS: files.comments,
          FIXTURE_NOTICE: files.notice,
        },
      },
    );
    const notice = await readFile(files.notice, 'utf8');
    assert.match(notice, /^limit-reached: .*`budget-exhausted`.*5\/5/);
    assert.ok(notice.includes(newSha));
    assert.ok(notice.includes(runUrl));
    assert.equal(log.trim(), notice);
    assert.equal((await readFile(files.summary, 'utf8')).trim(), notice);
    assert.equal(await readFile(files.output, 'utf8'), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
