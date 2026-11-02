// Builds a ready-to-upload zip for Hostinger: compiled server + built UI + production-only package.json (no build step needed on the host).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const out = 'hostinger-package';
const run = (c) => execSync(c, { stdio: 'inherit' });
run('npx vite build');
run('npm run build:server');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
fs.cpSync('dist', path.join(out, 'dist'), { recursive: true });
fs.cpSync('dist-server', path.join(out, 'dist-server'), { recursive: true });
fs.copyFileSync('app.mjs', path.join(out, 'app.mjs'));
fs.copyFileSync('package-lock.json', path.join(out, 'package-lock.json'));
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const prod = { name: pkg.name, version: pkg.version, private: true, type: 'module', engines: pkg.engines, scripts: { start: 'node app.mjs' }, dependencies: { ...pkg.dependencies } };
delete prod.dependencies.tsx; // server is precompiled, tsx is not needed in production
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify(prod, null, 2));
fs.writeFileSync(path.join(out, '.env.example'), fs.readFileSync('.env.example', 'utf8'));
run(`cd ${out} && npx --yes bestzip ../nexusmail-hostinger.zip . 2>/dev/null || (cd ${out} && zip -qr ../nexusmail-hostinger.zip .)`);
console.log('\nCreated nexusmail-hostinger.zip');
