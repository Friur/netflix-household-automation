import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

import { HouseholdUpdateError } from './errors.js';
import { logger } from './logger.js';

const STORAGE_STATE_PATH = path.join(process.cwd(), 'tmp', 'storageState.json');

const CONFIRM_BUTTON = "button[data-uia='set-primary-location-action']";
const SUCCESS_MARKER = 'div[data-uia="upl-success"]';

/** Quantas execuções um mesmo processo Chromium atende antes de ser reciclado. */
const MAX_RUNS_PER_BROWSER = 10;
/** Espera entre tentativas de clique; a última se repete até estourar o prazo. */
const RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000];
const CONFIRM_TIMEOUT_MS = 30_000;

let browserInstance: Browser | null = null;
let runsSinceLaunch = 0;

async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        '--disable-gl-drawing-for-tests',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
      ],
    });
    runsSinceLaunch = 0;
  }
  return browserInstance;
}

/** Fecha o Chromium. Chamado no desligamento e ao reciclar o processo. */
export async function closeBrowser(): Promise<void> {
  const instance = browserInstance;
  if (!instance) return;

  browserInstance = null;
  runsSinceLaunch = 0;
  try {
    await instance.close();
  } catch (cause) {
    logger.warn('Falha ao fechar o navegador', cause);
  }
}

/**
 * Clica no botão e espera a confirmação aparecer, repetindo até dar certo ou
 * estourar CONFIRM_TIMEOUT_MS. O clique vai por JavaScript porque o botão da
 * Netflix às vezes ainda não terminou de hidratar quando fica visível.
 */
async function clickUntilConfirmed(page: Page): Promise<void> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  let attempt = 0;
  let lastCause: unknown;

  while (Date.now() < deadline) {
    try {
      await page.evaluate((selector) => {
        document.querySelector<HTMLButtonElement>(selector)?.click();
      }, CONFIRM_BUTTON);

      await page.locator(SUCCESS_MARKER).waitFor({ state: 'attached', timeout: 1_000 });
      return;
    } catch (cause) {
      lastCause = cause;
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      attempt += 1;
      await page.waitForTimeout(delay);
    }
  }

  throw new HouseholdUpdateError(
    `A confirmação não apareceu após ${attempt} tentativas em ${CONFIRM_TIMEOUT_MS / 1000}s`,
    { cause: lastCause },
  );
}

export default async function playwrightAutomation(url: string): Promise<void> {
  if (runsSinceLaunch >= MAX_RUNS_PER_BROWSER) {
    logger.info(`Reciclando o navegador após ${runsSinceLaunch} execuções`);
    await closeBrowser();
  }

  const browser = await getBrowser();
  const context = await browser.newContext({
    storageState: fs.existsSync(STORAGE_STATE_PATH) ? STORAGE_STATE_PATH : undefined,
  });

  try {
    // Imagens, fontes e mídia não influenciam o botão e só custam banda.
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'font' || type === 'media') {
        return route.abort();
      }
      return route.continue();
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.locator(CONFIRM_BUTTON).waitFor({ state: 'visible', timeout: 5_000 });

    await clickUntilConfirmed(page);
    logger.info('Residência atualizada com sucesso');

    // Guardar os cookies é otimização, não o objetivo — serve para a Netflix não
    // mandar um e-mail novo a cada dispositivo. Se a gravação falhar (volume sem
    // permissão, disco cheio), a residência JÁ foi atualizada; reportar falha
    // aqui seria mentira e custaria um reprocessamento inútil.
    try {
      await context.storageState({ path: STORAGE_STATE_PATH });
    } catch (cause) {
      logger.warn(`Não foi possível salvar a sessão em ${STORAGE_STATE_PATH}`, cause);
    }
  } catch (cause) {
    if (cause instanceof HouseholdUpdateError) throw cause;
    throw new HouseholdUpdateError(
      'Botão de atualizar residência não encontrado, ou o link expirou',
      { cause },
    );
  } finally {
    // Fora do try de propósito: uma sequência de falhas também precisa gastar o
    // orçamento do navegador, senão uma instância degradada nunca é reciclada.
    runsSinceLaunch += 1;
    await context.close().catch(() => {});
  }
}
