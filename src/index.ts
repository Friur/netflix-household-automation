import Imap from 'imap';
import Errorlogger from './Errorlogger';
import playwrightAutomation from './playwrightAutomation';

// Helper function to decode MIME encoded-word subjects
function decodeMimeSubject(subject: string): string {
  return subject.replace(/=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g, (match, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        return Buffer.from(text, 'base64').toString('utf-8');
      } else if (encoding.toUpperCase() === 'Q') {
        return text.replace(/_/g, ' ').replace(/=([a-f0-9]{2})/ig, (m: string, code: string) => 
          String.fromCharCode(parseInt(code, 16))
        );
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

const imap = new Imap({
  user: process.env.IMAP_USER ?? '',
  password: process.env.IMAP_PASSWORD ?? '',
  host: process.env.IMAP_HOST ?? '',
  port: Number(process.env.IMAP_PORT) ?? 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false },
  connTimeout: 3_600_000, // set to 1 Hour to reconnect, if Connection is lost
  keepalive: {
    interval: 10000, // Send NOOP every 10 seconds to keep connection alive
    idleInterval: 10000, // Re-issue IDLE command every 10 seconds
  },
});

async function handleEmails() {
  // Get target subjects from environment variable (supports multiple subjects separated by |)
  const targetSubjects = (process.env.TARGET_EMAIL_SUBJECTS || process.env.TARGET_EMAIL_SUBJECT || '')
    .split('|')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (targetSubjects.length === 0) {
    new Errorlogger('No TARGET_EMAIL_SUBJECTS configured');
    return;
  }

  // Get target email addresses from environment variable (supports multiple addresses separated by |)
  const targetAddresses = (process.env.TARGET_EMAIL_ADDRESSES || process.env.TARGET_EMAIL_ADDRESS || '')
    .split('|')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (targetAddresses.length === 0) {
    new Errorlogger('No TARGET_EMAIL_ADDRESSES configured');
    return;
  }

  console.log(`Searching for emails from: ${targetAddresses.join(', ')}`);
  const searchCriteria = buildSearchCriteria(targetAddresses);

  // Search for emails from target addresses that are unseen
  imap.search(searchCriteria, (err, results) => {
    if (err) {
      new Errorlogger(err);
    }

    // No E-Mails found => skip
    if (!results || !results.length) {
      return;
    }

    // https://github.com/mscdex/node-imap#:~:text=currently%20open%20mailbox.-,Valid%20options%20properties%20are%3A,-*%20**markSeen**%20%2D%20_boolean_%20%2D%20Mark
    const fetchingData = imap.fetch(results, { bodies: ['HEADER', 'TEXT'], markSeen: true });
    fetchingData.on('message', (msg) => {
      let body = '';
      let headers = '';
      
      msg.on('body', (stream, info) => {
        stream.on('data', (chunk) => {
          const chunkStr = chunk.toString('utf-8');
          if (info.which === 'HEADER') {
            headers += chunkStr;
          } else {
            body += chunkStr;
          }
        });

        stream.on('end', async () => {
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
            console.log(`Ignoring email from ${sender} with subject: "${emailSubject}"`);
            return;
          }

          console.log(`✓ Processing Netflix email from ${sender}: "${emailSubject}"`);
          const decodedBody = decodeEmailBody(body);

          // Search specific link, open and click
          const regex = /https:\/\/www\.netflix\.com\/account\/update-primary-location[^\s<>"'\])]*/i;
          const match = decodedBody.match(regex);

          if (match?.[0]) {
            try {
              const updatePrimaryLink = new URL(match[0]);
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
    });

    fetchingData.on('error', (fetchingError) => {
      new Errorlogger(`Fetching Error: ${fetchingError}`);
    });
  });
}

(function main() {
  // Connect to the IMAP server
  imap.connect();

  // start listening to Inbox
  imap.once('ready', () => {
    imap.openBox('INBOX', false, (err) => {
      if (err) {
        throw new Errorlogger(`open INBOX Error => ${err}`);
      }

      console.log('IMAP connection is ready, start listening Emails on INBOX');
      
      // Check for new emails immediately on startup
      handleEmails();
      
      // When new mail arrives (IDLE push notification)
      imap.on('mail', (numNewMsgs: number) => {
        console.log(`📬 New mail received! (${numNewMsgs} message(s))`);
        handleEmails();
      });
      
      // Polling fallback every 10 seconds
      setInterval(() => {
        handleEmails();
      }, 10_000);
    });
  });
  // Handle Imap errors
  imap.once('error', (err: Error) => {
    throw new Errorlogger(`make sure you E-Mail Provider enabled IMAP and you IMAP Username and Password are correct: ${err}`);
  });

  // End connection on close
  imap.once('end', () => {
    console.log('IMAP connection ended');
  });
}());
