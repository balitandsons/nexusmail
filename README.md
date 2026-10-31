# NexusMail

Multi-provider bulk mailer and AI omnichannel inbox. Connect any number of **Hostinger, Brevo, ZeptoMail and custom SMTP** mailboxes,
send campaigns across all of them at once (e.g. 10 mailboxes × 100 emails, each mailbox waiting a random 10–30 s between sends), and let
Gemini triage replies from **email (IMAP / webhook), WhatsApp Cloud API, Instagram and Messenger**.

Stack: Express + TypeScript (nodemailer, `@google/genai`, imapflow) and a Vite + React 19 UI. Data lives in `data/` (JSON files, gitignored).
The sending engine is ported from the BulkMail Pilot app.

## Run

```bash
cd nexusmail
cp .env.example .env        # set ADMIN_PASSWORD (a random one is generated if left as the placeholder)
npm install
npm run build && npm start  # http://localhost:3000
# or for development: npm run dev   (UI on :5173, API on :3000)
npm test                    # unit tests for templating, CSV parsing, health scoring
```

## Modes

* **Test Sandbox** (default): deliveries and channel replies are simulated; nothing leaves the server. Pacing, quotas and balancing behave as in Live.
  Sandbox recipients containing `bounce` hard-bounce, `softfail` soft-bounce, and a mailbox whose From contains `authfail` fails login, so you can watch the balancer react.
* **Live**: real SMTP / Brevo API / ZeptoMail API sends and real WhatsApp/Meta replies. Switch with the toggle in the top bar.

## How sending works

* One worker per attached mailbox. Each waits a random `min–max` seconds (default 10–30) between its own emails, scaled up for unhealthy mailboxes.
* **Volume per mailbox** (e.g. 100) is a per-day cap per mailbox, also bounded by the mailbox's own daily limit. Leftover recipients continue automatically the next day.
* **Health-based balancing**: each mailbox has a 0–100 score from hard-bounce rate, soft-bounce rate, consecutive errors, rest periods and missing SPF/DKIM/DMARC (use *Check DNS*).
  Degraded mailboxes get a smaller share and slower pacing; transient errors rest the mailbox; a login failure stops only that mailbox and its recipients go to the others.
* Rejected addresses are marked failed; a recipient that fails transiently 3 times is given up on. Unsubscribes and the do-not-send list are always honoured.
* Personalisation: `{{firstName}}`, `{{company}}`, any CSV column, defaults `{{company|your team}}`, spin text `{Hi|Hello}`.

## Providers

* **Hostinger**: From email = the mailbox + its password; `smtp.hostinger.com:465` is preset (IMAP `imap.hostinger.com:993`).
* **Brevo**: v3 API key; the From address must be a verified sender.
* **ZeptoMail**: Send Mail token + data centre. ZeptoMail is **transactional only**: do not use it for promotions.
* **Custom SMTP**: host, port, username, password.

Press **Test connection** on each mailbox (in Live mode it performs a real SMTP handshake / API call).

## AI inbox

`POST` events arrive through the webhooks listed in **API & Webhooks** (set your Public URL and the verify tokens / Meta app secret there).
Webhook payloads must be signed with the app secret (`X-Hub-Signature-256`); unsigned requests are rejected.
For each message Gemini returns intent, sentiment, a confidence score and a draft reply.
**Hybrid autopilot**: ≥ threshold (default 85%) is sent automatically; below it, the draft waits as *Needs Review*. Unsubscribe requests add the contact to the do-not-send list and are never answered.
Set `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`, default `gemini-3.8-flash`; change it if your account uses a different model name).
Without a key a simple keyword classifier is used; in Live mode its drafts are never auto-sent.

## Deliverability and rules

* Email only people who opted in or are your customers (CAN-SPAM, DPDP, GDPR and every provider's terms forbid unsolicited bulk mail).
* Put your business name and address in the footer; keep the unsubscribe link and set the Public URL so it works in one click.
* Set up SPF, DKIM and DMARC for every sending domain. Start new mailboxes at 20–30/day and raise limits over weeks.
* Provider keys and mailbox passwords are stored in `data/db.json` in plain form. Protect the server and use a strong `ADMIN_PASSWORD`.
