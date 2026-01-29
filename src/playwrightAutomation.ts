// import 'dotenv/config';
import fs from "fs";
import path from "path";
import { chromium, Browser, Page, expect } from "@playwright/test";
import Errorlogger from "./Errorlogger.js";

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
  let context;
  let page: Page | undefined;

  try {
    context = await browser.newContext({
      storageState: fs.existsSync(STORAGE_STATE_PATH) ? STORAGE_STATE_PATH : undefined,
    });
    
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        return route.abort();
      }
      route.continue();
    });

    page = await context.newPage();
    
    await page.goto(url, { waitUntil: "domcontentloaded" });
    
    await expect(async () => {
      const updatePrimaryButton = page!.locator("button[data-uia='set-primary-location-action']");
      await updatePrimaryButton.click({ force: true });

      const isSuccessLocator = page!.locator('div[data-uia="upl-success"]');
      await expect(isSuccessLocator).toBeAttached({ timeout: 1000 });
    }).toPass({
      intervals: [100, 250, 500, 1_000],
      timeout: 30_000,
    });
    
    console.log('✅ Localização atualizada com sucesso!');
    
    // Salva estado apenas em caso de sucesso
    await context.storageState({ path: STORAGE_STATE_PATH });
    contextExecutionCount++;
    
  } catch (error) {
    console.error('❌ Erro na automação:', error);
    throw new Errorlogger(
      `No Netflix location update button found or link expired: ${
        error instanceof Error ? error.message : error
      }`
    );
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
    if (context) {
      await context.close().catch(() => {});
    }
  }
}
