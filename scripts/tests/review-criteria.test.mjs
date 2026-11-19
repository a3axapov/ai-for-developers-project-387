import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

function includes(source, values) {
  for (const value of values) {
    assert.ok(source.includes(value), `missing required text: ${value}`);
  }
}

const closingKeyword = /\b(?:Closes|Fixes)\s+#[0-9A-Za-z]+/i;

function formattedClosingKeywords(markdown) {
  const violations = [];
  let inFence = false;

  markdown.split('\n').forEach((line, index) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) {
      if (closingKeyword.test(line)) {
        violations.push({ kind: 'fenced', line: index + 1 });
      }
      return;
    }
    for (const span of line.match(/`[^`]*`/g) ?? []) {
      if (closingKeyword.test(span)) {
        violations.push({ kind: 'inline', line: index + 1 });
        break;
      }
    }
  });

  return violations;
}

function withoutCode(markdown) {
  const lines = [];
  let inFence = false;

  for (const line of markdown.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      lines.push(line.replace(/`[^`]*`/g, ''));
    }
  }

  return lines.join('\n');
}

test('REVIEW.md defines review risk by consequence and calendar criteria', async () => {
  const review = await read('REVIEW.md');

  for (const level of ['R0', 'R1', 'R2', 'R3']) {
    assert.match(
      review,
      new RegExp(`\\b${level}\\b`),
      `missing risk level ${level}`,
    );
  }
  assert.match(review, /риск[^.\n]*по последствиям/i);
  assert.match(review, /не по размеру diff/i);

  includes(review, [
    'Место в коде',
    'Условие ошибки',
    'Последствие',
    'Как проверить',
    'TIME_CONFLICT',
    'CONDITIONS_CHANGED',
    'идемпотент',
    'освобожда',
    'file:line',
  ]);
  assert.match(
    review,
    /занятый слот не должен оставаться доступным/i,
    'missing booked-slot invariant',
  );
  assert.match(
    review,
    /src\/main\/java\/com\/testproject\/calendar\/owner\/OwnerState\.java:\d+/,
  );
});

test('REVIEW.md fixes the finding format and comment requirements', async () => {
  const review = await read('REVIEW.md');

  includes(review, [
    'ID замечания',
    'severity',
    'Блокирующее',
    'Критерий',
    'file:line',
    'REV-1',
    'inline-комментари',
    'оба вида',
    'недоступн',
    'вне согласованного объёма',
    'не выдумыва',
    'процессн',
    'не дублир',
  ]);
  assert.match(
    review,
    /общ\p{L}* комментари/iu,
    'missing general PR comment requirement',
  );
});

test('detects plain and formatted closing keywords', () => {
  assert.deepEqual(
    formattedClosingKeywords('- Closes #12 — plain text'),
    [],
    'plain closing keyword must not be reported',
  );
  assert.deepEqual(
    formattedClosingKeywords('- `Fixes #M` in inline code'),
    [{ kind: 'inline', line: 1 }],
    'Fixes #M in inline code must be reported',
  );
  assert.deepEqual(
    formattedClosingKeywords('- `Closes #N` in inline code'),
    [{ kind: 'inline', line: 1 }],
    'Closes #N in inline code must be reported',
  );
  assert.deepEqual(
    formattedClosingKeywords('```text\nCloses #N\n```'),
    [{ kind: 'fenced', line: 2 }],
    'Closes #N in a fenced block must be reported',
  );
  assert.deepEqual(
    formattedClosingKeywords('```text\nFixes #M\n```'),
    [{ kind: 'fenced', line: 2 }],
    'Fixes #M in a fenced block must be reported',
  );
});

test('pull request template keeps closing keywords as plain text', async () => {
  const template = await read('.github/pull_request_template.md');

  assert.deepEqual(
    formattedClosingKeywords(template),
    [],
    'closing keywords must not be wrapped in inline code or hidden in a fenced block: GitHub ignores them there',
  );
  assert.match(
    withoutCode(template),
    /^- Closes #N\b/m,
    'missing a plain Closes keyword line',
  );
  assert.match(
    template,
    /не оформляйте[^\n]*(inline-код|блок кода)|inline-код[^\n]*не закрыва/i,
    'missing the warning that formatted closing keywords do not close issues',
  );
});

test('pull request template requires evidence, risk, rollback and merge decision', async () => {
  const template = await read('.github/pull_request_template.md');

  includes(template, [
    '## Исходное обращение',
    'Closes #',
    'Спецификация',
    'Тикеты',
    'Согласование человеком',
    '## Изменение и затронутое поведение',
    '## Проверки',
    'Код выхода',
    'Результат или число тестов',
    'Проверенный SHA',
    'CI',
    '## Что не запускалось и почему',
    '## Риск',
    'Худшее последствие',
    'Обоснование глубины',
    '## Откат',
    'Проверка восстановления поведения',
    'Данные',
    '## Разбор замечаний ревью',
    'Исправление или обоснование',
    'Проверка',
    '## Защита от повторения',
    '## Решение человека о мерже',
    'тесты прошли',
    'не является доказательством',
  ]);
});
