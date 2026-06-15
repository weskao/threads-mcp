#!/usr/bin/env node
/**
 * Cross-platform autostart installer for the resident Threads MCP HTTP server.
 *
 * Registers `node dist/index.js --http` as a per-user background service that
 * starts on login and restarts on crash, so a single resident process serves
 * every IDE/Claude client over Streamable HTTP (instead of each client spawning
 * its own stdio child).
 *
 *   macOS    → launchd user agent   (~/Library/LaunchAgents/com.threads-mcp.server.plist)
 *   Linux    → systemd user service (~/.config/systemd/user/threads-mcp.service)
 *   Windows  → Task Scheduler logon task (ThreadsMcpServer)
 *
 * Token resolution mirrors the stdio setup: the launch command tries the system
 * keychain first (macOS Keychain / Linux Secret Service / Windows PasswordVault)
 * and falls back to the project's .env (loaded by dotenv from the working dir).
 *
 * Usage:
 *   node scripts/install-autostart.js [--port 8307] [--host 127.0.0.1]
 *   node scripts/install-autostart.js --uninstall
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const entry = path.join(projectRoot, 'dist', 'index.js');
const refreshScript = path.join(projectRoot, 'scripts', 'refresh_threads_token.js');
const nodeBin = process.execPath; // absolute node path — robust across platforms
const logDir = path.join(projectRoot, 'logs');
// macOS launchd agents run in a restricted TCC context that blocks access to
// ~/Documents. Use ~/Library/Logs/ (always accessible to user launchd agents)
// for the plist log paths, and os.homedir() as the working directory.
const macLogDir = path.join(os.homedir(), 'Library', 'Logs', 'threads-mcp');

const LABEL = 'com.threads-mcp.server'; // macOS launchd label
const UNIT = 'threads-mcp.service'; // Linux systemd unit name
const TASK = 'ThreadsMcpServer'; // Windows scheduled-task name

// Belt-and-suspenders token refresher: a scheduled job that renews the Threads
// long-lived token even if the resident server is down for an extended period
// (its own in-process timer is the primary mechanism). Runs weekly + at load.
const LABEL_REFRESH = 'com.threads-mcp.token-refresh'; // macOS launchd label
const UNIT_REFRESH = 'threads-mcp-token-refresh'; // Linux systemd unit/timer base name
const TASK_REFRESH = 'ThreadsMcpTokenRefresh'; // Windows scheduled-task name

// Optional ngrok tunnel: keeps a persistent tunnel open so publish_thread_local_image
// works without manually starting ngrok before each use.
const LABEL_NGROK = 'com.threads-mcp.ngrok'; // macOS launchd label
const UNIT_NGROK = 'threads-mcp-ngrok';       // Linux systemd unit name
const TASK_NGROK = 'ThreadsMcpNgrok';         // Windows scheduled-task name

// --- args ---------------------------------------------------------------------
const args = process.argv.slice(2);
const argVal = (name, def) => {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const uninstall = args.includes('--uninstall');
const statusMode = args.includes('--status');
const startMode = args.includes('--start');
const stopMode = args.includes('--stop');
const ngrokOnly = args.includes('--ngrok-only');
const port = argVal('--port', process.env.MCP_HTTP_PORT || '8307');
const host = argVal('--host', process.env.MCP_HTTP_HOST || '127.0.0.1');

function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { stdio: 'inherit', ...opts });
}
function runQuiet(cmd, cmdArgs) {
  try {
    execFileSync(cmd, cmdArgs, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
/** Run a command, return { ok, output }. Never throws. */
function runCapture(cmd, cmdArgs) {
  try {
    const output = execFileSync(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return { ok: true, output };
  } catch (err) {
    const output =
      (err.stdout ? err.stdout.toString() : '') + (err.stderr ? err.stderr.toString() : '');
    return { ok: false, output };
  }
}
/** Probe whether a TCP port is listening. Returns a Promise<boolean>. */
function isPortListening(portNum) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    const s = net.createConnection({ host: '127.0.0.1', port: portNum });
    s.on('connect', () => finish(true));
    s.on('error', () => finish(false));
    s.setTimeout(1000, () => finish(false));
  });
}

function ensureBuilt() {
  if (!fs.existsSync(entry)) {
    console.error(`✖ 找不到 ${entry}\n  請先建置： npm run build`);
    process.exit(1);
  }
  fs.mkdirSync(logDir, { recursive: true });
}

function printRegisterHint() {
  const url = `http://${host}:${port}/mcp`;
  console.log('\n────────────────────────────────────────────────────────');
  console.log('🔗 最後一步：把這個常駐 server 登記給 Claude Code（擇一）');
  console.log('');
  console.log('  A) 用 CLI（推薦，不必手改設定檔）：');
  console.log(`     claude mcp add --transport http --scope user threads ${url}`);
  console.log('');
  console.log('  B) 手動編輯 ~/.claude.json 的 "mcpServers"：');
  console.log(
    JSON.stringify({ threads: { type: 'http', url } }, null, 2)
      .split('\n')
      .map((l) => '       ' + l)
      .join('\n')
  );
  console.log('');
  console.log('  ⚠️ 若該專案在 ~/.claude.json 的 projects.<path>.mcpServers 仍有');
  console.log('     stdio 版 threads 設定，會 shadow 掉全域 HTTP 設定 — 請一併移除。');
  console.log('────────────────────────────────────────────────────────');
}

// ============================== macOS (launchd) ===============================
function macPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}
function macLaunchCommand() {
  // Resolve the token from Keychain; only export it when non-empty so the .env
  // fallback (via dotenv) still works when Keychain has nothing.
  return (
    'TOK=$(security find-generic-password -a "$USER" -s "threads-access-token" -w 2>/dev/null); ' +
    '[ -n "$TOK" ] && export THREADS_ACCESS_TOKEN="$TOK"; ' +
    `exec "${nodeBin}" "${entry}" --http --port ${port} --host ${host}`
  );
}
function macInstall() {
  ensureBuilt();
  fs.mkdirSync(macLogDir, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${macLaunchCommand().replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${os.homedir()}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(macLogDir, 'autostart.out.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(macLogDir, 'autostart.err.log')}</string>
</dict>
</plist>
`;
  const plistPath = macPlistPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist, 'utf8');
  const uid = process.getuid();
  runQuiet('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
  run('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
  runQuiet('launchctl', ['enable', `gui/${uid}/${LABEL}`]);
  runQuiet('launchctl', ['kickstart', '-k', `gui/${uid}/${LABEL}`]);
  console.log(`✓ 已安裝 launchd agent：${plistPath}`);
  console.log(`  伺服器： http://${host}:${port}/mcp  (開機自動啟動、崩潰自動重啟)`);
  macInstallRefresh();
}
function macUninstall() {
  const plistPath = macPlistPath();
  const uid = process.getuid();
  runQuiet('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
  if (fs.existsSync(plistPath)) fs.rmSync(plistPath);
  console.log(`✓ 已移除 launchd agent：${plistPath}`);
  macUninstallRefresh();
  macUninstallNgrok();
}

// ---- macOS: ngrok tunnel autostart ----
function macNgrokPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL_NGROK}.plist`);
}
function macNgrokCommand() {
  // Set an expanded PATH so launchd's restricted env can find ngrok (Homebrew ARM/Intel, MacPorts).
  const expandedPath =
    '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  return (
    `export PATH="${expandedPath}"; ` +
    `exec "${nodeBin}" "${path.join(projectRoot, 'scripts', 'ngrok-images.js')}"`
  );
}
function macInstallNgrok() {
  fs.mkdirSync(macLogDir, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL_NGROK}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${macNgrokCommand().replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${projectRoot}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(macLogDir, 'ngrok.out.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(macLogDir, 'ngrok.err.log')}</string>
</dict>
</plist>
`;
  const plistPath = macNgrokPlistPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist, 'utf8');
  const uid = process.getuid();
  runQuiet('launchctl', ['bootout', `gui/${uid}/${LABEL_NGROK}`]);
  run('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
  runQuiet('launchctl', ['enable', `gui/${uid}/${LABEL_NGROK}`]);
  runQuiet('launchctl', ['kickstart', '-k', `gui/${uid}/${LABEL_NGROK}`]);
  console.log(`✓ 已安裝 ngrok tunnel 自動啟動：${plistPath}`);
  console.log('  ngrok 將在登入後自動啟動，publish_thread_local_image 可直接使用（無需手動啟動）');
}
function macUninstallNgrok() {
  const plistPath = macNgrokPlistPath();
  const uid = process.getuid();
  runQuiet('launchctl', ['bootout', `gui/${uid}/${LABEL_NGROK}`]);
  if (fs.existsSync(plistPath)) {
    fs.rmSync(plistPath);
    console.log(`✓ 已移除 ngrok tunnel 自動啟動：${plistPath}`);
  }
}
function macRefreshPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL_REFRESH}.plist`);
}
function macInstallRefresh() {
  // Weekly (Sunday 04:00) + RunAtLoad so a missed schedule catches up at next login.
  fs.mkdirSync(macLogDir, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL_REFRESH}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${refreshScript}</string>
    <string>--quiet</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${os.homedir()}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>0</integer>
    <key>Hour</key><integer>4</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${path.join(macLogDir, 'token-refresh.out.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(macLogDir, 'token-refresh.err.log')}</string>
</dict>
</plist>
`;
  const plistPath = macRefreshPlistPath();
  fs.writeFileSync(plistPath, plist, 'utf8');
  const uid = process.getuid();
  runQuiet('launchctl', ['bootout', `gui/${uid}/${LABEL_REFRESH}`]);
  run('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
  runQuiet('launchctl', ['enable', `gui/${uid}/${LABEL_REFRESH}`]);
  console.log(`✓ 已安裝 token 續期排程：${plistPath}  (每週 + 開機時)`);
}
function macUninstallRefresh() {
  const plistPath = macRefreshPlistPath();
  const uid = process.getuid();
  runQuiet('launchctl', ['bootout', `gui/${uid}/${LABEL_REFRESH}`]);
  if (fs.existsSync(plistPath)) fs.rmSync(plistPath);
  console.log(`✓ 已移除 token 續期排程：${plistPath}`);
}

// ---- macOS: service control (status/start/stop) ----
async function macStatus() {
  const uid = process.getuid();
  const { ok, output } = runCapture('launchctl', ['print', `gui/${uid}/${LABEL}`]);
  if (ok) {
    console.log(output.trimEnd());
  } else {
    // Fallback: check whether the label appears in the list at all
    const list = runCapture('launchctl', ['list']);
    const inList = list.output.includes(LABEL);
    if (inList) {
      console.log(`service ${LABEL}: registered but not running (launchctl print failed)`);
    } else {
      console.log(`service ${LABEL}: not loaded (plist may not be installed)`);
    }
  }
  const portNum = parseInt(port, 10);
  const listening = await isPortListening(portNum);
  console.log(`port ${portNum}: ${listening ? 'LISTENING' : 'not listening'}`);
}
function macStart() {
  const uid = process.getuid();
  const plistPath = macPlistPath();
  if (!fs.existsSync(plistPath)) {
    console.error(`✖ Plist not found: ${plistPath}\n  Run without --start to install first.`);
    process.exit(1);
  }
  // Try bootstrap; if already bootstrapped, fall back to kickstart -k
  const bootstrapped = runQuiet('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
  if (!bootstrapped) {
    run('launchctl', ['kickstart', '-k', `gui/${uid}/${LABEL}`]);
  }
  console.log(`✓ Started ${LABEL}`);
}
function macStop() {
  const uid = process.getuid();
  const ok = runQuiet('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
  if (!ok) {
    console.error(`✖ Failed to stop ${LABEL} — is it loaded?`);
    process.exit(1);
  }
  console.log(`✓ Stopped ${LABEL}`);
}

// ============================== Linux (systemd) ===============================
function linuxUnitPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', UNIT);
}
function linuxExecStart() {
  return (
    "/bin/sh -c 'TOK=$(secret-tool lookup application threads-mcp service threads-access-token 2>/dev/null); " +
    '[ -n "$TOK" ] && export THREADS_ACCESS_TOKEN="$TOK"; ' +
    `exec "${nodeBin}" "${entry}" --http --port ${port} --host ${host}'`
  );
}
function linuxInstall() {
  ensureBuilt();
  const unit = `[Unit]
Description=Threads MCP resident HTTP server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${projectRoot}
ExecStart=${linuxExecStart()}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
  const unitPath = linuxUnitPath();
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, unit, 'utf8');
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', UNIT]);
  console.log(`✓ 已安裝 systemd user service：${unitPath}`);
  console.log(`  伺服器： http://${host}:${port}/mcp`);
  console.log('  💡 若希望未登入時也常駐，執行： sudo loginctl enable-linger "$USER"');
  console.log('  📜 查看日誌： journalctl --user -u threads-mcp -f');
  linuxInstallRefresh();
}
function linuxUninstall() {
  const unitPath = linuxUnitPath();
  runQuiet('systemctl', ['--user', 'disable', '--now', UNIT]);
  if (fs.existsSync(unitPath)) fs.rmSync(unitPath);
  runQuiet('systemctl', ['--user', 'daemon-reload']);
  console.log(`✓ 已移除 systemd user service：${unitPath}`);
  linuxUninstallRefresh();
  linuxUninstallNgrok();
}
function linuxRefreshDir() {
  return path.join(os.homedir(), '.config', 'systemd', 'user');
}
function linuxInstallRefresh() {
  // oneshot service + weekly timer (Persistent=true catches up missed runs).
  const dir = linuxRefreshDir();
  fs.mkdirSync(dir, { recursive: true });
  const service = `[Unit]
Description=Threads MCP token refresh (renew long-lived token)

[Service]
Type=oneshot
WorkingDirectory=${projectRoot}
ExecStart="${nodeBin}" "${refreshScript}" --quiet
`;
  const timer = `[Unit]
Description=Weekly Threads MCP token refresh

[Timer]
OnCalendar=weekly
Persistent=true

[Install]
WantedBy=timers.target
`;
  fs.writeFileSync(path.join(dir, `${UNIT_REFRESH}.service`), service, 'utf8');
  fs.writeFileSync(path.join(dir, `${UNIT_REFRESH}.timer`), timer, 'utf8');
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', `${UNIT_REFRESH}.timer`]);
  console.log(`✓ 已安裝 token 續期排程：${UNIT_REFRESH}.timer  (每週)`);
}
function linuxUninstallRefresh() {
  const dir = linuxRefreshDir();
  runQuiet('systemctl', ['--user', 'disable', '--now', `${UNIT_REFRESH}.timer`]);
  for (const f of [`${UNIT_REFRESH}.timer`, `${UNIT_REFRESH}.service`]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  runQuiet('systemctl', ['--user', 'daemon-reload']);
  console.log(`✓ 已移除 token 續期排程：${UNIT_REFRESH}.timer`);
}

// ---- Linux: ngrok tunnel autostart ----
function linuxNgrokUnitPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', `${UNIT_NGROK}.service`);
}
function linuxInstallNgrok() {
  const ngrokImagesScript = path.join(projectRoot, 'scripts', 'ngrok-images.js');
  const unit = `[Unit]
Description=ngrok tunnel for Threads MCP local image server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${projectRoot}
ExecStart=/bin/sh -c 'export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"; exec "${nodeBin}" "${ngrokImagesScript}"'
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
  const unitPath = linuxNgrokUnitPath();
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, unit, 'utf8');
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', `${UNIT_NGROK}.service`]);
  console.log(`✓ 已安裝 ngrok tunnel systemd service：${unitPath}`);
  console.log('  ngrok 將在登入後自動啟動，publish_thread_local_image 可直接使用');
}
function linuxUninstallNgrok() {
  const unitPath = linuxNgrokUnitPath();
  runQuiet('systemctl', ['--user', 'disable', '--now', `${UNIT_NGROK}.service`]);
  if (fs.existsSync(unitPath)) {
    fs.rmSync(unitPath);
    runQuiet('systemctl', ['--user', 'daemon-reload']);
    console.log(`✓ 已移除 ngrok tunnel systemd service：${unitPath}`);
  }
}

// ---- Linux: service control (status/start/stop) ----
function linuxStatus() {
  // systemctl status exits non-zero when inactive — capture and print regardless
  const { output } = runCapture('systemctl', ['--user', 'status', UNIT]);
  console.log(output.trimEnd() || `service ${UNIT}: (no output from systemctl)`);
}
function linuxStart() {
  try {
    run('systemctl', ['--user', 'start', UNIT]);
    console.log(`✓ Started ${UNIT}`);
  } catch (err) {
    console.error(`✖ Failed to start ${UNIT}: ${err.message}`);
    process.exit(1);
  }
}
function linuxStop() {
  try {
    run('systemctl', ['--user', 'stop', UNIT]);
    console.log(`✓ Stopped ${UNIT}`);
  } catch (err) {
    console.error(`✖ Failed to stop ${UNIT}: ${err.message}`);
    process.exit(1);
  }
}

// ============================== Windows (Task Scheduler) ======================
function windowsActionCommand() {
  // Single-quote-safe PowerShell: try PasswordVault, then run node with HTTP flags
  // from the project directory so dotenv can read .env as a fallback.
  return (
    "try { $env:THREADS_ACCESS_TOKEN = ((New-Object Windows.Security.Credentials.PasswordVault)." +
    "Retrieve('threads-mcp','threads-access-token')).Password } catch {}; " +
    `Set-Location '${projectRoot.replace(/'/g, "''")}'; ` +
    `& '${nodeBin.replace(/'/g, "''")}' '${entry.replace(/'/g, "''")}' --http --port ${port} --host ${host}`
  );
}
function windowsInstall() {
  ensureBuilt();
  const inner = windowsActionCommand().replace(/'/g, "''"); // escape for the outer -Command string
  const ps = [
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -Command "& {${inner}}"'`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn`,
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)`,
    `Register-ScheduledTask -TaskName '${TASK}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
    `Start-ScheduledTask -TaskName '${TASK}'`,
  ].join('; ');
  run('powershell', ['-NoProfile', '-Command', ps]);
  console.log(`✓ 已註冊 Windows 排程工作：${TASK} (登入時自動啟動)`);
  console.log(`  伺服器： http://${host}:${port}/mcp`);
  windowsInstallRefresh();
}
function windowsUninstall() {
  runQuiet('powershell', [
    '-NoProfile',
    '-Command',
    `Stop-ScheduledTask -TaskName '${TASK}' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${TASK}' -Confirm:$false -ErrorAction SilentlyContinue`,
  ]);
  console.log(`✓ 已移除 Windows 排程工作：${TASK}`);
  windowsUninstallRefresh();
  windowsUninstallNgrok();
}
function windowsInstallRefresh() {
  // Weekly trigger; node runs the refresh script directly (keychain read is internal).
  const inner = `& '${nodeBin.replace(/'/g, "''")}' '${refreshScript.replace(/'/g, "''")}' --quiet`.replace(/'/g, "''");
  const ps = [
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -Command "& {${inner}}"' -WorkingDirectory '${projectRoot.replace(/'/g, "''")}'`,
    `$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 4am`,
    `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`,
    `Register-ScheduledTask -TaskName '${TASK_REFRESH}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
  ].join('; ');
  run('powershell', ['-NoProfile', '-Command', ps]);
  console.log(`✓ 已註冊 token 續期排程：${TASK_REFRESH} (每週)`);
}
function windowsUninstallRefresh() {
  runQuiet('powershell', [
    '-NoProfile',
    '-Command',
    `Stop-ScheduledTask -TaskName '${TASK_REFRESH}' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${TASK_REFRESH}' -Confirm:$false -ErrorAction SilentlyContinue`,
  ]);
  console.log(`✓ 已移除 token 續期排程：${TASK_REFRESH}`);
}

// ---- Windows: ngrok tunnel autostart ----
function windowsInstallNgrok() {
  const ngrokImagesScript = path.join(projectRoot, 'scripts', 'ngrok-images.js');
  const inner = (
    `Set-Location '${projectRoot.replace(/'/g, "''")}'; ` +
    `& '${nodeBin.replace(/'/g, "''")}' '${ngrokImagesScript.replace(/'/g, "''")}'`
  ).replace(/'/g, "''");
  const ps = [
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -Command "& {${inner}}"' -WorkingDirectory '${projectRoot.replace(/'/g, "''")}'`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn`,
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)`,
    `Register-ScheduledTask -TaskName '${TASK_NGROK}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
    `Start-ScheduledTask -TaskName '${TASK_NGROK}'`,
  ].join('; ');
  run('powershell', ['-NoProfile', '-Command', ps]);
  console.log(`✓ 已註冊 Windows 排程工作：${TASK_NGROK} (登入時自動啟動)`);
  console.log('  ngrok 將在登入後自動啟動，publish_thread_local_image 可直接使用');
}
function windowsUninstallNgrok() {
  const { ok } = runCapture('schtasks', ['/Query', '/TN', TASK_NGROK]);
  if (!ok) return;
  runQuiet('powershell', [
    '-NoProfile',
    '-Command',
    `Stop-ScheduledTask -TaskName '${TASK_NGROK}' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${TASK_NGROK}' -Confirm:$false -ErrorAction SilentlyContinue`,
  ]);
  console.log(`✓ 已移除 ngrok tunnel 排程工作：${TASK_NGROK}`);
}

// ---- Windows: service control (status/start/stop) ----
function windowsStatus() {
  const { ok, output } = runCapture('schtasks', ['/Query', '/TN', TASK, '/FO', 'LIST', '/V']);
  if (ok) {
    console.log(output.trimEnd());
  } else if (output.includes('cannot find')) {
    console.log(`task ${TASK}: not found (not installed)`);
  } else {
    console.log(output.trimEnd() || `task ${TASK}: query returned no output`);
  }
}
function windowsStart() {
  try {
    run('schtasks', ['/Run', '/TN', TASK]);
    console.log(`✓ Started scheduled task ${TASK}`);
  } catch (err) {
    console.error(`✖ Failed to start ${TASK}: ${err.message}`);
    process.exit(1);
  }
}
function windowsStop() {
  try {
    run('schtasks', ['/End', '/TN', TASK]);
    console.log(`✓ Stopped scheduled task ${TASK}`);
  } catch (err) {
    console.error(`✖ Failed to stop ${TASK}: ${err.message}`);
    process.exit(1);
  }
}

// ============================== dispatch ======================================
async function main() {
  const plat = process.platform;
  try {
    if (uninstall) {
      if (ngrokOnly) {
        if (plat === 'darwin') macUninstallNgrok();
        else if (plat === 'linux') linuxUninstallNgrok();
        else if (plat === 'win32') windowsUninstallNgrok();
        else throw new Error(`不支援的平台：${plat}`);
      } else {
        if (plat === 'darwin') macUninstall();
        else if (plat === 'linux') linuxUninstall();
        else if (plat === 'win32') windowsUninstall();
        else throw new Error(`不支援的平台：${plat}`);
      }
      return;
    }
    if (statusMode) {
      if (plat === 'darwin') await macStatus();
      else if (plat === 'linux') linuxStatus();
      else if (plat === 'win32') windowsStatus();
      else throw new Error(`不支援的平台：${plat}`);
      return;
    }
    if (startMode) {
      if (plat === 'darwin') macStart();
      else if (plat === 'linux') linuxStart();
      else if (plat === 'win32') windowsStart();
      else throw new Error(`不支援的平台：${plat}`);
      return;
    }
    if (stopMode) {
      if (plat === 'darwin') macStop();
      else if (plat === 'linux') linuxStop();
      else if (plat === 'win32') windowsStop();
      else throw new Error(`不支援的平台：${plat}`);
      return;
    }
    if (ngrokOnly) {
      if (plat === 'darwin') macInstallNgrok();
      else if (plat === 'linux') linuxInstallNgrok();
      else if (plat === 'win32') windowsInstallNgrok();
      else throw new Error(`不支援的平台：${plat}`);
      return;
    }
    if (plat === 'darwin') macInstall();
    else if (plat === 'linux') linuxInstall();
    else if (plat === 'win32') windowsInstall();
    else throw new Error(`不支援的平台：${plat}（請手動以 --http 啟動 dist/index.js）`);
    printRegisterHint();
  } catch (err) {
    console.error(`✖ 安裝失敗：${err.message}`);
    process.exit(1);
  }
}

main();
