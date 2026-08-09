// Erros que existem para serem LANÇADOS.
//
// Nada aqui escreve em log. Quem captura é que decide se registra, tenta de
// novo ou desiste — e o compilador deixa claro que um `throw` interrompe o
// fluxo, coisa que a antiga Errorlogger escondia. Ver logger.ts.

/** A página da Netflix não confirmou a atualização da residência. */
export class HouseholdUpdateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HouseholdUpdateError';
  }
}

/** Uma operação na caixa postal IMAP falhou (abrir pasta, mover mensagem…). */
export class MailboxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MailboxError';
  }
}
