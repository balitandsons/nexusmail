# Host NexusMail on Firebase (Hosting + Cloud Run)

Result: `https://balit-and-sons-technologies.web.app` (and later your own domain), HTTPS included.
Firebase Hosting is the public front door; the app itself runs on Cloud Run (always on, so the sending queue and Inbox Agent keep working),
and your data lives in a Cloud Storage bucket mounted at `/app/data`.

**Cost:** Cloud Run with CPU always allocated (1 vCPU, 512 MB) is roughly **$45-50/month** plus pennies for storage. Requires the **Blaze** plan.
Set a budget alert (Billing > Budgets & alerts, e.g. $60) so nothing surprises you.

## One-time setup (on your PC)
1. Firebase console > your project > **Upgrade** to Blaze (add the billing account).
2. Install the tools, then log in:
   ```powershell
   # Google Cloud CLI: https://cloud.google.com/sdk/docs/install  (reopen PowerShell afterwards)
   npm i -g firebase-tools
   gcloud auth login
   firebase login
   ```
3. Get the code: `git clone https://github.com/balitandsons/nexusmail.git` and open that folder in PowerShell.

## Deploy
```powershell
$env:GEMINI_API_KEY = "your-gemini-key"      # optional but needed for AI replies and the Inbox Agent
.\deploy\firebase\deploy.ps1
```
On Mac/Linux use `GEMINI_API_KEY=... ./deploy/firebase/deploy.sh`. The script enables the needed Google APIs, creates the data bucket, stores your admin
password and Gemini key in Secret Manager, builds and deploys the container, and publishes Firebase Hosting. The first run takes about 5-10 minutes.
It prints the URL at the end; sign in with the admin password you chose, then open **API & Webhooks** (Public URL is already set) and use the webhook URLs in Meta.

If your Firebase project id is different, set it first: `$env:PROJECT = "your-project-id"` (and edit `.firebaserc`).

## Update later
`git pull` and run the same script again. Settings and data are kept in the bucket. To change the admin password: `$env:NEW_ADMIN_PASSWORD = "new"` then run the script.

## Use your own domain
Firebase console > Hosting > **Add custom domain** (e.g. `mail.yourdomain.com`), add the DNS records it shows, wait for the certificate.
Then in NexusMail **API & Webhooks** change Public URL to the new address (it overrides the default) and update your Meta webhook URLs.

## Notes
- The app runs as a single instance on purpose (it keeps its data in JSON files). Do not raise max-instances.
- Login uses a cookie named `__session`, the only cookie Firebase Hosting passes through to Cloud Run.
- Outbound email works on ports 465/587 and via the Brevo/ZeptoMail APIs; port 25 is blocked on Google Cloud.
- Back up data: `gcloud storage cp -r gs://balit-and-sons-technologies-nexusmail-data ./nexusmail-backup`.
- Logs: Cloud Run > nexusmail > Logs. Stop billing: delete the Cloud Run service (`gcloud run services delete nexusmail --region us-central1`).
