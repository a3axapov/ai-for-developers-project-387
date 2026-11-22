import { expect, test } from './real-server';

test('при выключенной публичной записи главная ведёт к сообщению о недоступности', async ({
  page,
}) => {
  await page.goto('/admin');
  await expect(
    page.getByRole('switch', { name: 'Публичная запись' }),
  ).not.toBeChecked();

  await page.goto('/');
  await expect(page.getByText('Онлайн-запись без регистрации.')).toBeVisible();
  for (const claim of ['сейчас открыта', 'запись включена']) {
    await expect(page.getByText(claim, { exact: false })).toHaveCount(0);
  }

  await page
    .getByRole('link', { name: 'Записаться на встречу', exact: true })
    .click();
  await expect(page).toHaveURL('/booking/anna-1');
  await expect(page.getByText('Запись временно недоступна')).toBeVisible();
});
