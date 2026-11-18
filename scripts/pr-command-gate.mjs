#!/usr/bin/env node
// Decide whether an `/oc` comment may start the pull-request agent.
// The pure decision is the single source of truth for trusted actors; the CLI
// only reads JSON files and prints the decision so a workflow can gate on it.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const TRUSTED_ASSOCIATIONS = Object.freeze([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
]);

const COMMAND = /(?:^|[\s,;:(])\/(?:opencode|oc)(?=$|[\s,;:).!?])/i;

function repositoryFullName(repository) {
  if (!repository || typeof repository !== 'object') return undefined;
  if (typeof repository.nameWithOwner === 'string')
    return repository.nameWithOwner;
  if (typeof repository.full_name === 'string') return repository.full_name;
  const owner = repository.owner?.login ?? repository.owner?.name;
  if (typeof owner === 'string' && typeof repository.name === 'string')
    return `${owner}/${repository.name}`;
  return undefined;
}

export function decidePrCommand({
  event,
  pullRequest,
  eventName = 'issue_comment',
}) {
  const reasons = [];
  if (eventName !== 'issue_comment') reasons.push('event:not-issue-comment');

  const comment =
    event && typeof event === 'object' ? event.comment : undefined;
  const issue = event && typeof event === 'object' ? event.issue : undefined;
  if (!issue?.pull_request) reasons.push('event:not-a-pull-request');

  if (comment?.user?.type === 'Bot') reasons.push('author:bot');
  if (!TRUSTED_ASSOCIATIONS.includes(comment?.author_association))
    reasons.push('author:untrusted');
  if (!COMMAND.test(String(comment?.body ?? '')))
    reasons.push('command:missing');

  if (!pullRequest || typeof pullRequest !== 'object') {
    reasons.push('pull-request:missing');
  } else {
    if (String(pullRequest.state ?? '').toUpperCase() !== 'OPEN')
      reasons.push('pull-request:not-open');
    const head = repositoryFullName(pullRequest.headRepository);
    const base =
      repositoryFullName(pullRequest.baseRepository) ??
      repositoryFullName(event?.repository);
    const fork =
      pullRequest.isCrossRepository === true ||
      !head ||
      !base ||
      head.toLowerCase() !== base.toLowerCase();
    if (fork) reasons.push('pull-request:fork');
  }

  return { allowed: reasons.length === 0, reasons };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--event', '--pr'].includes(flag) || !value)
      throw new Error('Usage: pr-command-gate.mjs --event FILE --pr FILE');
    values[flag.slice(2)] = value;
  }
  if (!values.event || !values.pr)
    throw new Error('Usage: pr-command-gate.mjs --event FILE --pr FILE');
  return values;
}

async function readJson(path, label) {
  let source;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${label} JSON at ${path}: ${error.message}`, {
      cause: error,
    });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Cannot parse ${label} JSON at ${path}: ${error.message}`, {
      cause: error,
    });
  }
}

async function main() {
  const { event: eventPath, pr: prPath } = parseArguments(
    process.argv.slice(2),
  );
  const event = await readJson(eventPath, 'event');
  if (!event || typeof event !== 'object' || Array.isArray(event))
    throw new Error(`Event JSON at ${eventPath} must be an object`);
  const pullRequest = await readJson(prPath, 'pull request');
  const decision = decidePrCommand({
    event,
    pullRequest,
    eventName: process.env.GITHUB_EVENT_NAME || 'issue_comment',
  });
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`pr-command-gate: ${error.message}\n`);
    process.exit(2);
  });
}
