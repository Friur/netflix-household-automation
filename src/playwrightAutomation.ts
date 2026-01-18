import fs from "fs";
import { chromium, expect } from "@playwright/test";
import Errorlogger from "./Errorlogger";

const STORAGE_STATE_PATH = "./tmp/storageState.json";
const TMP_STORAGE_STATE_PATH = "./tmp/storageState.tmp.json";
const LOCK_FILE = "./tmp/storage.lock";

// 🔒 Lock de arquivo (impede concorrência entre processos)
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

// 🧪 Valida se o storageState é JSON válido
function isValidStorageState(path: string): boolean {
  try {
    if (!fs.existsSync(path)) return false;
    JSON.parse(fs.readFileSync(path, "utf8"));
    return true;
  } catch {
    return false;
  }
}

export default async function playwrightAutomation(url: string) {
  if (!acquireLock()) {
    throw new Errorlogger("Another process is using storageState.json");
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-gl-drawing-for-tests"],
  });

  try {
    const hasValidStorage = isValidStorageState(STORAGE_STATE_PATH);

    const browserContext = await browser.newContext({
      storageState: hasValidStorage ? STORAGE_STATE_PATH : undefined,
    });

    const page = await browserContext.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded" });

    await expect(async () => {
      const updatePrimaryButton = page.locator(
        "button[data-uia='set-primary-location-action']"
      );
      await updatePrimaryButton.click({ force: true });

      const isSuccessLocator = page.locator('div[data-uia="upl-success"]');
      await expect(isSuccessLocator).toBeAttached({ timeout: 1000 });
    }).toPass({
      intervals: [100, 250, 500, 1000],
      timeout: 30000,
    });

    // 💾 Escrita atômica (anti-corrupção)
    await browserContext.storageState({ path: TMP_STORAGE_STATE_PATH });
    fs.renameSync(TMP_STORAGE_STATE_PATH, STORAGE_STATE_PATH);
  } catch (error) {
    throw new Errorlogger(
      `No Netflix location update button found or link expired: ${
        error instanceof Error ? error.message : error
      }`
    );
  } finally {
    releaseLock();
    await browser.close();
  }
}
