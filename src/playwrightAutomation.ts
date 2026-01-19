import fs from "fs";
import path from "path";
import { chromium, Browser, expect } from "@playwright/test";
import Errorlogger from "./Errorlogger";

const STORAGE_STATE_PATH = path.join(process.cwd(), "tmp", "storageState.json");
const TMP_STORAGE_STATE_PATH = path.join(process.cwd(), "tmp", "storageState.tmp.json");
const LOCK_FILE = path.join(process.cwd(), "tmp", "storage.lock");
const VIDEO_DIR = path.join(process.cwd(), "tmp", "videos");

let browserInstance: Browser | null = null;
let contextExecutionCount = 0;
const MAX_CONTEXT_REUSE = 10;

// ✅ Verifica se um processo ainda existe
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 apenas testa se o processo existe
    return true;
  } catch {
    return false;
  }
}

// ✅ Lock melhorado com detecção de lock órfão
function acquireLock(): boolean {
  try {
    // Tenta criar o lock
    fs.writeFileSync(LOCK_FILE, process.pid.toString(), { flag: "wx" });
    return true;
  } catch (error) {
    // Se lock existe, verifica se o processo dono ainda está rodando
    if (fs.existsSync(LOCK_FILE)) {
      const lockPid = parseInt(fs.readFileSync(LOCK_FILE, "utf8"));
      
      // Se o processo não existe mais, limpa o lock órfão
      if (!isProcessRunning(lockPid)) {
        console.log(`🧹 Removendo lock órfão do processo ${lockPid}`);
        fs.unlinkSync(LOCK_FILE);
        // Tenta adquirir novamente
        try {
          fs.writeFileSync(LOCK_FILE, process.pid.toString(), { flag: "wx" });
          return true;
        } catch {
          return false;
        }
      }
    }
    return false;
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockPid = parseInt(fs.readFileSync(LOCK_FILE, "utf8"));
      // Só remove se for o dono do lock
      if (lockPid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
      }
    }
  } catch (error) {
    console.error(`⚠️ Erro ao liberar lock: ${error}`);
  }
}

// ✅ Garante que lock é liberado se o processo morrer
process.on('exit', () => {
  releaseLock();
});

process.on('SIGINT', () => {
  releaseLock();
  process.exit(0);
});

process.on('SIGTERM', () => {
  releaseLock();
  process.exit(0);
});

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
    // Cria diretório de vídeos se não existir
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
