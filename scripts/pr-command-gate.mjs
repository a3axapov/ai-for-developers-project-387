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
const SUPPORTED_EVENT_NAMES = Object.freeze([
  'issue_comment',
  'pull_request_review_comment',
]);

export function commandPrNumber(event, eventName) {
  if (eventName === 'pull_request_review_comment')
    return event?.pull_request?.number;
  if (eventName === 'issue_comment' && event?.issue?.pull_request)
    return event.issue.number;
}

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
  if (!SUPPORTED_EVENT_NAMES.includes(eventName))
    reasons.push('event:unsupported');
  if (event?.action !== 'created') reasons.push('event:not-created');
  const number = commandPrNumber(event, eventName);
  if (!Number.isSafeInteger(number) || number < 1)
    reasons.push('event:not-a-pull-request');

  const comment = event?.comment;
  if (!Number.isSafeInteger(comment?.id) || comment.id < 1)
    reasons.push('comment:missing-id');
  if (comment?.user?.type === 'Bot') reasons.push('author:bot');
  else if (comment?.user?.type !== 'User') reasons.push('author:not-human');
  if (!TRUSTED_ASSOCIATIONS.includes(comment?.author_association))
    reasons.push('author:untrusted');
  if (!COMMAND.test(String(comment?.body ?? '')))
    reasons.push('command:missing');

  if (!pullRequest || typeof pullRequest !== 'object') {
    reasons.push('pull-request:missing');
  } else {
    if (number !== undefined && pullRequest.number !== number)
      reasons.push('pull-request:number-mismatch');
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

const USAGE =
  'Usage: pr-command-gate.mjs --event FILE --pr FILE [--event-name issue_comment|pull_request_review_comment]';

function parseArguments(argv) {
  const flags = {
    '--event': 'event',
    '--pr': 'pr',
    '--event-name': 'eventName',
  };
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const key = flags[flag];
    if (!key || !value) throw new Error(USAGE);
    values[key] = value;
  }
  if (!values.event || !values.pr) throw new Error(USAGE);
  if (
    values.eventName !== undefined &&
    !SUPPORTED_EVENT_NAMES.includes(values.eventName)
  ) {
    throw new Error(`${USAGE}\nUnsupported --event-name: ${values.eventName}`);
  }
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
  const {
    event: eventPath,
    pr: prPath,
    eventName,
  } = parseArguments(process.argv.slice(2));
  const event = await readJson(eventPath, 'event');
  if (!event || typeof event !== 'object' || Array.isArray(event))
    throw new Error(`Event JSON at ${eventPath} must be an object`);
  const pullRequest = await readJson(prPath, 'pull request');
  const decision = decidePrCommand({
    event,
    pullRequest,
    eventName: eventName ?? (process.env.GITHUB_EVENT_NAME || 'issue_comment'),
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
