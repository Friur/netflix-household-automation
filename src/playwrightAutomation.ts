import fs from "fs";
import path from "path";
import { chromium, Browser, expect } from "@playwright/test";
import Errorlogger from "./Errorlogger";

const STORAGE_STATE_PATH = path.join(process.cwd(), "tmp", "storageState.json");

let browserInstance: Browser | null = null;
let contextExecutionCount = 0;
const MAX_CONTEXT_REUSE = 10;

async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        "--disable-gl-drawing-for-tests",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--no-first-run",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
      ],
    });
    contextExecutionCount = 0;
  }
  return browserInstance;
}

export default async function playwrightAutomation(url: string) {
  if (contextExecutionCount >= MAX_CONTEXT_REUSE && browserInstance) {
    console.log('♻️ Reciclando browser...');
    await browserInstance.close();
    browserInstance = null;
  }

  const browser = await getBrowser();

  try {
    const context = await browser.newContext({
      storageState: fs.existsSync(STORAGE_STATE_PATH) ? STORAGE_STATE_PATH : undefined,
    });
    
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        return route.abort();
      }
      route.continue();
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

    const updatePrimaryButton = page.locator(
      "button[data-uia='set-primary-location-action']"
      );
      await updatePrimaryButton.waitFor({ state: 'visible', timeout: 5000});
      await updatePrimaryButton.click({ force: true, noWaitAfter: true});
      const isSuccessLocator = page.locator('div[data-uia="upl-success"]');
      await isSuccessLocator.waitFor({ state: 'attached', timeout: 5000})
      await expect(isSuccessLocator).toBeAttached({ timeout: 2000 });
      await page.close();

    // ✅ Salva direto no arquivo final - sem rename
    await context.storageState({ path: STORAGE_STATE_PATH });
    
    await context.close();
    contextExecutionCount++;
  } catch (error) {
    throw new Errorlogger(
      `No Netflix location update button found or link expired: ${
        error instanceof Error ? error.message : error
      }`
    );
  }
}
