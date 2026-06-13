import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import os from 'os';
import dotenv from 'dotenv';
import { getCredential, isKeychainSupported } from './keychain.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (q) => new Promise(resolve => rl.question(q, resolve));

function resolveEnvValue(val) {
  if (!val) return '';
  val = val.trim();
  if (val.startsWith('$(') && val.endsWith(')')) {
    const cmd = val.slice(2, -1);
    try {
      return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    } catch (e) { return ''; }
  }
  return val;
}

function getClaudeDesktopConfigPath() {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'win32':
      return path.join(process.env.APPDATA || os.homedir(), 'Claude', 'claude_desktop_config.json');
    default:
      return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
  }
}

function buildMcpEntry(distPath, useKeychain) {
  if (useKeychain) {
    const safePath = distPath.replace(/\\/g, '/');
    if (process.platform === 'darwin') {
      return {
        command: 'sh',
        args: [
          '-c',
          `THREADS_ACCESS_TOKEN=$(security find-generic-password -a "$USER" -s "threads-access-token" -w 2>/dev/null) node "${safePath}" --stdio`
        ]
      };
    } else if (process.platform === 'win32') {
      return {
        command: 'powershell',
        args: [
          '-Command',
          `$env:THREADS_ACCESS_TOKEN=((New-Object Windows.Security.Credentials.PasswordVault).Retrieve('threads-mcp', 'threads-access-token')).Password; node "${safePath}" --stdio`
        ]
      };
    } else if (process.platform === 'linux') {
      return {
        command: 'sh',
        args: [
          '-c',
          `THREADS_ACCESS_TOKEN=$(secret-tool lookup application threads-mcp service threads-access-token 2>/dev/null) node "${safePath}" --stdio`
        ]
      };
    }
  }
  return null; // caller must pass token separately for the env form
}

async function setupClaudeDesktop(mcpEntry) {
  const configPath = getClaudeDesktopConfigPath();
  const configDir = path.dirname(configPath);

  let config = { mcpServers: {} };
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.error(`❌ 無法解析現有的 Claude Desktop 設定檔: ${configPath}`);
      console.error('   請手動確認 JSON 格式是否正確。');
      return false;
    }
  } else {
    fs.mkdirSync(configDir, { recursive: true });
    console.log(`📁 已建立設定目錄: ${configDir}`);
  }

  if (!config.mcpServers) config.mcpServers = {};

  if (config.mcpServers.threads) {
    const overwrite = (await question('⚠️  Claude Desktop 設定中已有 "threads"，是否覆蓋？(y/n): ')).trim().toLowerCase();
    if (overwrite !== 'y' && overwrite !== 'yes') {
      console.log('已略過 Claude Desktop 設定。');
      return false;
    }
  }

  config.mcpServers.threads = mcpEntry;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  console.log(`✅ 已寫入 Claude Desktop 設定：${configPath}`);
  console.log('   請完全重新啟動 Claude Desktop 以套用設定。');
  return true;
}

function buildClaudeMcpAddArgs(scope, distPath, token, useKeychain) {
  if (useKeychain) {
    const safePath = distPath.replace(/\\/g, '/');
    if (process.platform === 'darwin') {
      return [
        'mcp', 'add', '-s', scope,
        'threads', '--',
        'sh', '-c',
        `THREADS_ACCESS_TOKEN=$(security find-generic-password -a "$USER" -s "threads-access-token" -w 2>/dev/null) node "${safePath}" --stdio`
      ];
    } else if (process.platform === 'win32') {
      return [
        'mcp', 'add', '-s', scope,
        'threads', '--',
        'powershell', '-Command',
        `$env:THREADS_ACCESS_TOKEN=((New-Object Windows.Security.Credentials.PasswordVault).Retrieve('threads-mcp', 'threads-access-token')).Password; node "${safePath}" --stdio`
      ];
    } else if (process.platform === 'linux') {
      return [
        'mcp', 'add', '-s', scope,
        'threads', '--',
        'sh', '-c',
        `THREADS_ACCESS_TOKEN=$(secret-tool lookup application threads-mcp service threads-access-token 2>/dev/null) node "${safePath}" --stdio`
      ];
    }
  }
  return [
    'mcp', 'add', '-s', scope,
    '-e', `THREADS_ACCESS_TOKEN=${token}`,
    'threads', '--',
    'node', distPath, '--stdio'
  ];
}

async function setupClaudeCode(distPath, token, useKeychain) {
  console.log('\n--- Claude Code 設定 ---');

  console.log('請選擇設定範圍：');
  console.log('  1. 使用者層級 (user)   — 全域，所有專案皆可用');
  console.log('  2. 專案層級 (project)  — 僅限此專案');
  const scopeChoice = (await question('請輸入選項 (1/2): ')).trim();
  const scope = scopeChoice === '2' ? 'project' : 'user';

  const addArgs = buildClaudeMcpAddArgs(scope, distPath, token, useKeychain);

  const tryAdd = () => execFileSync('claude', addArgs, { stdio: 'inherit' });
  const tryRemove = () => execFileSync('claude', ['mcp', 'remove', '-s', scope, 'threads'], { stdio: 'inherit' });

  try {
    tryAdd();
    console.log(`\n✅ 已成功設定 Claude Code (${scope} 範圍)。`);
    console.log(scope === 'user'
      ? '   重啟 Claude Code 後即可在所有專案使用 Threads MCP。'
      : '   在此專案目錄下啟動 Claude Code 即可自動載入 Threads MCP。');
  } catch (e) {
    const overwrite = (await question('\n⚠️  設定失敗（可能已存在），是否先移除再重新新增？(y/n): ')).trim().toLowerCase();
    if (overwrite === 'y' || overwrite === 'yes') {
      try {
        tryRemove();
        tryAdd();
        console.log(`\n✅ 已成功更新 Claude Code 設定 (${scope} 範圍)。`);
      } catch (e2) {
        console.error('❌ 設定失敗：', e2.message);
        console.error('   請確認 claude CLI 已安裝並在 PATH 中（執行 claude --version 確認）。');
      }
    } else {
      console.log('已略過 Claude Code 設定。');
    }
  }
}

async function main() {
  console.log('=== Threads MCP Server — 掛載至 MCP 用戶端 ===\n');

  // 1. Ensure dist exists
  const distPath = path.join(projectRoot, 'dist', 'index.js');
  if (!fs.existsSync(distPath)) {
    console.log('⚠️  dist/index.js 不存在，正在執行 npm run build...');
    try {
      execSync('npm run build', { stdio: 'inherit', cwd: projectRoot });
      console.log('✅ 編譯完成。\n');
    } catch (e) {
      console.error('❌ 編譯失敗，請手動執行 npm run build 後再重試。');
      rl.close();
      process.exit(1);
    }
  }

  // 2. Resolve token
  let token = '';
  let useKeychain = false;

  if (isKeychainSupported()) {
    const result = getCredential('threads-access-token');
    if (result) {
      token = result;
      useKeychain = true;
      let storageName = '系統安全儲存區';
      if (process.platform === 'darwin') storageName = 'macOS Keychain';
      else if (process.platform === 'win32') storageName = 'Windows PasswordVault';
      else if (process.platform === 'linux') storageName = 'Linux Secret Service';
      
      console.log(`🔑 偵測到 ${storageName} 中的 threads-access-token。`);
      console.log('   將使用動態載入形式，Token 從系統金鑰庫讀取，不寫入設定檔。\n');
    }
  }

  if (!useKeychain) {
    token = resolveEnvValue(process.env.THREADS_ACCESS_TOKEN);
    if (!token) {
      console.error('❌ 找不到 THREADS_ACCESS_TOKEN。');
      console.error('   請先執行 npm run get-token 或 npm run exchange-token 取得 Token。');
      rl.close();
      process.exit(1);
    }
    console.log('🔑 已從 .env 取得 THREADS_ACCESS_TOKEN。\n');
  }

  // 3. Build MCP entry (for Claude Desktop only)
  let mcpEntry;
  if (useKeychain) {
    mcpEntry = buildMcpEntry(distPath, true);
  } else {
    mcpEntry = {
      command: 'node',
      args: [distPath, '--stdio'],
      env: { THREADS_ACCESS_TOKEN: token }
    };
  }

  // 4. Choose target
  console.log('請選擇要設定的 MCP 用戶端：');
  console.log('  1. Claude Desktop');
  console.log('  2. Claude Code (透過 claude mcp add)');
  console.log('  3. 兩者都設定');
  const choice = (await question('\n請輸入選項 (1/2/3): ')).trim();

  const doClaude = choice === '1' || choice === '3';
  const doCode = choice === '2' || choice === '3';

  if (!doClaude && !doCode) {
    console.log('未選擇任何選項，已結束。');
    rl.close();
    process.exit(0);
  }

  if (doClaude) {
    console.log('\n--- Claude Desktop 設定 ---');
    await setupClaudeDesktop(mcpEntry);
  }

  if (doCode) {
    await setupClaudeCode(distPath, token, useKeychain);
  }

  console.log('\n🎉 設定完成！重啟對應的 Claude 用戶端後即可使用 Threads MCP 工具。');
  rl.close();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
