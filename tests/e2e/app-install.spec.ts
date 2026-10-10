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
  // Apps share the github.io origin, so a relative id like "./" would collapse every app into one identity.
  const { appId } = await client.send('Page.getAppId') as { appId?: string };
  expect(appId).toBe(new URL('/Hwp/', manifest.url).href);
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

test('the header QR button shows the bundled QR image without network requests', async ({ page }) => {
  await page.goto('./#/start');
  const external: string[] = [];
  page.on('request', (request) => { if (!request.url().startsWith(new URL('./', page.url()).origin)) external.push(request.url()); });
  await page.getByRole('banner').getByRole('button', { name: 'QR 코드로 접속' }).click();
  const dialog = page.getByRole('dialog', { name: '카메라로 찍어서 들어와요' });
  await expect(dialog).toBeVisible();
  const image = dialog.getByRole('img', { name: '한글 마감실 주소 QR 코드' });
  await expect(image).toBeVisible();
  expect(await image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  await dialog.getByRole('button', { name: '닫기' }).click();
  await expect(dialog).toBeHidden();
  expect(external).toEqual([]);
});
