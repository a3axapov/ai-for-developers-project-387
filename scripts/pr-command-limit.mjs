#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { commandPrNumber, decidePrCommand } from './pr-command-gate.mjs';

const LIMIT = 5;
const SHA = /^[0-9a-f]{40}$/;
const MARKER =
  /^<!-- pr-command-limit pr=(\d+) command=((?:issue_comment|pull_request_review_comment):\d+) sha=[0-9a-f]{40} -->$/;

// Call under the per-PR Actions concurrency lock. A reservation belongs to a
// comment (not a run, rerun or head commit) and is never refunded.
export async function reservePrCommand({ event, eventName, runUrl, github }) {
  const number = commandPrNumber(event, eventName);
  if (!Number.isSafeInteger(number) || number < 1)
    return { decision: 'denied', reason: 'event:not-a-pull-request' };

  const pr = await github.getPullRequest(number);
  const gate = decidePrCommand({ event, eventName, pullRequest: pr });
  if (!gate.allowed)
    return { decision: 'denied', reason: gate.reasons.join(', ') };
  const { headRefOid: sha, baseRefName: baseRef, headRefName: headRef } = pr;
  const defaultBranch = event.repository?.default_branch;
  if (!defaultBranch || !baseRef || !headRef || !SHA.test(sha))
    throw new Error('Missing current PR branch or SHA');
  if (headRef === defaultBranch)
    return { decision: 'denied', reason: 'pull-request:protected-head' };

  const key = `${eventName}:${event.comment.id}`;
  const refused = (decision, reason, count) => ({
    decision,
    reason,
    sha,
    message: [
      `${decision}: команда агента не запущена (причина: \`${reason}\`${count === undefined ? '' : `; попытки: ${count}/${LIMIT}`}).`,
      `Head SHA: \`${sha}\``,
      `Лог запуска: ${runUrl}`,
    ].join('\n\n'),
  });

  const reserved = new Set();
  try {
    const comments = await github.listComments(number);
    for (const { body, user } of comments) {
      if (user?.type !== 'Bot' || user.login !== 'github-actions[bot]')
        continue;
      const match = MARKER.exec(body);
      if (match?.[1] === String(number)) reserved.add(match[2]);
    }
  } catch {
    return refused('error', 'cannot-read-reservations');
  }

  if (reserved.has(key))
    return refused(
      'already-reserved',
      'comment-already-reserved',
      reserved.size,
    );
  if (reserved.size >= LIMIT)
    return refused('limit-reached', 'budget-exhausted', reserved.size);
  try {
    await github.postComment(
      number,
      `<!-- pr-command-limit pr=${number} command=${key} sha=${sha} -->`,
    );
  } catch {
    return refused('error', 'cannot-write-reservation', reserved.size);
  }
  return { decision: 'allow', sha, baseRef };
}

const exec = promisify(execFile);
async function gh(...args) {
  const { stdout } = await exec('gh', args, {
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function main() {
  const env = process.env;
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  const endpoint = (number) =>
    `repos/${env.GITHUB_REPOSITORY}/issues/${number}/comments`;
  const github = {
    getPullRequest: (number) =>
      gh(
        'pr',
        'view',
        String(number),
        '--repo',
        env.GITHUB_REPOSITORY,
        '--json',
        'number,state,headRepository,isCrossRepository,headRefOid,headRefName,baseRefName',
      ),
    async listComments(number) {
      const pages = await gh(
        'api',
        '--paginate',
        '--slurp',
        `${endpoint(number)}?per_page=100`,
      );
      if (
        !Array.isArray(pages) ||
        pages.length === 0 ||
        !pages.every(Array.isArray)
      )
        throw new Error('Invalid comment pages');
      return pages.flat();
    },
    postComment: (number, body) =>
      gh('api', '--method', 'POST', endpoint(number), '-f', `body=${body}`),
  };
  const result = await reservePrCommand({
    event,
    eventName: env.GITHUB_EVENT_NAME,
    runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`,
    github,
  });
  if (result.decision === 'allow') {
    await appendFile(
      env.GITHUB_OUTPUT,
      `decision=allow\nsha=${result.sha}\nbase_ref=${result.baseRef}\n`,
    );
    console.log(`Reserved PR command for ${result.sha}`);
    return;
  }
  console.log(result.message ?? `${result.decision}: ${result.reason}`);
  if (result.message) {
    await appendFile(env.GITHUB_STEP_SUMMARY, `${result.message}\n`);
    if (result.decision !== 'already-reserved')
      await github.postComment(
        commandPrNumber(event, env.GITHUB_EVENT_NAME),
        result.message,
      );
  }
  if (result.decision === 'error') process.exitCode = 1;
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
