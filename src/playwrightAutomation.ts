import { existsSync, readFileSync, renameSync, mkdirSync } from "fs";
import { chromium, expect } from '@playwright/test';
import { dirname } from 'path';
import Errorlogger from './Errorlogger';

const STORAGE_STATE_PATH = './tmp/storageState.json';

export default async function playwrightAutomation(url: string) {
  let storageStateExists = existsSync(STORAGE_STATE_PATH);
  
  // Validate JSON if file exists
  if (storageStateExists) {
    try {
      const content = readFileSync(STORAGE_STATE_PATH, 'utf-8');
      JSON.parse(content);
    } catch (error) {
      new Errorlogger(`Invalid storage state JSON, will start fresh: ${error instanceof Error ? error.message : String(error)}`);
      storageStateExists = false;
    }
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-gl-drawing-for-tests'], // disable GPU drawing for improved performance in headless mode.
  });

  // Load the storage state start with the previous Session/Cookie.
  // This prevents Netflix from sending emails about new devices using the account.
  const browserContext = await browser.newContext({
    storageState: storageStateExists ? STORAGE_STATE_PATH : undefined
  });
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

    // Atomic write: save to temp file first, then rename
    const tempPath = `${STORAGE_STATE_PATH}.tmp`;
    
    // Ensure directory exists
    const dir = dirname(STORAGE_STATE_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    
    await browserContext.storageState({ path: tempPath });
    
    // Verify temp file was created before renaming
    if (!existsSync(tempPath)) {
      throw new Error(`Failed to create temporary storage state file at ${tempPath}`);
    }
    
    renameSync(tempPath, STORAGE_STATE_PATH);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`no Netflix location update button found for link, maybe link timeout already expired. ${errorMsg}`);
  } finally {
    await browser.close();
  }

  return Promise.resolve();
}
