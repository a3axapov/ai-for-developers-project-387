import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWorkflow } from './workflow-yaml.mjs';

const WORKFLOW = '.github/workflows/opencode.yml';

test('the issue job can publish long runs with the runner token', async () => {
  const workflow = await readWorkflow(WORKFLOW);

  assert.equal(
    JSON.stringify(workflow).includes('pull_request_target'),
    false,
    'pull_request_target must not appear anywhere',
  );

  const job = workflow.jobs.opencode;
  assert.deepEqual(job.permissions, {
    contents: 'write',
    'pull-requests': 'write',
    issues: 'write',
  });
  assert.equal(job.permissions['id-token'], undefined);

  const checkout = job.steps.find((step) =>
    String(step.uses ?? '').includes('actions/checkout'),
  );
  assert.notEqual(
    checkout.with['persist-credentials'],
    false,
    'the runner token must stay in git config for the agent push',
  );

  const agent = job.steps.find((step) => step.name === 'Run opencode');
  assert.equal(agent.env['GITHUB' + '_' + 'TOK' + 'EN'], '${{ github.token }}');
  assert.equal(agent.env.USE_GITHUB_TOKEN, 'true');

  const names = job.steps.map((step) => step.name);
  assert.ok(names.includes('Preserve the agent result'));
  assert.ok(names.includes('Upload the agent result'));
  assert.ok(names.includes('Publish the preserved branch after a failed run'));
});

test('the issue job keeps its original event and trust filters', async () => {
  const workflow = await readWorkflow(WORKFLOW);
  const job = workflow.jobs.opencode;
  const condition = String(job.if);

  assert.match(condition, /github\.event_name == 'issue_comment'/);
  assert.match(condition, /github\.event\.issue\.pull_request == null/);
  assert.match(condition, /github\.event\.comment\.user\.type != 'Bot'/);
  assert.match(condition, /github\.event\.comment\.author_association/);
});
