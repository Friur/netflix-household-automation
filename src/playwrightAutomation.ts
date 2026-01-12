import { chromium, expect } from '@playwright/test';
import Errorlogger from './Errorlogger';

export default async function playwrightAutomation(url: string) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-gl-drawing-for-tests'], // disable GPU drawing for improved performance in headless mode.
  });

  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expect(async () => {
      const updatePrimaryButton = page.locator("button[data-uia='set-primary-location-action']");
      await updatePrimaryButton.click({ force: true });

      const isSuccessLocator = page.locator('div[data-uia="upl-success"]');
      await expect(isSuccessLocator).toBeAttached({ timeout: 1000 });
    }).toPass({
      intervals: [100, 250, 500, 1_000],
      timeout: 30_000,
    });
  } catch (error) {
    throw new Errorlogger(`No Netflix location update button found for URL, maybe link timeout already expired: ${error}`);
  } finally {
    await browser.close();
  }

  return Promise.resolve();
}