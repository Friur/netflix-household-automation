import fs from "fs";
import path from "path";
import { chromium, Browser, expect } from "@playwright/test";
import Errorlogger from "./Errorlogger";

const STORAGE_STATE_PATH = path.join(process.cwd(), "tmp", "storageState.json");
const TMP_STORAGE_STATE_PATH = path.join(process.cwd(), "tmp", "storageState.tmp.json");
const VIDEO_DIR = path.join(process.cwd(), "tmp", "videos");

let browserInstance: Browser | null = null;
let contextExecutionCount = 0;
const MAX_CONTEXT_REUSE = 10;

// ✅ Sistema de fila - substitui o lock
let isProcessing = false;
const queue: Array<{ url: string; resolve: Function; reject: Function }> = [];

async function processQueue() {
  if (isProcessing || queue.length === 0) return;
  
  isProcessing = true;
  const task = queue.shift()!;
  
  try {
    await executeAutomation(task.url);
    task.resolve();
  } catch (error) {
    task.reject(error);
  } finally {
    isProcessing = false;
    processQueue(); // Processa próximo
  }
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

async function executeAutomation(url: string) {
  if (contextExecutionCount >= MAX_CONTEXT_REUSE && browserInstance) {
    console.log('♻️ Reciclando browser...');
    await browserInstance.close();
    browserInstance = null;
  }

  const browser = await getBrowser();

  if (!fs.existsSync(VIDEO_DIR)) {
    fs.mkdirSync(VIDEO_DIR, { recursive: true });
  }

  const context = await browser.newContext({
    storageState: fs.existsSync(STORAGE_STATE_PATH) ? STORAGE_STATE_PATH : undefined,
    recordVideo: {
      dir: VIDEO_DIR,
      size: { width: 1280, height: 720 },
    },
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
  
  const videoPath = await page.video()?.path();
  await context.close();
  contextExecutionCount++;
  
  if (videoPath) {
    console.log(`🎥 Vídeo gravado em: ${videoPath}`);
  }
}

// ✅ FUNÇÃO PRINCIPAL - SEM LOCK!
export default async function playwrightAutomation(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    queue.push({ url, resolve, reject });
    processQueue();
  });
}
