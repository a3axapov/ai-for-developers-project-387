#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { commandPrNumber, decidePrCommand } from './pr-command-gate.mjs';

const LIMIT = 5;
const SHA = /^[0-9a-f]{40}$/;
const RECEIPT_STEP = 'Record admitted PR command';
const COMMENT_EVENTS = ['issue_comment', 'pull_request_review_comment'];

// The job concurrency group serializes admissions across both event types.
// GitHub's per-attempt job metadata, not PR comments or runner log text, is the
// ledger. The agent only has actions:read and cannot change past step results.
export async function countAdmittedAttempts({
  title,
  current,
  runs,
  listJobs,
  isTrustedRun = () => true,
}) {
  const matching = runs.filter(
    (run) =>
      run.display_title === title &&
      COMMENT_EVENTS.includes(run.event) &&
      isTrustedRun(run),
  );
  if (
    !matching.some(
      (run) => run.id === current.id && run.run_attempt === current.attempt,
    )
  )
    throw new Error('Current attempt missing from Actions history');
  let count = 0;
  for (const run of matching) {
    if (
      !Number.isSafeInteger(run.id) ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt < 1
    )
      throw new Error('Malformed Actions run');
    const last = run.id === current.id ? current.attempt - 1 : run.run_attempt;
    for (let attempt = 1; attempt <= last; attempt++) {
      const jobs = await listJobs(run.id, attempt);
      const receipt = jobs
        .find((job) => job.name === 'pr-command')
        ?.steps?.find((step) => step.name === RECEIPT_STEP);
      if (
        receipt?.started_at &&
        (['success', 'cancelled', 'failure', 'timed_out'].includes(
          receipt.conclusion,
        ) ||
          receipt.status === 'in_progress')
      ) {
        count++;
        if (count === LIMIT) return count;
      }
    }
  }
  return count;
}

const exec = promisify(execFile);
async function gh(...args) {
  const { stdout } = await exec('gh', args, {
    timeout: 30_000,
    maxBuffer: 24 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function collection(endpoint, key) {
  const pages = await gh('api', '--paginate', '--slurp', endpoint);
  if (
    !Array.isArray(pages) ||
    !pages.length ||
    !pages.every((page) => Array.isArray(page[key]))
  )
    throw new Error(`Invalid Actions ${key} pages`);
  const items = pages.flatMap((page) => page[key]);
  const ids = new Set(items.map((item) => item.id));
  if (
    !Number.isSafeInteger(pages[0].total_count) ||
    pages[0].total_count > ids.size ||
    ids.size !== items.length
  )
    throw new Error(`Incomplete Actions ${key} history`);
  return items;
}

async function main() {
  const env = process.env;
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  const eventName = env.GITHUB_EVENT_NAME;
  const number = commandPrNumber(event, eventName);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('Missing pull request number');
  const pr = await gh(
    'pr',
    'view',
    String(number),
    '--repo',
    env.GITHUB_REPOSITORY,
    '--json',
    'number,state,headRepository,isCrossRepository,headRefOid,headRefName,baseRefName,createdAt',
  );
  const gate = decidePrCommand({ event, eventName, pullRequest: pr });
  const defaultBranch = event.repository?.default_branch;
  if (!gate.allowed || pr.headRefName === defaultBranch) {
    await appendFile(env.GITHUB_OUTPUT, 'decision=denied\n');
    console.log(
      `Denied: ${gate.reasons.join(', ') || 'pull-request:protected-head'}`,
    );
    return;
  }
  const { headRefOid: sha, baseRefName: baseRef } = pr;
  if (
    !defaultBranch ||
    !baseRef ||
    !pr.headRefName ||
    !SHA.test(sha) ||
    !pr.createdAt
  )
    throw new Error('Missing current PR branch, SHA or creation time');
  await appendFile(env.GITHUB_OUTPUT, `sha=${sha}\n`);

  const root = `repos/${env.GITHUB_REPOSITORY}/actions`;
  const created = encodeURIComponent(`>=${pr.createdAt}`);
  const runs = await collection(
    `${root}/workflows/opencode.yml/runs?per_page=100&created=${created}`,
    'workflow_runs',
  );
  const count = await countAdmittedAttempts({
    title: `opencode PR #${number}`,
    current: {
      id: Number(env.GITHUB_RUN_ID),
      attempt: Number(env.GITHUB_RUN_ATTEMPT),
    },
    runs,
    isTrustedRun: (run) =>
      run.head_repository?.full_name === env.GITHUB_REPOSITORY &&
      run.head_branch ===
        (run.event === 'issue_comment' ? defaultBranch : pr.headRefName),
    listJobs: (id, attempt) =>
      collection(
        `${root}/runs/${id}/attempts/${attempt}/jobs?per_page=100`,
        'jobs',
      ),
  });
  await appendFile(
    env.GITHUB_OUTPUT,
    `decision=${count >= LIMIT ? 'limit_exhausted' : 'allow'}\nbase_ref=${baseRef}\n`,
  );
  console.log(
    `PR command budget: ${count}/${LIMIT} admitted attempts before this run`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`pr-command-limit: ${error.message}`);
    process.exitCode = 1;
  });
}
