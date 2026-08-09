import Imap from 'imap';
import { simpleParser, type ParsedMail } from 'mailparser';
import type { Readable } from 'node:stream';

import { MailboxError } from './errors.js';
import { logger, describeCause } from './logger.js';
import playwrightAutomation, { closeBrowser } from './playwrightAutomation.js';

// --- Configuração -----------------------------------------------------------

/** Rede de segurança para o caso do IDLE não entregar o push. O IDLE é o
 *  mecanismo primário; sondar de segundo em segundo só gasta cota do servidor. */
const POLLING_SECONDS = Number(process.env.POLLING_INTERVAL_SECONDS) || 60;
/** Teto da fila. Se o Playwright travar, o polling continua empilhando. */
const MAX_QUEUE_SIZE = Number(process.env.MAX_QUEUE_SIZE) || 50;

/**
 * Modo de simulação, para conferir a configuração antes de confiar nela.
 * Registra o que faria, mas não clica no link nem move o e-mail para a lixeira —
 * e não marca como lido, para o e-mail continuar disponível na rodada real.
 */
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 300_000;
const MAX_RECONNECT_ATTEMPTS = Number(process.env.MAX_RECONNECT_ATTEMPTS) || 20;
/** Quanto uma conexão precisa durar para o orçamento de reconexão ser zerado. */
const STABLE_CONNECTION_MS = 60_000;
/** Prazo máximo para o desligamento gracioso antes de sair à força. */
const SHUTDOWN_TIMEOUT_MS = 5_000;
/** Prazo máximo para um ciclo de busca+download de e-mails terminar. */
const FETCH_TIMEOUT_MS = 120_000;

/** Lê uma variável de lista separada por `|`, aceitando o nome no plural
 *  (preferido) ou no singular, que é o que a documentação antiga usava. */
function readList(...names: string[]): string[] {
  for (const name of names) {
    const raw = process.env[name];
    if (raw && raw.trim().length > 0) {
      return raw.split('|').map((item) => item.trim()).filter((item) => item.length > 0);
    }
  }
  return [];
}

function createImapInstance(): Imap {
  return new Imap({
    user: process.env.IMAP_USER ?? '',
    password: process.env.IMAP_PASSWORD ?? '',
    host: process.env.IMAP_HOST ?? '',
    port: Number(process.env.IMAP_PORT) ?? 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    // Prazo para ESTABELECER a conexão (não é timer de reconexão). Precisa ser
    // curto para que um handshake travado falhe rápido e caia no backoff.
    connTimeout: 30_000,
    authTimeout: 15_000,
    keepalive: {
      interval: 60_000, // NOOP a cada 60s para manter a conexão viva
      idleInterval: 600_000, // reemite o IDLE a cada 10 minutos
    },
  });
}

// --- Estado -----------------------------------------------------------------

type QueueItem = { uid: number; mail: ParsedMail };
/** O que aconteceu com um e-mail. Governa o log — nunca a deleção. */
type Outcome = 'processado' | 'ignorado' | 'falhou' | 'simulado';

// Recriada a cada reconexão: uma conexão node-imap encerrada não é reutilizável.
let imap!: Imap;

let isSearching = false;
let searchAgainWhenDone = false;

const queue: QueueItem[] = [];
let isDrainingQueue = false;

let pollingInterval: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let stabilityTimer: NodeJS.Timeout | null = null;
let connectionGeneration = 0;
let reconnectAttempts = 0;
let isShuttingDown = false;

let cachedTrashFolder: string | null = null;

// --- Lixeira ----------------------------------------------------------------

function findTrashFolder(): Promise<string> {
  if (cachedTrashFolder) return Promise.resolve(cachedTrashFolder);

  const configured = process.env.IMAP_TRASH_FOLDER;
  if (configured) {
    cachedTrashFolder = configured;
    return Promise.resolve(configured);
  }

  return new Promise((resolve, reject) => {
    imap.getBoxes((err, boxes) => {
      if (err) return reject(new MailboxError('Não foi possível listar as pastas', { cause: err }));

      const candidates = ['Trash', 'Lixeira', 'Papelera', 'Corbeille'];

      for (const gmailKey of ['[Gmail]', '[Google Mail]']) {
        const children = boxes[gmailKey]?.children;
        if (!children) continue;
        for (const name of candidates) {
          if (children[name]) {
            cachedTrashFolder = `${gmailKey}/${name}`;
            logger.info(`Pasta da lixeira encontrada: ${cachedTrashFolder}`);
            return resolve(cachedTrashFolder);
          }
        }
      }

      for (const name of candidates) {
        if (boxes[name]) {
          cachedTrashFolder = name;
          logger.info(`Pasta da lixeira encontrada: ${cachedTrashFolder}`);
          return resolve(cachedTrashFolder);
        }
      }

      reject(new MailboxError('Pasta da lixeira não encontrada; defina IMAP_TRASH_FOLDER no .env'));
    });
  });
}

function moveToTrash(uid: number): Promise<void> {
  return findTrashFolder().then(
    (folder) =>
      new Promise<void>((resolve, reject) => {
        imap.move(uid, folder, (err) => {
          if (err) return reject(new MailboxError(`Falha ao mover o UID ${uid}`, { cause: err }));
          logger.info(`E-mail UID ${uid} movido para ${folder}`);
          resolve();
        });
      }),
  );
}

// --- Processamento ----------------------------------------------------------

async function processEmail({ mail }: QueueItem): Promise<Outcome> {
  const targetSubjects = readList('TARGET_EMAIL_SUBJECTS', 'TARGET_EMAIL_SUBJECT');
  const subject = mail.subject?.trim() ?? '';
  const sender = mail.from?.text ?? 'remetente desconhecido';

  // Comparação nos dois sentidos, como no comportamento original.
  const matchesSubject = targetSubjects.some(
    (target) =>
      subject.toLowerCase().includes(target.toLowerCase()) ||
      target.toLowerCase().includes(subject.toLowerCase()),
  );

  if (!matchesSubject) {
    logger.info(`Assunto fora do filtro, nada a fazer: "${subject}" (de ${sender})`);
    return 'ignorado';
  }

  logger.info(`Processando e-mail de ${sender}: "${subject}"`);

  // O link pode estar na parte de texto ou na de HTML, dependendo do provedor.
  const body = `${mail.text ?? ''}\n${mail.html || ''}`;
  const links = body.match(/https?:\/\/[^\s<>"'\])]+/gi) ?? [];
  const target = links.find((link) => link.includes('update-primary-location'));

  if (!target) {
    logger.warn('Nenhum link de update-primary-location encontrado no e-mail');
    return 'ignorado';
  }

  try {
    const url = new URL(target).toString();
    logger.info(`Link da Netflix encontrado: ${url}`);

    if (DRY_RUN) {
      logger.info('[SIMULAÇÃO] O link NÃO foi aberto e o e-mail NÃO será apagado');
      return 'simulado';
    }

    await playwrightAutomation(url);
    return 'processado';
  } catch (cause) {
    logger.error('Não foi possível atualizar a residência', cause);
    return 'falhou';
  }
}

function enqueue(item: QueueItem) {
  if (queue.length >= MAX_QUEUE_SIZE) {
    // Descarta o mais antigo: um link de verificação recente vale mais que um
    // que já ficou parado na fila.
    const dropped = queue.shift();
    logger.warn(`Fila cheia (${MAX_QUEUE_SIZE}); descartando o e-mail UID ${dropped?.uid}`);
  }
  queue.push(item);
  logger.info(`E-mail UID ${item.uid} na fila (${queue.length} aguardando)`);
}

async function drainQueue(): Promise<void> {
  if (isDrainingQueue || queue.length === 0) return;
  isDrainingQueue = true;

  try {
    while (queue.length > 0) {
      const item = queue.shift()!;

      let outcome: Outcome;
      try {
        outcome = await processEmail(item);
      } catch (cause) {
        outcome = 'falhou';
        logger.error(`Erro inesperado no e-mail UID ${item.uid}`, cause);
      }

      if (outcome === 'processado') {
        logger.info(`E-mail UID ${item.uid}: residência atualizada`);
      } else if (outcome === 'falhou') {
        logger.warn(`E-mail UID ${item.uid}: processamento FALHOU`);
      }

      if (DRY_RUN) {
        logger.info(`[SIMULAÇÃO] E-mail UID ${item.uid} permanece na caixa, não lido`);
        continue;
      }

      // Política de caixa de entrada, definida pelo dono do projeto: todo e-mail
      // que a busca retornar vai para a lixeira — processado, ignorado ou com
      // falha. É intencional, para a caixa não encher; a Netflix reenvia o link
      // quando é preciso. O `outcome` acima governa só o que é registrado.
      try {
        await moveToTrash(item.uid);
      } catch (cause) {
        logger.error(`Não foi possível mover o e-mail UID ${item.uid} para a lixeira`, cause);
      }
    }
  } finally {
    isDrainingQueue = false;
  }
}

// --- Busca de e-mails -------------------------------------------------------

/** Monta o critério IMAP, aninhando OR quando há mais de um remetente. */
function buildSearchCriteria(addresses: string[]): unknown[] {
  if (addresses.length === 0) return ['UNSEEN'];

  let criteria: unknown = ['HEADER', 'FROM', addresses[0]];
  for (let i = 1; i < addresses.length; i += 1) {
    criteria = ['OR', criteria, ['HEADER', 'FROM', addresses[i]]];
  }
  return ['UNSEEN', criteria];
}

function fetchAndParse(uids: number[]): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;

    // Sem este guarda, um servidor que para no meio da entrega (ou devolve
    // menos atributos do que o node-imap pediu, caso em que a mensagem nunca
    // emite 'end') deixaria esta promise pendente para sempre — e com ela
    // isSearching travado em true, parando o listener em silêncio.
    const guard = setTimeout(() => {
      finish(`A busca de ${uids.length} e-mail(s) não terminou em ${FETCH_TIMEOUT_MS / 1_000}s; ciclo abortado`);
    }, FETCH_TIMEOUT_MS);

    function finish(errorMessage?: string) {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      if (errorMessage) logger.error(errorMessage);
      resolve();
    }

    const pending: Promise<void>[] = [];
    // Em simulação não marcamos como lido: o e-mail precisa continuar UNSEEN
    // para a rodada real encontrá-lo depois.
    const fetcher = imap.fetch(uids, { bodies: '', markSeen: !DRY_RUN });

    fetcher.on('message', (msg) => {
      let uid: number | undefined;
      let parsing: Promise<ParsedMail> | undefined;

      msg.on('attributes', (attrs) => {
        uid = attrs.uid;
      });

      msg.on('body', (stream) => {
        parsing = simpleParser(stream as Readable);
      });

      pending.push(
        new Promise<void>((done) => {
          msg.once('end', () => {
            void (async () => {
              try {
                if (!parsing) {
                  logger.warn('Mensagem sem corpo; descartada');
                  return;
                }
                const mail = await parsing;
                if (uid === undefined) {
                  logger.warn(`Mensagem sem UID ("${mail.subject ?? 'sem assunto'}"); descartada`);
                  return;
                }
                enqueue({ uid, mail });
              } catch (cause) {
                logger.error('Falha ao interpretar o e-mail', cause);
              } finally {
                done();
              }
            })();
          });
        }),
      );
    });

    fetcher.once('error', (cause) => {
      logger.error('Erro ao buscar os e-mails', cause);
    });

    fetcher.once('end', () => {
      void Promise.all(pending).then(() => finish());
    });
  });
}

async function handleEmails(): Promise<void> {
  if (isSearching) {
    searchAgainWhenDone = true;
    return;
  }

  const targetSubjects = readList('TARGET_EMAIL_SUBJECTS', 'TARGET_EMAIL_SUBJECT');
  if (targetSubjects.length === 0) {
    logger.error('TARGET_EMAIL_SUBJECTS não configurado; nada será processado');
    return;
  }

  const targetAddresses = readList('TARGET_EMAIL_ADDRESSES', 'TARGET_EMAIL_ADDRESS');
  if (targetAddresses.length === 0) {
    logger.error('TARGET_EMAIL_ADDRESSES não configurado; nada será processado');
    return;
  }

  isSearching = true;
  try {
    const uids = await new Promise<number[]>((resolve, reject) => {
      imap.search(buildSearchCriteria(targetAddresses), (err, results) => {
        if (err) return reject(new MailboxError('Busca IMAP falhou', { cause: err }));
        resolve(results ?? []);
      });
    });

    if (uids.length > 0) {
      await fetchAndParse(uids);
    }
  } catch (cause) {
    logger.error('Falha ao consultar a caixa de entrada', cause);
  } finally {
    isSearching = false;
  }

  await drainQueue();

  if (searchAgainWhenDone) {
    searchAgainWhenDone = false;
    await handleEmails();
  }
}

// --- Conexão e reconexão ----------------------------------------------------
// Backoff exponencial com jitter, recriando a instância do Imap. O
// `restart: unless-stopped` do Docker fica como último recurso: só desistimos
// depois de MAX_RECONNECT_ATTEMPTS falhas seguidas.

function teardownConnection() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  if (stabilityTimer) {
    clearTimeout(stabilityTimer);
    stabilityTimer = null;
  }
  // O callback de imap.search() nunca volta numa conexão morta; sem isto o
  // guard de concorrência ficaria travado em true para sempre.
  isSearching = false;
  searchAgainWhenDone = false;
}

function scheduleReconnect(reason: string) {
  if (isShuttingDown || reconnectTimer) return;

  reconnectAttempts += 1;

  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    logger.error(
      `${reason}. ${MAX_RECONNECT_ATTEMPTS} tentativas de reconexão falharam em sequência; ` +
        'encerrando com código 1 para o supervisor assumir.',
    );
    process.exit(1);
  }

  const exponential = Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempts - 1), RECONNECT_MAX_MS);
  // Jitter de 50–100%, para várias instâncias não baterem no servidor juntas.
  const delay = Math.round(exponential * (0.5 + Math.random() * 0.5));

  logger.warn(
    `${reason}. Reconectando em ${(delay / 1000).toFixed(1)}s ` +
      `(tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectImap();
  }, delay);
}

function connectImap() {
  if (isShuttingDown) return;

  const generation = ++connectionGeneration;
  // Handlers de conexões antigas se auto-silenciam: sem isto, o `close` de uma
  // conexão morta agendaria reconexão em cima de uma conexão nova e saudável.
  const isStale = () => generation !== connectionGeneration;

  imap = createImapInstance();

  const onDisconnect = (reason: string) => {
    if (isStale()) return;
    teardownConnection();
    scheduleReconnect(reason);
  };

  imap.once('ready', () => {
    if (isStale()) return;

    imap.openBox('INBOX', false, (err) => {
      if (isStale()) return;

      if (err) {
        logger.error('Erro ao abrir a INBOX', err);
        try {
          imap.end();
        } catch {
          // a conexão já pode estar caindo; o agendamento abaixo cobre o caso
        }
        onDisconnect('Falha ao abrir a INBOX');
        return;
      }

      logger.info('Conexão IMAP pronta, escutando e-mails na INBOX');

      // O orçamento de reconexão só zera depois que a conexão provar que se
      // mantém de pé — senão um servidor que aceita e derruba em seguida nunca
      // sofreria backoff nenhum.
      stabilityTimer = setTimeout(() => {
        stabilityTimer = null;
        reconnectAttempts = 0;
      }, STABLE_CONNECTION_MS);

      imap.on('mail', () => {
        void handleEmails();
      });

      pollingInterval = setInterval(() => {
        void handleEmails();
      }, POLLING_SECONDS * 1_000);

      // Varre uma vez de imediato: podem ter chegado e-mails enquanto
      // estávamos desconectados.
      void handleEmails();
    });
  });

  imap.on('error', (err: Error) => {
    if (isStale()) return;
    logger.error('Erro de IMAP', err);
    onDisconnect('Conexão IMAP falhou');
  });

  // node-imap emite os dois; scheduleReconnect é idempotente via reconnectTimer.
  imap.on('close', () => onDisconnect('Conexão IMAP fechada'));
  imap.on('end', () => onDisconnect('Conexão IMAP encerrada'));

  imap.connect();
}

// --- Desligamento -----------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`${signal} recebido, encerrando o listener IMAP...`);

  // Rede de segurança: se o fechamento gracioso travar, saímos assim mesmo
  // antes do supervisor perder a paciência e mandar SIGKILL.
  const guard = setTimeout(() => {
    logger.warn('Desligamento gracioso demorou demais; saindo à força');
    process.exit(0);
  }, SHUTDOWN_TIMEOUT_MS);
  guard.unref();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  teardownConnection();

  connectionGeneration += 1; // silencia os handlers da conexão atual
  try {
    imap?.end();
  } catch {
    // encerrando de qualquer forma
  }

  await closeBrowser();
  process.exit(0);
}

// --- Início -----------------------------------------------------------------

(function main() {
  logger.info('Iniciando o listener IMAP da automação Netflix');
  logger.info(`Polling de reserva a cada ${POLLING_SECONDS}s (o IDLE é o mecanismo primário)`);
  if (DRY_RUN) {
    logger.warn('MODO SIMULAÇÃO ativo: nenhum link será aberto e nenhum e-mail será apagado');
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error(`Promise rejeitada sem tratamento: ${describeCause(reason)}`);
  });

  connectImap();
})();
