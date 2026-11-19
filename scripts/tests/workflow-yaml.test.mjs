import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkflow, readWorkflow } from './workflow-yaml.mjs';

test('parseWorkflow keeps trigger names and block scalars intact', () => {
  const document = parseWorkflow(`name: fixture
on:
  issue_comment:
    types: [created]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "on: not a mapping"
`);
  assert.equal(document.name, 'fixture');
  assert.deepEqual(document.on.issue_comment.types, ['created']);
  assert.equal(document.jobs.gate.steps[0].run, 'echo "on: not a mapping"\n');
});

test('parseWorkflow rejects a document that is not a mapping', () => {
  assert.throws(() => parseWorkflow('- just\n- a list\n'), TypeError);
});

test('readWorkflow loads and parses a workflow file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-yaml-'));
  try {
    const path = join(directory, 'workflow.yml');
    await writeFile(path, 'name: from-file\njobs: {}\n');
    assert.deepEqual(await readWorkflow(path), {
      name: 'from-file',
      jobs: {},
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
