import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readWorkflow } from './workflow-yaml.mjs';

const WORKFLOW_PATH = resolve('.github/workflows/opencode-review.yml');

function allRuns(workflow) {
  return Object.values(workflow.jobs ?? {}).flatMap((job) =>
    (job.steps ?? []).map((step) => String(step.run ?? '')),
  );
}

function findStep(workflow, predicate) {
  return workflow.jobs.review.steps.find(predicate);
}

function limitStep(workflow) {
  return findStep(
    workflow,
    (step) =>
      step.id === 'limit' ||
      String(step.run ?? '').includes('review-run-limit.mjs'),
  );
}

function modelStep(workflow) {
  return findStep(workflow, (step) =>
    /opencode\s+run\b/.test(String(step.run ?? '')),
  );
}

function publishStep(workflow) {
  return findStep(workflow, (step) =>
    String(step.run ?? '').includes('publish-review.mjs'),
  );
}

function statusSteps(workflow) {
  return workflow.jobs.review.steps.filter((step) =>
    /limit-reached|error:/.test(String(step.run ?? '')),
  );
}

function waitStep(workflow) {
  return findStep(
    workflow,
    (step) =>
      /CI pending/.test(String(step.run ?? '')) &&
      /check-runs/.test(String(step.run ?? '')),
  );
}

function stageStep(workflow) {
  return findStep(workflow, (step) =>
    /git archive/.test(String(step.run ?? '')),
  );
}

function reviewerConfig(step) {
  return JSON.parse(step.env.OPENCODE_CONFIG_CONTENT);
}

export function assertReviewWorkflow(workflow) {
  assert.deepEqual(Object.keys(workflow.on), ['pull_request']);
  assert.deepEqual(workflow.on.pull_request.types, [
    'opened',
    'synchronize',
    'reopened',
    'ready_for_review',
    'edited',
  ]);
  assert.equal(
    JSON.stringify(workflow).includes('pull_request_target'),
    false,
    'pull_request_target must not appear anywhere',
  );

  const job = workflow.jobs.review;
  assert.ok(job, 'the review job must exist');

  assert.match(
    String(job.if),
    /github\.event\.pull_request\.draft == false/,
    'draft pull requests must be filtered out',
  );
  assert.match(
    String(job.if),
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
    'fork pull requests must be filtered out',
  );
  assert.match(
    String(job.if),
    /contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.pull_request\.author_association\)/,
    'the trusted association allowlist must be explicit',
  );
  assert.match(
    String(job.if),
    /github\.event\.action != 'edited'/,
    'edited events must require a body change',
  );
  assert.match(String(job.if), /github\.event\.changes\.body != null/);
  // The two conditions are only safe together: an `edited` event without a
  // body change must short-circuit before the body check is evaluated.
  assert.match(
    String(job.if),
    /github\.event\.action != 'edited'\s*\|\|\s*github\.event\.changes\.body != null/,
    'edited events must be guarded by the body-change condition in one expression',
  );
  const allowedBots = [
    ...String(job.if).matchAll(/user\.login == '([^']+)'/g),
  ].map((match) => match[1]);
  assert.deepEqual(allowedBots, ['opencode-agent[bot]']);
  for (const bot of ['dependabot', 'github-actions', 'release-please'])
    assert.equal(
      String(job.if).includes(bot),
      false,
      `${bot} must fall back to manual review`,
    );

  const concurrency = workflow.concurrency ?? job.concurrency;
  assert.deepEqual(concurrency, {
    group: 'review-${{ github.event.pull_request.number }}',
    'cancel-in-progress': true,
  });
  assert.equal(job['timeout-minutes'], 75);

  assert.deepEqual(job.permissions, {
    contents: 'read',
    'pull-requests': 'write',
    issues: 'write',
    actions: 'read',
    checks: 'read',
    statuses: 'read',
  });
  assert.equal(JSON.stringify(workflow).includes('id-token'), false);
  assert.deepEqual(workflow.permissions, {});
  for (const job of Object.values(workflow.jobs))
    assert.notEqual(
      job.permissions?.contents,
      'write',
      'no job may write to the repository contents',
    );

  const checkout = job.steps.find((step) =>
    String(step.uses ?? '').includes('actions/checkout'),
  );
  assert.ok(checkout, 'the reviewed commit must be checked out');
  assert.equal(
    checkout.with.ref,
    '${{ github.event.pull_request.head.sha }}',
    'checkout the head SHA, never the merge ref',
  );
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(
    JSON.stringify(workflow).includes('/merge'),
    false,
    'the merge ref must never be used',
  );

  const context = job.steps.find(
    (step) =>
      String(step.run ?? '').includes('git diff') &&
      String(step.run ?? '').includes('.review'),
  );
  assert.ok(context, 'a step must prepare the review context');
  const contextRun = String(context.run);
  assert.match(
    contextRun,
    /--unified=0/,
    'inline anchors need a unified=0 diff',
  );
  assert.match(
    contextRun,
    /git diff[^\n]*\$?BASE[^\n]*\.\.\./,
    'the diff must use base...head',
  );
  assert.match(contextRun, /pulls\/\$PR\/files|pulls\/\$?\{?PR\}?\/files/);
  assert.match(contextRun, /check-runs/, 'check runs pin CI to the head SHA');
  assert.match(
    contextRun,
    /actions\/runs/,
    'workflow runs expose PR attempt history',
  );
  assert.match(contextRun, /git show[^\n]*REVIEW\.md/);
  assert.match(contextRun, /git show[^\n]*AGENTS\.md/);
  assert.match(contextRun, /\.review\/REVIEW\.md/);
  assert.match(contextRun, /\.review\/AGENTS\.md/);

  // The reviewer must see the PR body, the linked issues/spec and the previous
  // review so it can check scope and reconcile earlier findings.
  assert.match(contextRun, /gh pr view/);
  assert.match(contextRun, /\.review\/pr\.json/);
  assert.match(contextRun, /repos\/\$GITHUB_REPOSITORY\/issues\/\$issue/);
  assert.match(contextRun, /\.review\/issues\.json/);
  assert.match(contextRun, /pulls\/\$PR\/reviews/);
  assert.match(contextRun, /pulls\/\$PR\/comments/);
  assert.match(contextRun, /\.review\/previous-review\.json/);
  assert.match(
    contextRun,
    /head -[n ]?10/,
    'the linked issue set must stay bounded',
  );

  const wait = job.steps.find((step) =>
    /CI pending/.test(String(step.run ?? '')),
  );
  assert.ok(wait, 'pending CI must be recorded explicitly');
  const waitRun = String(wait.run);
  assert.match(
    waitRun,
    /for attempt in \$\(seq 1 15\)/,
    'CI wait must be bounded',
  );
  assert.match(waitRun, /sleep 60/);
  assert.match(waitRun, /check-runs/);
  assert.match(waitRun, /ci-status\.txt/);
  // B1: only the required `check` context is awaited. The commit's check-runs
  // also contain this workflow's own in-progress `review` run and cancelled
  // predecessor runs, so waiting on all of them can never observe completed CI.
  assert.match(
    waitRun,
    /select\(\.name == "check"\)/,
    'the wait must select only the required check context',
  );
  assert.doesNotMatch(
    waitRun,
    /all\(\.check_runs\[\]; \.status == "completed"\)/,
    'the wait must not require every check run on the commit to be completed',
  );
  assert.match(waitRun, /checks-required\.json/);

  const limit = limitStep(workflow);
  assert.ok(limit, 'the run limit must be checked');
  assert.equal(limit.id, 'limit');
  const limitRun = String(limit.run);
  assert.match(
    limitRun,
    /issues\/\$PR\/comments/,
    'comments are the reservation store',
  );
  assert.match(limitRun, /review-run-limit\.mjs/);
  assert.match(
    limitRun,
    /gh api --method POST/,
    'a reservation marker comment is posted',
  );
  assert.match(limitRun, /jq -r \.marker/);
  assert.match(limitRun, /decision.*allow/);
  assert.match(limitRun, /decision=error/);
  assert.match(
    limitRun,
    /\$\{\{ github\.run_id \}\}\.\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(String(limit.env.RUN_ID), /github\.run_id.*github\.run_attempt/);

  const model = modelStep(workflow);
  assert.ok(model, 'the reviewer model must run with opencode run');
  assert.match(String(model.run), /opencode run[^\n]* --model "\$MODEL"/);
  assert.match(String(model.run), /--variant "\$VARIANT"/);
  assert.match(String(model.run), /--agent reviewer/);
  assert.match(String(model.run), /--format json/);
  assert.equal(
    JSON.stringify(workflow).includes('opencode github run'),
    false,
    'the review workflow must not use opencode github run',
  );
  assert.equal(model['timeout-minutes'], 60);
  assert.equal(
    model.if,
    "steps.limit.outputs.decision == 'allow'",
    'the model must be gated on the limit decision',
  );
  assert.equal(model.env.USE_GITHUB_TOKEN, 'true');
  assert.equal(model.env.MODEL, 'opencode/deepseek-v4.1-flash');
  assert.equal(model.env.VARIANT, 'low');
  assert.equal(model.env.SHARE, 'false');
  assert.equal(model.env.OPENCODE_API_KEY, '${{ secrets.OPENCODE_API_KEY }}');

  // B2: the model runs in an isolated directory outside the PR checkout, with
  // project config disabled. The snapshot must not carry PR-controlled
  // instruction/config/plugin files, while base-branch criteria stay in
  // .review/.
  const stage = stageStep(workflow);
  assert.ok(
    stage,
    'a step must stage an isolated review workspace outside the checkout',
  );
  const stageRun = String(stage.run);
  assert.match(stageRun, /\$RUNNER_TEMP\/review/);
  assert.match(stageRun, /git archive/);
  assert.match(stageRun, /cp -R \.review/);
  for (const control of [
    'AGENTS.md',
    'CLAUDE.md',
    'CONTEXT.md',
    'opencode.json',
    '.opencode',
  ])
    assert.match(
      stageRun,
      new RegExp(`--exclude='\\*?${control.replace('.', '\\.')}'`),
      `the source snapshot must exclude the PR-controlled ${control}`,
    );
  assert.equal(model.env.OPENCODE_DISABLE_PROJECT_CONFIG, 'true');
  assert.match(
    String(model.run),
    /opencode run --dir "\$RUNNER_TEMP\/review"/,
    'the reviewer must run in the isolated directory, not the PR checkout',
  );
  assert.match(String(model.run), /--format json/);

  const limitIndex = job.steps.indexOf(limit);
  const modelIndex = job.steps.indexOf(model);
  assert.ok(
    limitIndex < modelIndex,
    'the limit must be checked before the model step',
  );

  const config = reviewerConfig(model);
  assert.equal(config.default_agent, 'reviewer');
  const reviewer = config.agent?.reviewer;
  assert.ok(reviewer, 'the reviewer agent must be configured');
  assert.equal(reviewer.mode, 'primary');
  for (const permission of [
    'edit',
    'write',
    'bash',
    'task',
    'external_directory',
    'doom_loop',
    'webfetch',
    'websearch',
  ])
    assert.equal(
      reviewer.permission?.[permission],
      'deny',
      `the reviewer agent must deny ${permission}`,
    );

  const prompt = String(model.env.PROMPT);
  for (const requirement of [
    '.review/REVIEW.md',
    '.review/AGENTS.md',
    'базов',
    'недоверен',
    'не инструкц',
    'не выдумыв',
    'CI pending',
    'отсутстви',
    'reviewed@',
    'limit-reached',
    'JSON',
    'path',
    'line',
    'side',
    'R2',
    'R3',
    'не запускай',
    'COMMENT',
    'APPROVE',
    '.review/pr.json',
    '.review/issues.json',
    '.review/previous-review.json',
    'исправлено',
    'обосновано',
    'открыто',
    'не повторяй',
    'недоступн',
    'недоверенн',
  ])
    assert.ok(
      prompt.includes(requirement),
      `the prompt must mention ${requirement}`,
    );
  assert.match(prompt, /не\s+.*APPROVE|никогда\s+.*APPROVE|never\s+APPROVE/i);

  const statuses = statusSteps(workflow);
  assert.ok(
    statuses.length >= 1,
    'limit-reached and error status comments must exist',
  );
  const combinedStatusRuns = statuses
    .map((step) => String(step.run))
    .join('\n');
  assert.match(combinedStatusRuns, /limit-reached/);
  assert.match(combinedStatusRuns, /error/);
  assert.match(combinedStatusRuns, /HEAD_SHA/);
  assert.match(combinedStatusRuns, /RUN_URL/);
  assert.match(combinedStatusRuns, /issues\/\$PR\/comments/);
  for (const step of statuses)
    assert.doesNotMatch(
      String(step.run),
      /\bskipped\b/,
      'skipped must never be a review status',
    );

  const publish = publishStep(workflow);
  assert.ok(publish, 'the review must be published by the publisher script');
  const publishRun = String(publish.run);
  assert.match(publishRun, /--diff \.review\/pr-u0\.diff/);
  assert.match(publishRun, /--current-head/);
  assert.match(publishRun, /--post/);
  assert.match(publishRun, /pulls\/\$PR/);
  // A superseded head exits 3 from the publisher; that is not an error and
  // must not post the failure status comment.
  assert.match(publishRun, /-eq 3/);
  assert.match(publishRun, /superseded/i);
  assert.equal(publish.if, "steps.limit.outputs.decision == 'allow'");

  for (const run of allRuns(workflow)) {
    assert.doesNotMatch(
      run,
      /event\s*[=:]\s*['"]?APPROVE/i,
      'the workflow must never publish APPROVE',
    );
  }
}

test('the automatic review workflow satisfies the contract', async () => {
  assertReviewWorkflow(await readWorkflow(WORKFLOW_PATH));
});

test('the contract rejects unsafe review workflow variants', async () => {
  const workflow = await readWorkflow(WORKFLOW_PATH);
  const variants = {
    'pull_request_target trigger': (clone) => {
      clone.on.pull_request_target = { types: ['opened'] };
    },
    'missing run limit': (clone) => {
      clone.jobs.review.steps = clone.jobs.review.steps.filter(
        (step) => step !== limitStep(clone),
      );
    },
    'run limit after the model': (clone) => {
      const steps = clone.jobs.review.steps;
      const limit = limitStep(clone);
      steps.splice(steps.indexOf(limit), 1);
      steps.splice(steps.indexOf(modelStep(clone)) + 1, 0, limit);
    },
    'model not gated on the limit': (clone) => {
      modelStep(clone).if = "steps.limit.outputs.decision != 'limit-reached'";
    },
    'stale reviews not cancelled': (clone) => {
      (clone.concurrency ?? clone.jobs.review.concurrency)[
        'cancel-in-progress'
      ] = false;
    },
    'missing checks permission': (clone) => {
      delete clone.jobs.review.permissions.checks;
    },
    'missing statuses permission': (clone) => {
      delete clone.jobs.review.permissions.statuses;
    },
    'no USE_GITHUB_TOKEN': (clone) => {
      delete modelStep(clone).env.USE_GITHUB_TOKEN;
    },
    'merge ref checkout': (clone) => {
      const checkout = clone.jobs.review.steps.find((step) =>
        String(step.uses ?? '').includes('actions/checkout'),
      );
      checkout.with.ref =
        'refs/pull/${{ github.event.pull_request.number }}/merge';
    },
    'base SHA instead of head SHA': (clone) => {
      const checkout = clone.jobs.review.steps.find((step) =>
        String(step.uses ?? '').includes('actions/checkout'),
      );
      checkout.with.ref = '${{ github.event.pull_request.base.sha }}';
    },
    'missing author filter': (clone) => {
      clone.jobs.review.if = 'github.event.pull_request.draft == false';
    },
    'widened bot allowlist': (clone) => {
      clone.jobs.review.if = `${clone.jobs.review.if} || github.event.pull_request.user.login == 'dependabot[bot]'`;
    },
    'APPROVE allowed': (clone) => {
      clone.jobs.review.steps.push({
        run: 'gh api --method POST repos/x/pulls/1/reviews -f event=APPROVE',
      });
    },
    'no inline publish': (clone) => {
      publishStep(clone).run =
        'gh api --method POST "repos/$GITHUB_REPOSITORY/issues/$PR/comments" -f body=x';
    },
    'CI wait counts every check run': (clone) => {
      const wait = waitStep(clone);
      wait.run = String(wait.run).replace(
        'select(.name == "check")',
        'select(.name != "")',
      );
    },
    'reviewer runs inside the PR checkout': (clone) => {
      modelStep(clone).run =
        'opencode run --model "$MODEL" --format json "$PROMPT" > .review/out.jsonl';
    },
    'reviewer loads project config': (clone) => {
      delete modelStep(clone).env.OPENCODE_DISABLE_PROJECT_CONFIG;
    },
    'review workspace copies the PR tree': (clone) => {
      stageStep(clone).run =
        'rm -rf "$RUNNER_TEMP/review"; cp -R . "$RUNNER_TEMP/review"';
    },
    'missing PR and issue context': (clone) => {
      const context = clone.jobs.review.steps.find((step) =>
        /git diff/.test(String(step.run ?? '')),
      );
      context.run = String(context.run)
        .split('\n')
        .filter((line) => !/gh pr view|issues\/\$issue/.test(line))
        .join('\n');
    },
    'skipped used as a status': (clone) => {
      statusSteps(clone)[0].run = `${statusSteps(clone)[0].run}\necho skipped`;
    },
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const clone = JSON.parse(JSON.stringify(workflow));
    mutate(clone);
    assert.throws(
      () => assertReviewWorkflow(clone),
      assert.AssertionError,
      name,
    );
  }
});
