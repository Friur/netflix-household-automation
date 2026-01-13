import { existsSync } from "fs";
import { chromium, expect, Browser } from '@playwright/test';
import Errorlogger from './Errorlogger';

const STORAGE_STATE_PATH = './tmp/storageState.json';

// Reuse browser instance for faster processing
let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        '--disable-gl-drawing-for-tests',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
      ],
    });
  }
  return browserInstance;
}

// Cleanup browser on process exit
process.on('exit', () => browserInstance?.close());
process.on('SIGINT', () => { browserInstance?.close(); process.exit(); });
process.on('SIGTERM', () => { browserInstance?.close(); process.exit(); });

export default async function playwrightAutomation(url: string) {
  const storageStateExists = existsSync(STORAGE_STATE_PATH);
  const browser = await getBrowser();

  const browserContext = await browser.newContext({
    storageState: storageStateExists ? STORAGE_STATE_PATH : undefined,
    // Block unnecessary resources for faster loading
    bypassCSP: true,
  });

  // Block images, fonts, and other non-essential resources
  await browserContext.route('**/*', (route) => {
    const resourceType = route.request().resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(resourceType)) {
      return route.abort();
    }
    return route.continue();
  });

  const page = await browserContext.newPage();

  try {
    // Use 'commit' for fastest initial response
    await page.goto(url, { waitUntil: "commit", timeout: 15_000 });
    
    // Wait for the button with shorter timeout
    const updatePrimaryButton = page.locator("button[data-uia='set-primary-location-action']");
    await updatePrimaryButton.waitFor({ state: 'visible', timeout: 10_000 });
    await updatePrimaryButton.click({ force: true });

    // Wait for success with optimized intervals
    const isSuccessLocator = page.locator('div[data-uia="upl-success"]');
    await expect(isSuccessLocator).toBeAttached({ timeout: 10_000 });

    await browserContext.storageState({ path: STORAGE_STATE_PATH });
  } catch (error) {
    throw new Errorlogger(`No Netflix location update button found for URL, maybe link timeout already expired: ${error}`);
  } finally {
    await browserContext.close(); // Only close context, keep browser running
  }
}