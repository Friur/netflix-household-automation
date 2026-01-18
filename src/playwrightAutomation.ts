import fs from "fs";
import path from "path";
import { chromium, Browser, expect } from "@playwright/test";
import Errorlogger from "./Errorlogger";

const STORAGE_STATE_PATH = path.join(process.cwd(), "tmp", "storageState.json");
const TMP_STORAGE_STATE_PATH = path.join(process.cwd(), "tmp", "storageState.tmp.json");
const LOCK_FILE = path.join(process.cwd(), "tmp", "storage.lock");

let browserInstance: Browser | null = null;
let contextExecutionCount = 0;
const MAX_CONTEXT_REUSE = 10;

function acquireLock(): boolean {
  try {
    fs.writeFileSync(LOCK_FILE, process.pid.toString(), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
}

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
  if (!acquireLock()) {
    throw new Errorlogger("Another process is using storageState.json");
  }

  // Recicla browser se necessário
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

    // Configurar bloqueio ANTES de criar page
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
        return route.abort();
      }
      route.continue();
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

    await expect(async () => {
      const updatePrimaryButton = page.locator(
        "button[data-uia='set-primary-location-action']"
      );
      await updatePrimaryButton.click({ force: true });

      const isSuccessLocator = page.locator('div[data-uia="upl-success"]');
      await expect(isSuccessLocator).toBeAttached({ timeout: 2000 });
    }).toPass({
      intervals: [100, 250, 500],
      timeout: 10000,
    });

    await context.storageState({ path: TMP_STORAGE_STATE_PATH });
    fs.renameSync(TMP_STORAGE_STATE_PATH, STORAGE_STATE_PATH);
    
    await context.close();
    contextExecutionCount++;
  } catch (error) {
    throw new Errorlogger(
      `No Netflix location update button found or link expired: ${
        error instanceof Error ? error.message : error
      }`
    );
  } finally {
    releaseLock();
  }
}
