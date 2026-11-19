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

test('pull request template keeps closing keywords as plain text', async () => {
  const template = await read('.github/pull_request_template.md');

  assert.doesNotMatch(
    template,
    /`[^`\n]*\bCloses\s+#/i,
    'Closes #N must not be wrapped in inline code: GitHub ignores it there',
  );
  assert.match(
    template,
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
