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

Hosting: see [DEPLOY-HOSTINGER.md](DEPLOY-HOSTINGER.md) (Hostinger Node.js apps), [DEPLOY-FIREBASE.md](DEPLOY-FIREBASE.md) (Firebase + Cloud Run) or [DEPLOY.md](DEPLOY.md) (VPS / Google VM).

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

## Inbox Agent (email triage)

Every unread email in IMAP-enabled mailboxes (tick *Read replies via IMAP* on a Hostinger/SMTP mailbox, Live mode, checked every minute) goes through three stages:

1. **Evidence**: bulk-mail headers, `noreply` senders, auto-responder and bounce markers count as "automated"; replies to an email you sent, people you have emailed before, and your allow list count as "human/known". Known beats automated.
2. **Gemini** reads sender, subject, headers and the first 2 KB of text and picks a category (customer inquiry, prospect reply, product question, sales request, support, partnership, vendor invoice, legal/security, newsletter, promotion, notification, phishing, bounce, other). Email text is treated as untrusted data.
3. **Policy (code, not the AI)**: customer/product/sales mail goes to the AI inbox for analysis and reply. Invoices, legal/security notices and anything unclear are **held for your review** and never deleted or auto-answered. Newsletters, promotions, notifications, phishing and bounces are moved to the mailbox **Trash folder** only if Gemini is at least 90% sure (adjustable) and nothing marks the sender as known.

Safety: **Dry run is on by default**: it only logs "would trash" until you untick it on the *Inbox Agent* page. Nothing is ever permanently deleted; the log has a *Restore* button (moves it back and allow-lists the sender). Without a `GEMINI_API_KEY` the offline classifier can only keep or hold, never trash. Use the *Test an email* box to check decisions before going live.

## Contacts (CRM), knowledge base and handoff rules

* **Contacts** are created automatically from campaign sends and from every inbound message (email, WhatsApp), and merged by email or phone number so one person is one contact across channels. Stages move forward on their own: new, contacted (email sent), replied, interested (the AI reads interest or a pricing question). Unsubscribing marks a contact lost. Set a stage by hand and automation leaves it alone. Each contact has tags, notes and a timeline of every email and message. Import or export CSV, and select contacts to add them to a campaign (unsubscribed or lost contacts are skipped). On first start after an upgrade, contacts are built from your existing campaigns and conversations.
* **Knowledge base**: short entries (paste `Q:`/`A:` blocks or `# Heading` sections). When a customer writes in, the best passages are found with BM25 keyword search (no extra service or cost) and given to the AI as the only facts it may state. The inbox shows which entries an answer used. If nothing in the knowledge base covers a factual question, the AI's confidence is capped at 75%, below the auto-send threshold, so a person reviews it.
* **Handoff rules**: messages with words such as refund, cancel, legal or complaint, anyone who sounds unhappy, and contacts tagged `vip` are never answered automatically. The AI still writes a draft. Optionally NexusMail emails you (from a mailbox you choose, Live mode, at most once an hour per conversation) when a person is needed.

## Lead lists

*Contacts (CRM)* is also the place for big lead lists. Import a CSV (`email, name, company, state, tags`; extra tags such as `solar-india`), then filter by **state**, **tag** or stage and use **Add N to campaign**: it adds the next N matching people who have not been emailed yet (run it again for the next batch), skipping unsubscribed and lost contacts. Campaign emails can use `{{company}}` and `{{state}}`. `tools/clean_leads.py` cleans messy spreadsheets (de-obfuscates `[at]`/`[dot]` emails, repairs shifted rows and domain typos, validates, de-duplicates, normalises state and company names): `python3 tools/clean_leads.py input.xlsx output_dir` (needs `pip install openpyxl`).

## Deliverability

* **Warm-up** (per mailbox, in its edit dialog): start at e.g. 20/day and add 5 per day until the mailbox's daily limit. New mailboxes that send at full volume on day one get flagged; this avoids that. Mailbox cards show today's allowed volume and days left.
* **Bounces.** When a mailbox with *Read replies via IMAP* receives a delivery-failure notice, the recipient is marked **bounced**, hard bounces go on the do-not-send list, and the sending mailbox's health score drops. Soft failures are retried up to 3 times, then given up on.
* **Replies and unsubscribes** are matched to the recipient (by `In-Reply-To` or sender), so the stats show real reply and unsubscribe rates.
* **Deliverability page:** totals, daily chart, per-mailbox and per-campaign bounce/reply/unsubscribe rates (bounce over 2% turns amber, over 5% red) and a CSV export.
* **DNS check** per mailbox explains what to fix in plain words: missing or duplicate SPF, missing provider include (Hostinger, Brevo, ZeptoMail), `+all`, missing DKIM, missing DMARC, DMARC still on `p=none`.

## Mail (Gmail-style webmail)

*Mail* opens any Hostinger/SMTP mailbox over IMAP (no setup beyond the saved mailbox password). Folders, search, read, **Reply, Reply all, Forward, Compose, Delete (to Trash), Star, mark read/unread, move**, attachments in both directions, and an **All inboxes** combined view. Replies keep the thread and are filed in Sent. Sending needs **Live** mode. HTML mail is shown in a sandbox with scripts and remote images (tracking pixels) blocked.

Each message carries a free offline hint (Customer / sales, Likely junk, Review). *Draft with AI* and *Junk or relevant?* each make one Gemini call, counted against the **daily AI call limit** (default 300, set under API & Webhooks), so the AI cost stays near zero; past the limit the offline classifier takes over. Viewers cannot open Mail.

## Security and team access

* **Users and roles.** Sign in with a username and password. On first start the user `admin` is created from `ADMIN_PASSWORD`. Under *Team & Security* an admin adds people as **admin** (everything), **operator** (campaigns, inbox, agent, do-not-send list, mailbox tests) or **viewer** (read only).
* **2FA.** Each user can turn on authenticator-app codes (with 8 one-time recovery codes). An admin can reset a user's 2FA.
* **Audit log.** Every change (sign-ins, failed attempts, mailbox/settings/campaign/agent/user actions) is recorded with user and IP. Request bodies and secrets are never logged.
* **Secrets at rest.** Set `DATA_ENCRYPTION_KEY` (a long random string) in the environment and mailbox passwords, API keys, Meta tokens and 2FA seeds are stored AES-256-GCM encrypted in `db.json`. Existing plain values are encrypted on the next save. Keep the key somewhere safe: without it the encrypted values cannot be read and the app refuses to start. The key must not be stored in the data folder.
* **Lock-out recovery.** Set `ADMIN_PASSWORD` to a new value and `RESET_ADMIN=true`, restart once, sign in as `admin`, then remove `RESET_ADMIN`.
* Passwords are hashed with scrypt; login attempts are throttled per IP and per user; a CSP and other security headers are sent.

## Deliverability and rules

* Email only people who opted in or are your customers (CAN-SPAM, DPDP, GDPR and every provider's terms forbid unsolicited bulk mail).
* Put your business name and address in the footer; keep the unsubscribe link and set the Public URL so it works in one click.
* Set up SPF, DKIM and DMARC for every sending domain. Start new mailboxes at 20–30/day and raise limits over weeks.
* Provider keys and mailbox passwords are stored in `data/db.json` in plain form. Protect the server and use a strong `ADMIN_PASSWORD`.
