import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { auditContext, publication } from '../lighthouse-audit.mjs';
import { readWorkflow } from './workflow-yaml.mjs';

const url = 'https://calendar-2klv.onrender.com/booking/owner';
const runUrl = 'https://github.com/acme/calendar/actions/runs/42';

test('a prepared demo finding creates one explicitly educational issue', () => {
  const context = auditContext('demo', url);
  const plan = publication(
    context,
    { auditId: 'demo-render-blocking', action: 'Отложить учебный скрипт.' },
    [],
    runUrl,
  );

  assert.equal(plan.kind, 'create');
  assert.match(plan.title, /^\[Учебный\]/);
  assert.ok(plan.body.includes(url));
  assert.ok(plan.body.includes(runUrl));
  assert.match(plan.body, /не подтверждённый дефект/);
  assert.match(plan.body, /Отложить учебный скрипт/);
});

test('a repeat points to the same closed issue without planning a write', () => {
  const context = auditContext('demo', url);
  const decision = {
    auditId: 'demo-render-blocking',
    action: 'Отложить скрипт.',
  };
  const first = publication(context, decision, [], runUrl);
  const issueUrl = 'https://github.com/acme/calendar/issues/9';
  const again = publication(
    context,
    decision,
    [{ state: 'closed', html_url: issueUrl, body: first.body }],
    runUrl.replace('42', '43'),
  );
  assert.deepEqual(again, {
    kind: 'duplicate',
    url: issueUrl,
    state: 'closed',
  });
});

test('a valid live report without actionable evidence records no finding only once', () => {
  const report = {
    fetchTime: '2026-11-19T00:00:00.000Z',
    requestedUrl: url,
    finalDisplayedUrl: url,
    categories: { performance: { score: 0.23 } },
    audits: { 'speed-index': { score: 0.01 } },
  };
  const context = auditContext('live', url, report);
  const journal = { html_url: 'https://github.com/acme/calendar/issues/5' };
  const first = publication(context, { auditId: null }, [], runUrl, journal);
  assert.equal(first.kind, 'journal-comment');
  assert.match(first.body, /Нет находок/);
  assert.ok(first.body.includes(runUrl));
  const again = publication(context, { auditId: null }, [], runUrl, journal, [
    { body: first.body, html_url: `${journal.html_url}#issuecomment-3` },
  ]);
  assert.equal(again.kind, 'journal-existing');
  assert.equal(again.url, `${journal.html_url}#issuecomment-3`);
});

test('a malformed or failed live report cannot become a clean result', () => {
  assert.throws(() => auditContext('live', url, {}), /невалиден/);
  assert.throws(
    () => auditContext('live', url, { runtimeError: { code: 'NO_FCP' } }),
    /невалиден/,
  );
});

test('a live booking report supplies measured evidence and rejects fabricated IDs', () => {
  const context = auditContext('live', url, {
    fetchTime: '2026-11-19T00:00:00.000Z',
    requestedUrl: url,
    finalDisplayedUrl: url,
    categories: { performance: { score: 0.9 } },
    audits: {
      'render-blocking-resources': {
        score: 0.1,
        details: { overallSavingsMs: 120 },
      },
      'unused-javascript': {
        score: 0.4,
        details: { overallSavingsBytes: 10239 },
      },
    },
  });

  assert.deepEqual(
    context.candidates.map(({ id }) => id),
    ['render-blocking-resources'],
  );
  const plan = publication(
    context,
    {
      auditId: 'render-blocking-resources',
      action: 'Отложить загрузку ресурса.',
    },
    [],
    runUrl,
  );
  assert.match(plan.body, /120 мс/);
  assert.doesNotMatch(plan.title, /\[Учебный\]/);
  assert.throws(() =>
    publication(context, { auditId: 'made-up', action: 'Текст' }, [], runUrl),
  );
});

test('the demo report and final OpenCode response cross the CLI boundary', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'lighthouse-audit-test-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const report = join(directory, 'report.json');
  const log = join(directory, 'agent.log');
  const output = join(directory, 'github-output');
  const env = {
    ...process.env,
    APP_URL: new URL(url).origin,
    GITHUB_OUTPUT: output,
  };
  const cli = (args) =>
    execFileSync(process.execPath, ['scripts/lighthouse-audit.mjs', ...args], {
      env,
      encoding: 'utf8',
    });

  writeFileSync(report, cli(['demo']));
  assert.match(readFileSync(report, 'utf8'), /данные синтетические/);
  writeFileSync(
    log,
    'opencode session test\nResponse: {"auditId":"demo-render-blocking","action":"Отложить скрипт."}\n',
  );
  cli(['decision', 'demo', report, log]);
  const result = JSON.parse(
    readFileSync(output, 'utf8').trim().slice('result='.length),
  );
  assert.equal(result.context.url, url);
  assert.equal(result.decision.auditId, 'demo-render-blocking');
});

test('the daily workflow shares a lock and only the publisher can write issues', async () => {
  const workflow = await readWorkflow('.github/workflows/lighthouse-audit.yml');
  assert.deepEqual(workflow.on.schedule, [{ cron: '0 0 * * *' }]);
  assert.equal(workflow.on.workflow_dispatch.inputs.mode.default, 'live');
  assert.deepEqual(workflow.concurrency, {
    group: 'lighthouse-audit',
    'cancel-in-progress': false,
  });
  assert.deepEqual(workflow.jobs.audit.permissions, {
    contents: 'read',
    issues: 'read',
  });
  assert.deepEqual(workflow.jobs.publish.permissions, {
    contents: 'read',
    issues: 'write',
  });
  assert.equal(workflow.jobs.publish.needs, 'audit');
  assert.ok(workflow.jobs.audit['timeout-minutes'] > 0);
});
