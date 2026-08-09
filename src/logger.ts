// Logger: apenas registra. Nunca lança, nunca interrompe fluxo.
//
// Isto existe separado de errors.ts de propósito. A antiga classe Errorlogger
// estendia Error e era ora só construída (virando log), ora lançada (virando
// exceção) — o mesmo tipo servindo aos dois papéis. Era isso que fazia falhas
// reais parecerem tratadas: `new Errorlogger(...)` lê como tratamento de erro,
// mas não interrompe nada.

const LABELS = {
  info: 'INFO ',
  warn: 'AVISO',
  error: 'ERRO ',
} as const;

type Level = keyof typeof LABELS;

const timestamp = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'medium',
  timeZone: process.env.TZ || 'America/Sao_Paulo',
});

/** Extrai uma mensagem legível de qualquer coisa que tenha sido lançada. */
export function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const root = cause.cause;
    const suffix = root instanceof Error ? ` (causa: ${root.message})` : '';
    return `${cause.message}${suffix}`;
  }
  return String(cause);
}

function write(level: Level, message: string, cause?: unknown) {
  const suffix = cause === undefined ? '' : ` | ${describeCause(cause)}`;
  const line = `${timestamp.format(new Date())} [${LABELS[level]}] ${message}${suffix}`;
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (message: string) => write('info', message),
  warn: (message: string, cause?: unknown) => write('warn', message, cause),
  error: (message: string, cause?: unknown) => write('error', message, cause),
};
