#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const COMMENT_PATH = /^\/([^/]+\/[^/]+)\/issues\/(\d+)$/;
const COMMENT_FRAGMENT = /^#issuecomment-(\d+)$/;
const APPROVAL_FIELD =
  /^[ \t]*(?:[-*][ \t]+)?Согласование человеком:[ \t]*(.*)$/im;

export async function getApproval({ body, repository, getComment }) {
  const field = APPROVAL_FIELD.exec(body ?? '')?.[1] ?? '';
  const links = [...new Set(field.match(/https:\/\/[^\s<>()]+/g) ?? [])];
  if (links.length !== 1)
    return {
      status: 'unavailable',
      reason: links.length ? 'ambiguous-links' : 'missing-link',
    };
  const url = links[0];
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { status: 'unavailable', reason: 'invalid-link', url };
  }
  const [, repo, issue] = COMMENT_PATH.exec(parsed.pathname) ?? [];
  const [, id] = COMMENT_FRAGMENT.exec(parsed.hash) ?? [];
  if (
    parsed.origin !== 'https://github.com' ||
    repo?.toLowerCase() !== repository.toLowerCase() ||
    !id
  )
    return { status: 'unavailable', reason: 'foreign-link', url };
  try {
    const comment = await getComment(id);
    if (
      comment.issue_url?.toLowerCase() !==
        `https://api.github.com/repos/${repository}/issues/${issue}`.toLowerCase() ||
      comment.user?.type !== 'User' ||
      !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(
        comment.author_association,
      ) ||
      typeof comment.body !== 'string'
    )
      return { status: 'unavailable', reason: 'untrusted-comment', url };
    return {
      status: 'available',
      url,
      author: comment.user.login,
      body: comment.body,
    };
  } catch {
    return { status: 'unavailable', reason: 'cannot-read-comment', url };
  }
}

async function main() {
  const { body } = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const repository = process.env.GITHUB_REPOSITORY;
  const result = await getApproval({
    body,
    repository,
    async getComment(id) {
      const { stdout } = await promisify(execFile)(
        'gh',
        ['api', `repos/${repository}/issues/comments/${id}`],
        { timeout: 15_000, maxBuffer: 512 * 1024 },
      );
      return JSON.parse(stdout);
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`review-approval: ${error.message}`);
    process.exitCode = 1;
  });
}
