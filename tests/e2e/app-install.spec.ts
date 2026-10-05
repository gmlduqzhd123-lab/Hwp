import { expect, test } from '@playwright/test';

test('the app manifest loads under the production policy with every reviewed icon', async ({ page }) => {
  await page.goto('./#/start');
  const client = await page.context().newCDPSession(page);
  // Ask Chromium to fetch the manifest exactly as installation does; a CSP block is reported as an error.
  const manifest = await client.send('Page.getAppManifest') as { url: string; errors: Array<{ message: string }>; data?: string };
  expect(manifest.errors).toEqual([]);
  expect(manifest.url).toMatch(/\/manifest\.webmanifest$/);
  const body = JSON.parse(manifest.data ?? '{}') as { start_url: string; display: string; icons: Array<{ src: string }> };
  expect(body).toMatchObject({ start_url: './#/start', display: 'standalone' });
  for (const icon of body.icons) {
    const response = await page.request.get(new URL(icon.src, manifest.url).href);
    expect(response.status(), icon.src).toBe(200);
  }
});

test('the header install button opens device guidance and returns focus when closed', async ({ page }) => {
  await page.goto('./#/start');
  const install = page.getByRole('banner').getByRole('button', { name: '앱 설치' });
  await expect(install).toBeVisible();
  await install.click();
  const dialog = page.getByRole('dialog', { name: '앱으로 설치하기' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('listitem').first()).toBeVisible();
  await dialog.getByRole('button', { name: '닫기' }).click();
  await expect(dialog).toBeHidden();
  await expect(install).toBeFocused();
});
