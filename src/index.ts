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

// Reconnection control
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 5000; // 5 seconds
let isReconnecting = false;

function reconnect() {
  if (isReconnecting) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    new Errorlogger(`Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
    process.exit(1);
  }
  isReconnecting = true;
  reconnectAttempts++;
  const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1), 300000);
  console.log(`🔄 Attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) in ${delay / 1000}s...`);
  setTimeout(() => {
    isReconnecting = false;
    try {
      // Destroi a instância antiga e cria uma nova
      try { imap.end(); } catch {}
      imap.removeAllListeners && imap.removeAllListeners();
      imap = createImapInstance();
      imap.connect();
    } catch (e) {
      console.log(`Reconnection attempt failed: ${e}`);
      reconnect();
    }
  }, delay);
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

    // https://github.com/mscdex/node-imap#:~:text=currently%20open%20mailbox.-,Valid%20options%20properties%20are%3A,-*%20**markSeen**%20%2D%20_boolean_%20%2D%20Mark
    const fetchingData = imap.fetch(results, { bodies: ['HEADER', 'TEXT'], markSeen: false });
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

      // Process only after message is fully received
      msg.once('end', async () => {
        if (!headersDone || !bodyDone) return;
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

          // Check if subject matches any of the target subjects
          const isSubjectMatch = targetSubjects.some(targetSubject => 
            emailSubject.toLowerCase().includes(targetSubject.toLowerCase()) || 
            targetSubject.toLowerCase().includes(emailSubject.toLowerCase())
          );
          
          if (!isSubjectMatch) {
            return;
          }

          // Mark as read only when both address AND subject match
          if (msgUid) {
            imap.addFlags(msgUid, ['\\Seen'], (err) => {
              if (err) console.log(`Failed to mark email as read: ${err}`);
            });
          }

          console.log(`📬 New mail received!`);
          console.log(`✓ Processing Netflix email from ${sender}: "${emailSubject}"`);
          const decodedBody = decodeEmailBody(body);

          // Extract all links and filter for update-primary-location
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
        });
      });

    fetchingData.on('error', (fetchingError) => {
      new Errorlogger(`Fetching Error: ${fetchingError}`);
    });

    fetchingData.once('end', () => {
      isProcessing = false;
      // If there was a pending check request, run it now
      if (pendingCheck) {
        pendingCheck = false;
        handleEmails();
      }
    });
  });
}

let pollingInterval: NodeJS.Timeout | null = null;

  // start listening to Inbox
  imap.once('ready', () => {
    // Reset reconnection counter on successful connection
    reconnectAttempts = 0;
    
    imap.openBox('INBOX', false, (err) => {
      if (err) {
        new Errorlogger(`open INBOX Error => ${err}`);
        reconnect();
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



function restartProcess() {
  console.log('♻️ Reiniciando o processo principal para restabelecer a conexão IMAP...');
  process.on('exit', function () {
    require('child_process').spawn(process.argv.shift(), process.argv, {
      cwd: process.cwd(),
      detached: true,
      stdio: 'inherit'
    });
  });
  process.exit(0);
}

(function main() {
  console.log('🚀 Starting Netflix Automation IMAP listener...');
  imap.connect();
}());
