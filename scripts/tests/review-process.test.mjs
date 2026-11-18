import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

function includes(source, values, file) {
  for (const value of values) {
    assert.ok(source.includes(value), `${file} is missing: ${value}`);
  }
}

test('review docs point at the real workflows and cover every status', async () => {
  const readme = await read('README.md');
  const review = await read('docs/agents/review.md');

  for (const [file, source] of [
    ['README.md', readme],
    ['docs/agents/review.md', review],
  ]) {
    includes(
      source,
      [
        '.github/workflows/opencode.yml',
        '.github/workflows/opencode-review.yml',
        'reviewed@',
        'limit-reached',
        'error',
        'COMMENT',
      ],
      file,
    );
    assert.match(
      source,
      /5\s+(попыт|резерв)/,
      `${file} omits the attempt limit`,
    );
  }
});

test('process docs separate internal and GitHub review and keep the human gate', async () => {
  const agents = await read('AGENTS.md');
  const review = await read('docs/agents/review.md');
  const skill = await read('.agents/skills/implement-spec/SKILL.md');

  includes(
    agents,
    [
      'pr-command',
      'never merges',
      'Human gate',
      'auto-review comment never starts a fix',
    ],
    'AGENTS.md',
  );
  includes(
    review,
    [
      'Внутреннее ревью',
      'GitHub-авторевью',
      'required_approving_review_count',
      'self-approval',
      'Bootstrap-ограничение',
      'Остаточный риск',
      'Fallback',
    ],
    'docs/agents/review.md',
  );
  includes(
    skill,
    ['code-review', 'Never poll', '/oc', 'full `mise run check`'],
    '.agents/skills/implement-spec/SKILL.md',
  );
});
