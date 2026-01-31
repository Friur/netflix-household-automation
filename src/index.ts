import Imap from 'imap';
import Errorlogger from './Errorlogger';
import playwrightAutomation from './playwrightAutomation';

// Helper function to decode MIME encoded-word subjects
function decodeMimeSubject(subject: string): string {
  return subject.replace(/=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g, (match, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        // Base64 decoding with charset support
        const decoded = Buffer.from(text, 'base64');
        return decoded.toString('utf-8');
      } else if (encoding.toUpperCase() === 'Q') {
        // Quoted-printable decoding
        const qpDecoded = text.replace(/_/g, ' ').replace(/=([a-f0-9]{2})/ig, (m: string, code: string) =>
          String.fromCharCode(parseInt(code, 16))
        );
        // Convert to proper UTF-8 if needed
        return Buffer.from(qpDecoded, 'latin1').toString('utf-8');
      }
    } catch (e) {
      return match;
    }
    return match;
  });
}

// Build search criteria for multiple FROM addresses using OR
function buildSearchCriteria(addresses: string[]): any[] {
  if (addresses.length === 0) return ['UNSEEN'];
  if (addresses.length === 1) {
    return ['UNSEEN', ['HEADER', 'FROM', addresses[0]]];
  }

  // Build nested OR for multiple addresses
  let orCriteria: any = ['HEADER', 'FROM', addresses[0]];
  for (let i = 1; i < addresses.length; i++) {
    orCriteria = ['OR', orCriteria, ['HEADER', 'FROM', addresses[i]]];
  }
  return ['UNSEEN', orCriteria];
}

// Decode email body (base64 or quoted-printable)
function decodeEmailBody(body: string): string {
  if (body.includes('Content-Transfer-Encoding: base64')) {
    const base64Match = body.match(/Content-Transfer-Encoding: base64\s*\n\s*\n([A-Za-z0-9+/=\s]+)/);
    if (base64Match?.[1]) {
      try {
        const base64Content = base64Match[1].replace(/\s/g, '');
        return Buffer.from(base64Content, 'base64').toString('utf-8');
      } catch (e) {
        new Errorlogger(`Base64 decode error: ${e}`);
      }
    }
  }
  // Handle quoted-printable encoding
  return body.replace(/=(\r?\n|$)/g, '').replace(/=([a-f0-9]{2})/ig, (m, code) =>
    String.fromCharCode(parseInt(code, 16))
  );
}

function createImapInstance() {
  return new Imap({
    user: process.env.IMAP_USER ?? '',
    password: process.env.IMAP_PASSWORD ?? '',
    host: process.env.IMAP_HOST ?? '',
    port: Number(process.env.IMAP_PORT) ?? 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    connTimeout: 3_600_000, // set to 1 Hour to reconnect, if Connection is lost
    keepalive: {
      interval: 60000, // Send NOOP every 60 seconds to keep connection alive
      idleInterval: 600000, // Re-issue IDLE command every 10 minutes
    },
  });
}

let imap = createImapInstance();

// Prevent concurrent email processing
let isProcessing = false;
let pendingCheck = false;

// Fila de emails para processamento sequencial
let emailQueue: Array<{ msgUid: number, headers: string, body: string }> = [];
let isProcessingQueue = false;

let pollingInterval: NodeJS.Timeout | null = null;

// Função para processar um email individual
async function processIndividualEmail(emailData: { msgUid: number, headers: string, body: string }): Promise<void> {
  const { msgUid, headers, body } = emailData;
  
  // Get target subjects from environment variable
  const targetSubjects = (process.env.TARGET_EMAIL_SUBJECTS || process.env.TARGET_EMAIL_SUBJECT || '')
    .split('|')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  // Extract and decode email subject
  const subjectMatch = headers.match(/^Subject: (.+)$/im);
  if (!subjectMatch) {
    console.log('Email from Netflix found...');
    return;
  }

  const rawSubject = subjectMatch[1].trim();
  const emailSubject = decodeMimeSubject(rawSubject);

  // Extract sender
  const fromMatch = headers.match(/^From: (.+)$/im);
  const sender = fromMatch ? fromMatch[1].trim() : 'Unknown';

  // Check if subject matches
  const isSubjectMatch = targetSubjects.some(targetSubject =>
    emailSubject.toLowerCase().includes(targetSubject.toLowerCase()) ||
    targetSubject.toLowerCase().includes(emailSubject.toLowerCase())
  );

  if (!isSubjectMatch) {
    return;
  }

  console.log(`📬 Processing email from queue (${emailQueue.length} remaining)`);
  console.log(`✓ Processing Netflix email from ${sender}: "${emailSubject}"`);

  const decodedBody = decodeEmailBody(body);
  const allLinksRegex = /https?:\/\/[^\s<>"'\])]+/gi;
  const allLinks = decodedBody.match(allLinksRegex) || [];
  const netflixLink = allLinks.find(link => link.includes('update-primary-location'));

  if (netflixLink) {
    try {
      const updatePrimaryLink = new URL(netflixLink);
      console.log(`Found Netflix link: ${updatePrimaryLink.toString()}`);
      await playwrightAutomation(updatePrimaryLink.toString());
      console.log('✓ Successfully processed Netflix household update');
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      new Errorlogger(`Error processing Netflix link, ${errorMsg}`);
    }
  } else {
    new Errorlogger('No Netflix update-primary-location link found in email');
  }
}

// Função para processar a fila sequencialmente
async function processEmailQueue() {
  if (isProcessingQueue || emailQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;
  console.log(`🔄 Starting queue processing (${emailQueue.length} emails in queue)`);

  while (emailQueue.length > 0) {
    const emailData = emailQueue.shift()!;
    
    try {
      console.log(`⏳ Processing email... ${emailQueue.length} remaining in queue`);
      await processIndividualEmail(emailData);
      console.log(`✅ Email processed successfully`);
    } catch (error) {
      console.error('❌ Error processing email from queue:', error);
    }
  }

  console.log('✅ Queue processing completed');
  isProcessingQueue = false;
}

async function handleEmails() {
  // Prevent concurrent execution
  if (isProcessing) {
    pendingCheck = true;
    return;
  }

  isProcessing = true;

  // Get target subjects from environment variable (supports multiple subjects separated by |)
  const targetSubjects = (process.env.TARGET_EMAIL_SUBJECTS || process.env.TARGET_EMAIL_SUBJECT || '')
    .split('|')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (targetSubjects.length === 0) {
    new Errorlogger('No TARGET_EMAIL_SUBJECTS configured');
    isProcessing = false;
    return;
  }

  // Get target email addresses from environment variable (supports multiple addresses separated by |)
  const targetAddresses = (process.env.TARGET_EMAIL_ADDRESSES || process.env.TARGET_EMAIL_ADDRESS || '')
    .split('|')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (targetAddresses.length === 0) {
    new Errorlogger('No TARGET_EMAIL_ADDRESSES configured');
    isProcessing = false;
    return;
  }

  const searchCriteria = buildSearchCriteria(targetAddresses);

  // Search for emails from target addresses that are unseen
  imap.search(searchCriteria, (err, results) => {
    if (err) {
      new Errorlogger(err);
      isProcessing = false;
      return;
    }

    // No E-Mails found => skip
    if (!results || !results.length) {
      isProcessing = false;
      return;
    }

    // markSeen: true marca emails como lidos imediatamente ao buscar
    const fetchingData = imap.fetch(results, { bodies: ['HEADER', 'TEXT'], markSeen: true });

    fetchingData.on('message', (msg) => {
      let body = '';
      let headers = '';
      let headersDone = false;
      let bodyDone = false;
      let msgUid: number | undefined;

      msg.on('attributes', (attrs) => {
        msgUid = attrs.uid;
      });

      msg.on('body', (stream, info) => {
        stream.on('data', (chunk) => {
          const chunkStr = chunk.toString('utf-8');
          if (info.which === 'HEADER') {
            headers += chunkStr;
          } else {
            body += chunkStr;
          }
        });

        stream.on('end', () => {
          if (info.which === 'HEADER') {
            headersDone = true;
          } else {
            bodyDone = true;
          }
        });
      });

      msg.once('end', () => {
        if (!headersDone || !bodyDone || !msgUid) return;
        
        // Adiciona o email à fila
        emailQueue.push({ msgUid, headers, body });
        console.log(`📬 Email adicionado à fila (total na fila: ${emailQueue.length})`);
      });
    });

    fetchingData.on('error', (fetchingError) => {
      new Errorlogger(`Fetching Error: ${fetchingError}`);
    });

    fetchingData.once('end', () => {
      isProcessing = false;

      // Inicia o processamento da fila
      processEmailQueue();

      // If there was a pending check request, run it now
      if (pendingCheck) {
        pendingCheck = false;
        handleEmails();
      }
    });
  });
}

// ✅ Função para reiniciar o processo completo
function restartProcess() {
  console.log('♻️ Reiniciando o processo principal para restabelecer a conexão IMAP...');
  const cmd = process.argv[0];
  const args = process.argv.slice(1);

  process.on('exit', async function () {
    (await import('child_process')).spawn(cmd, args, {
      cwd: process.cwd(),
      detached: true,
      stdio: 'inherit'
    });
  });

  process.exit(0);
}

// ✅ Configura os handlers do IMAP
function setupImapHandlers() {
  // start listening to Inbox
  imap.once('ready', () => {
    imap.openBox('INBOX', false, (err) => {
      if (err) {
        new Errorlogger(`open INBOX Error => ${err}`);
        restartProcess(); // ✅ Usa restartProcess em vez de reconnect
        return;
      }

      console.log('✅ IMAP connection is ready, start listening Emails on INBOX');

      // When new mail arrives (IDLE push notification)
      imap.on('mail', () => {
        handleEmails();
      });

      // Clear existing polling interval if any
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }

      // Polling fallback configurável via .env (POLLING_INTERVAL_SECONDS)
      const pollingSeconds = Number(process.env.POLLING_INTERVAL_SECONDS) || 5;
      pollingInterval = setInterval(() => {
        handleEmails();
      }, pollingSeconds * 1000);
    });
  });

  // Handle Imap errors
  imap.once('error', (err: Error) => {
    new Errorlogger(`IMAP error: ${err.message}. Reiniciando processo para restabelecer conexão...`);
    restartProcess();
  });

  // Handle connection close - attempt reconnect
  imap.once('end', () => {
    console.log('⚠️ IMAP connection ended unexpectedly');

    // Clear polling interval
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }

    restartProcess();
  });
}

// ✅ Função principal
(function main() {
  console.log('🚀 Starting Netflix Automation IMAP listener...');
  setupImapHandlers();
  imap.connect();
}());
