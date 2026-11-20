import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as review from '../review-approval.mjs';

const repository = 'acme/calendar';
const url = `https://github.com/${repository}/issues/8#issuecomment-42`;
const comment = {
  issue_url: `https://api.github.com/repos/${repository}/issues/8`,
  user: { type: 'User', login: 'owner' },
  author_association: 'OWNER',
  body: 'Спецификация согласована',
};
const getApproval = (body, getComment) =>
  review.getApproval({ body, repository, getComment });

test('review evidence reads the exact linked approval, not the issue body', async () => {
  assert.deepEqual(
    await getApproval(
      `- Согласование человеком: [решение](${url})`,
      async (id) => {
        assert.equal(id, '42');
        return comment;
      },
    ),
    { status: 'available', url, author: 'owner', body: comment.body },
  );
});

test('missing, foreign, untrusted and inaccessible approvals remain unverified', async () => {
  const notCalled = () => assert.fail('cannot fetch an unrecognized link');
  assert.equal(
    (await getApproval(`См. ${url}`, notCalled)).reason,
    'missing-link',
  );
  assert.equal(
    (
      await getApproval(
        `Согласование человеком: ${url.replace(repository, 'other/repo')}`,
        notCalled,
      )
    ).reason,
    'foreign-link',
  );
  assert.equal(
    (
      await getApproval(`Согласование человеком: ${url}`, async () => ({
        ...comment,
        author_association: 'NONE',
      }))
    ).reason,
    'untrusted-comment',
  );
  assert.equal(
    (
      await getApproval(`Согласование человеком: ${url}`, async () => {
        throw new Error('not found');
      })
    ).reason,
    'cannot-read-comment',
  );
});
