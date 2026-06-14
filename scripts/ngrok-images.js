#!/usr/bin/env node
// Launch an ngrok tunnel to the local image server used by publish_thread_local_image.
//
// Port resolution (highest precedence first), mirroring src/index.ts:
//   1. LOCAL_IMAGE_SERVER_PORT environment variable
//   2. LOCAL_IMAGE_SERVER_PORT in the project .env file
//   3. Default 51847 (matches LOCAL_FILE_SERVER_DEFAULT_PORT)
//
// Static domain (optional): set NGROK_URL=your-static-domain.ngrok-free.dev in .env
// or as an environment variable to pass --url=<domain> to ngrok.
//
// The tunnel always forwards to 127.0.0.1 (IPv4). Forwarding to "localhost"
// can resolve to IPv6 (::1) on some systems, which fails with connection
// refused because the local file server binds to 127.0.0.1 only.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 51847;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = resolve(PROJECT_ROOT, '.env');

function readEnvFile() {
  if (!existsSync(ENV_FILE)) return {};
  const lines = readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  const vars = {};
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$/);
    if (m) vars[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return vars;
}

function resolvePort(envVars) {
  // 1. Shell environment variable.
  const envVar = process.env.LOCAL_IMAGE_SERVER_PORT;
  if (envVar) return { port: Number(envVar), source: 'env var' };

  // 2. .env file.
  if (envVars.LOCAL_IMAGE_SERVER_PORT) {
    const num = Number(envVars.LOCAL_IMAGE_SERVER_PORT);
    if (!Number.isNaN(num)) return { port: num, source: '.env' };
  }

  // 3. Default.
  return { port: DEFAULT_PORT, source: 'default' };
}

function resolveNgrokUrl(envVars) {
  // Shell env var takes precedence over .env file.
  const val = process.env.NGROK_URL ?? envVars.NGROK_URL ?? '';
  // Strip protocol prefix and trailing slash if user accidentally included them.
  return val.replace(/^https?:\/\//i, '').replace(/\/$/, '').trim() || null;
}

const envVars = readEnvFile();
const { port, source } = resolvePort(envVars);
const ngrokUrl = resolveNgrokUrl(envVars);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write(`ngrok-images: resolved port '${port}' is invalid; using default ${DEFAULT_PORT}\n`);
}
const finalPort = (Number.isInteger(port) && port >= 1 && port <= 65535) ? port : DEFAULT_PORT;

// Verify ngrok is installed.
try {
  execFileSync('ngrok', ['version'], { stdio: 'ignore' });
} catch {
  process.stderr.write("ngrok-images: 'ngrok' not found in PATH. Install it first (see SETUP.md).\n");
  process.exit(127);
}

const addr = `127.0.0.1:${finalPort}`;
const args = ngrokUrl
  ? ['http', `--url=${ngrokUrl}`, addr]
  : ['http', addr];

process.stderr.write(
  `ngrok-images: forwarding ngrok${ngrokUrl ? ` (${ngrokUrl})` : ''} -> http://${addr} (port from ${source})\n`,
);

const result = spawnSync('ngrok', args, { stdio: 'inherit' });
process.exit(result.status ?? 0);
