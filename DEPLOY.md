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
