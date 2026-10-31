# Deploy NexusMail on a free Google Cloud VM

Gives you a permanent `https://<ip>.sslip.io` address with automatic HTTPS and no domain purchase. Cost: $0 on the e2-micro Always Free tier
(1 VM in us-west1, us-central1 or us-east1, 30 GB standard disk). A billing account with a card must be attached to the project.

1. Console > Compute Engine > **Create instance**: machine type **e2-micro**, region **us-central1** (or us-west1 / us-east1),
   boot disk **Ubuntu 24.04 LTS, standard persistent disk, 30 GB**, firewall: tick **Allow HTTP traffic** and **Allow HTTPS traffic**.
2. Expand **Advanced options > Management**. Under **Metadata** add:
   * `admin-password` = a long password (required)
   * `gemini-key` = your Gemini API key (optional)
   * `github-token` = only needed if this repo is private: a fine-grained token with read-only *Contents* access to it
3. In the **Automation > Startup script** box paste the whole of `deploy/gce-startup.sh`, then **Create**.
4. Wait ~5 minutes. Watch progress with SSH: `sudo tail -f /var/log/nexusmail-setup.log`. It ends with the URL.
5. VPC network > IP addresses: **Reserve** the VM's external address as static, so the URL never changes (free while attached to a running VM).
6. Open the URL, sign in, switch to **Live**. Use the webhook URLs from **API & Webhooks** in your Meta app.

Update later: SSH in and run `sudo google_metadata_script_runner startup` (pulls the latest code, rebuilds, restarts).
Back up `/opt/nexusmail/data` (mailbox credentials and campaigns). Google Cloud blocks outbound port 25; Hostinger on 465/587, Brevo and ZeptoMail (API) are fine.

---

# Deploy NexusMail

Run locally: see README.md. To host it, use any VPS with a persistent disk (hosts with temporary disks erase `data/` on restart).

## VPS (Ubuntu)

1. Install Node 20 and tools:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs git caddy
sudo npm i -g pm2
```
2. Get the code and build:
```bash
git clone -b nexusmail https://github.com/balitandsons/ADMIN_PANNEL_VSCODE.git /opt/nexusmail
cd /opt/nexusmail && cp .env.example .env
nano .env    # set ADMIN_PASSWORD (long), TRUST_PROXY=1, GEMINI_API_KEY
npm ci && npm run build
```
3. Start it and keep it running across reboots:
```bash
pm2 start "npx tsx server/index.ts" --name nexusmail && pm2 save && pm2 startup
```
4. Point a DNS A record (e.g. `mail.yourdomain.com`) at the VPS, then enable HTTPS:
```bash
echo 'mail.yourdomain.com {
  reverse_proxy 127.0.0.1:3000
}' | sudo tee /etc/caddy/Caddyfile && sudo systemctl reload caddy
```
5. Open https://mail.yourdomain.com, sign in, switch to **Live**, and under **API & Webhooks** set Public URL to that address.
   Use the webhook URLs shown there in your Meta app.

Back up `nexusmail/data/` (it holds mailbox credentials and campaigns). Docker alternative:
`docker build -t nexusmail . && docker run -d -p 3000:3000 -v nexusmail-data:/app/data --env-file .env nexusmail`
