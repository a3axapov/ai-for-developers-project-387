import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);

function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

function ignoreEntries(source) {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

test('release changelog stays out of prettier checks', async () => {
  const config = JSON.parse(await read('release-please-config.json'));
  const changelog = config.packages['.']['changelog-path'];

  assert.equal(
    changelog,
    'CHANGELOG.md',
    'release-please must keep generating CHANGELOG.md',
  );

  const ignored = ignoreEntries(await read('.prettierignore'));
  assert.ok(
    ignored.includes(changelog),
    `prettier --check must ignore ${changelog}: release-please generates it and it must not be edited by hand`,
  );
});
