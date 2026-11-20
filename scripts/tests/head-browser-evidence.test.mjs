import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readWorkflow } from './workflow-yaml.mjs';

test('browser evidence is captured from the exact PR head without model credentials', async () => {
  const workflow = await readWorkflow('.github/workflows/ci.yml');
  const job = workflow.jobs['head-browser-evidence'];
  assert.ok(job);
  assert.match(job.if, /github\.event_name == 'pull_request'/);
  assert.equal(
    job.steps[0].with.ref,
    '${{ github.event.pull_request.head.sha }}',
  );
  assert.equal(job.steps[0].with['persist-credentials'], false);
  const steps = JSON.stringify(job.steps);
  assert.match(steps, /git rev-parse HEAD/);
  assert.match(steps, /HEAD_SHA/);
  assert.match(steps, /--trace on/);
  assert.match(steps, /navigation\.spec\.ts/);
  assert.match(steps, /public-booking\.spec\.ts/);
  assert.match(steps, /--project desktop --project mobile/);
  assert.match(steps, /actions\/upload-artifact@[a-f0-9]{40}/);
  assert.doesNotMatch(JSON.stringify(job), /secrets\.|id-token/);
});
