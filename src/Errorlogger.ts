export default class Errorlogger extends Error {
  constructor(error: any) {
    const currentDateTime = new Date();

    const brTime = new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'full',
      timeStyle: 'long',
      timeZone: 'America/Sao_Paulo',
    }).format(currentDateTime);

    const errorMessage = error?.message ?? error;
    const fullMessage = `Errorlogger: ${brTime} | ${errorMessage}`;

    super(fullMessage);
    this.name = 'Errorlogger';
    console.log(fullMessage);
  }
}
