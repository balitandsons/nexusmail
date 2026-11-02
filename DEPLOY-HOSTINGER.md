# Run NexusMail on Hostinger (Business / Cloud hosting, Node.js Web Apps)

NexusMail runs as a normal Node.js app on your Hostinger plan, on your own domain with HTTPS.
The zip `nexusmail-hostinger.zip` is already compiled, so Hostinger needs no build step.

## 1. Get the zip
Either download it from the chat, or build it yourself:
```powershell
git clone https://github.com/balitandsons/nexusmail.git
cd nexusmail
npm install
npm run package:hostinger      # creates nexusmail-hostinger.zip
```

## 2. Create the app in hPanel
1. hPanel > **Websites > Add website > Node.js Apps** and choose **Upload your website files**. Upload `nexusmail-hostinger.zip`.
   (Menu names differ slightly between plans; look for "Node.js" in the website's sidebar.)
2. Settings: **Node.js version 20 or newer**, **Entry file `app.mjs`**, install command `npm install`, no build command.
3. **Environment variables** (add all of these):

   | Name | Value |
   |---|---|
   | `ADMIN_PASSWORD` | a long password you choose |
   | `TRUST_PROXY` | `1` |
   | `DATA_DIR` | a folder **outside** the app folder so redeploys never erase your data, e.g. `/home/uXXXXXXXX/nexusmail-data` (your home path is shown in hPanel > File Manager) |
   | `APP_TIMEZONE` | `Asia/Kolkata` |
   | `PUBLIC_URL` | `https://your-domain.com` |
   | `GEMINI_API_KEY` | your (new) Gemini key |
   | `GEMINI_MODEL` | `gemini-3.8-flash` |

   Do not set `PORT`; Hostinger provides it.
4. Deploy / Restart the app, open your domain, sign in.

## 3. Move your data from Firebase (optional)
On your PC (gcloud already installed):
```powershell
gcloud storage cp -r gs://balit-and-sons-technologies-nexusmail-data/* ./nexusmail-data
```
Upload the contents of `nexusmail-data` (db.json, recipients, files, secret.key) into the `DATA_DIR` folder with hPanel File Manager, then restart the app.
Keep `secret.key`: it keeps old unsubscribe links valid.

## 4. Stop paying for Firebase
After Hostinger works:
```powershell
gcloud run services delete nexusmail --region us-central1
firebase hosting:disable --project balit-and-sons-technologies
gcloud storage rm -r gs://balit-and-sons-technologies-nexusmail-data
```
Then in the Firebase console set a budget alert so you notice any leftover charge. Update your Meta webhook URLs to the new domain.

## Things to know
- **Keep it awake.** Shared plans may stop an idle Node app, which would pause the sending queue and IMAP checks. Add a free monitor (UptimeRobot, 5-minute interval) that visits `https://your-domain.com/healthz`.
  If sending still stops overnight, a Hostinger **VPS** is the reliable choice; `deploy/gce-startup.sh` / `DEPLOY.md` work there too.
- Outgoing email works through `smtp.hostinger.com` (465) and the Brevo / ZeptoMail APIs.
- Updating: build a new zip, upload it over the old app, restart. Your data in `DATA_DIR` is untouched.
