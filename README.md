# Automate Netflix Household Primary Location with IMAP

> Use your time for better things than manually accepting things

- ✉️ Compatible with All Email Providers That Use IMAP
- ⚡️️ Blazing-Fast Acceptance
- 🛠️ Up to Zero Configuration
- 🍃 Even Runs on Raspberry Pi

Manually updating and accepting Netflix primary location *sucks*—**especially when you have 2 or more devices**. Keeping track of verification emails and updating your primary location can be a tedious chore. This tool automates the entire process, saving you time without the hassle of looking you E-Mails manually.

## 🚀 Usage

*Start the Docker container, and you’re good to go!*

```sh
# the first run builds the image; later runs just start it
docker compose up
[+] Running 1/1
 ✔ Container imap-netflix-household-automation
Attaching to imap-netflix-household-automation
imap-netflix-household-automation  | 09/08/2026, 13:52:11 [INFO ] Iniciando o listener IMAP da automação Netflix
imap-netflix-household-automation  | 09/08/2026, 13:52:11 [INFO ] Polling de reserva a cada 60s (o IDLE é o mecanismo primário)
imap-netflix-household-automation  | 09/08/2026, 13:52:12 [INFO ] Conexão IMAP pronta, escutando e-mails na INBOX
```

> After changing anything under `src/`, rebuild the image: `docker compose up -d --build`.
## Getting Started
> **❗️Please note that currently only the INBOX checks for new emails. If there are enough requests to check emails in other folders, this feature will be implemented in the near future.**

Lets speed it up!

### Prerequisites

No complex setup, no hassle. With just **Docker Compose**, you’re ready to run this project anywhere—even on a Raspberry Pi. That’s it, seriously!

Don't forget to enable IMAP in your email provider. For example, in Gmail, go to Settings > Forwarding and POP/IMAP > IMAP Access, and enable it:

[Gmail Forwarding POP/IMAP Settings](https://mail.google.com/mail/u/2/#settings/fwdandpop)

> **⚠️ If you use 2-Step Verification (Gmail, Outlook and most providers), your normal
> password will not work over IMAP.** You need to generate an **App Password** and use
> that as `IMAP_PASSWORD`: [Google App Passwords](https://myaccount.google.com/apppasswords).
> This is the most common reason the container fails to authenticate on the first run.

### Installation

1. Clone the repo
   ```sh
   git clone https://github.com/ducphu0ng/imap-netflix-household-automation.git
   ```
2. navigate to folder
   ```sh
   cd imap-netflix-household-automation
   ```
3. Copy **.env.dist** to **.env** and fill in all the environment variables. For examples, see the [Examples](#environment-examples) section
   ```sh
   cp .env.dist .env
   ```
4. starting IMAP Listener with docker compose. 💡**PRO TIP** use the -d flag to run the process in the background look up to [docker compose up reference](https://docs.docker.com/reference/cli/docker/compose/up/) 
   ```sh
   docker compose up -d
   ```
That’s it! Docker will automatically install all the necessary dependencies and start the script.

You can view the script's output — as shown in [🚀 Usage](#-usage) — by using the following command: [docker compose logs reference](https://docs.docker.com/reference/cli/docker/compose/logs/)
```sh
docker compose logs -f
```

## Environment Examples

### IMAP Configs
- **IMAP_USER**: Your IMAP Username
- **IMAP_PASSWORD**: Your IMAP Password — **an App Password if you have 2FA enabled** (see the warning above)
- **IMAP_HOST**: Your IMAP Host e.g. for *GMAIL* is imap.gmail.com
- **IMAP_PORT**: Your IMAP port connection is usually on port 993
- **IMAP_TRASH_FOLDER** *(optional)*: Where processed emails are moved. Leave empty to auto-detect — that currently covers Gmail and root-level names (`Trash`, `Lixeira`, `Papelera`, `Corbeille`). On Dovecot/Yahoo set it explicitly, e.g. `INBOX.Trash`.

### Email Configs
Both accept **several values separated by a pipe (`|`)**. The singular forms
(`TARGET_EMAIL_ADDRESS` / `TARGET_EMAIL_SUBJECT`) still work, but the plural ones take
precedence.

- **TARGET_EMAIL_ADDRESSES**: The address(es) to monitor. Note the real Netflix sender is on the `account.netflix.com` subdomain, e.g. *`info@account.netflix.com|no-reply@account.netflix.com`*
- **TARGET_EMAIL_SUBJECTS**: The subject(s) to monitor e.g. *`How to update your Netflix Household|Como atualizar sua Netflix Household`*

> **Note on deleted mail:** every email returned by the search is moved to the Trash folder
> after being handled — whether it was processed, ignored or failed. This keeps the inbox
> from filling up; Netflix re-sends the link when it is needed.
>
> Because of that, **a wrong `TARGET_EMAIL_SUBJECTS` means the verification link gets
> trashed unused.** Run once with `DRY_RUN="1"` first (see below) to confirm the filter
> matches before trusting it.

### Dry run
- **DRY_RUN** *(default `0`)*: Set to `1` to simulate. The listener still finds the email and
  logs which subject matched and which link it *would* open — but it does not open the link,
  does not move anything to Trash, and does not mark the email as read (it fetches with
  `BODY.PEEK[]`), so the same email is still there for the real run.

### Tuning *(all optional — the defaults suit most setups)*
- **POLLING_INTERVAL_SECONDS** *(default 60)*: Fallback sweep. IMAP IDLE already pushes new mail in real time, so this is only a safety net. Low values burn server quota without improving latency — Gmail rate-limits IMAP commands.
- **MAX_RECONNECT_ATTEMPTS** *(default 20)*: Consecutive reconnect failures tolerated before the process exits with code 1 and lets `restart: unless-stopped` take over. The delay between attempts grows from 1s up to a 5min ceiling.
- **MAX_QUEUE_SIZE** *(default 50)*: Cap on emails waiting to be processed. When exceeded, the oldest is dropped with a warning.

## License

[MIT](https://choosealicense.com/licenses/mit/) © [Duc Phung](https://github.com/ducphu0ng)

If you find this project interesting or helpful, I'd love your support!
Please consider giving it a star (⭐) and following me on GitHub.

I love coding and always have new ideas, so stay tuned—your support won’t be in vain!

## Acknowledgements

- [node-imap](https://github.com/mscdex/node-imap)
- [playwright](https://github.com/microsoft/playwright)