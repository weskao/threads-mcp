import { execSync, execFileSync } from 'child_process';
import os from 'os';

const platform = process.platform;

const ALLOWED_SERVICE_NAMES = new Set([
  'threads-app-id',
  'threads-app-secret',
  'threads-access-token',
]);

function assertServiceName(serviceName) {
  if (!ALLOWED_SERVICE_NAMES.has(serviceName)) {
    throw new Error(`Invalid keychain service name: ${serviceName}`);
  }
}

/**
 * 檢查目前系統是否支援金鑰庫儲存
 * @returns {boolean}
 */
export function isKeychainSupported() {
  if (platform === 'darwin' || platform === 'win32') return true;
  if (platform === 'linux') {
    try {
      execFileSync('which', ['secret-tool'], { stdio: 'ignore' });
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
}

/**
 * 自金鑰庫取得金鑰的值
 * @param {string} serviceName - 'threads-app-id' | 'threads-app-secret' | 'threads-access-token'
 * @returns {string} 密鑰值，若不存在或不支援則傳回空字串
 */
export function getCredential(serviceName) {
  assertServiceName(serviceName);
  const user = process.env.USER || os.userInfo().username || 'default';

  if (platform === 'darwin') {
    try {
      return execFileSync(
        'security',
        ['find-generic-password', '-a', user, '-s', serviceName, '-w'],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
      ).trim();
    } catch (e) {
      return '';
    }
  }

  if (platform === 'win32') {
    try {
      return execFileSync(
        'powershell',
        ['-Command', `try { ((New-Object Windows.Security.Credentials.PasswordVault).Retrieve('threads-mcp', $env:SVC_NAME)).Password } catch { exit 1 }`],
        { encoding: 'utf8', env: { ...process.env, SVC_NAME: serviceName }, stdio: ['pipe', 'pipe', 'ignore'] }
      ).trim();
    } catch (e) {
      return '';
    }
  }

  if (platform === 'linux') {
    try {
      return execFileSync(
        'secret-tool',
        ['lookup', 'application', 'threads-mcp', 'service', serviceName],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
      ).trim();
    } catch (e) {
      return '';
    }
  }

  return '';
}

/**
 * 將金鑰與值儲存至系統金鑰庫
 * @param {string} serviceName - 密鑰服務名稱
 * @param {string} value - 密鑰值
 * @returns {boolean} 是否成功
 */
export function setCredential(serviceName, value) {
  assertServiceName(serviceName);
  const user = process.env.USER || os.userInfo().username || 'default';

  if (platform === 'darwin') {
    try {
      execFileSync('security', ['add-generic-password', '-s', serviceName, '-a', user, '-w', value, '-U']);
      return true;
    } catch (e) {
      console.error(`❌ macOS Keychain 寫入失敗: ${e.message}`);
      return false;
    }
  }

  if (platform === 'win32') {
    try {
      execFileSync(
        'powershell',
        ['-Command', `$vault = New-Object Windows.Security.Credentials.PasswordVault; $vault.Add((New-Object Windows.Security.Credentials.PasswordCredential('threads-mcp', $env:SVC_NAME, $env:CRED_VALUE)))`],
        { env: { ...process.env, SVC_NAME: serviceName, CRED_VALUE: value }, stdio: 'ignore' }
      );
      return true;
    } catch (e) {
      console.error(`❌ Windows PasswordVault 寫入失敗: ${e.message}`);
      return false;
    }
  }

  if (platform === 'linux') {
    try {
      execFileSync(
        'secret-tool',
        ['store', '--label', `Threads MCP ${serviceName}`, 'application', 'threads-mcp', 'service', serviceName],
        { input: value, stdio: ['pipe', 'ignore', 'ignore'] }
      );
      return true;
    } catch (e) {
      console.error(`❌ Linux Secret Service 寫入失敗: ${e.message}`);
      return false;
    }
  }

  return false;
}

/**
 * 取得適用於寫入 .env 的動態讀取指令，防止明文洩漏
 * @param {string} serviceName - 密鑰服務名稱
 * @returns {string} 對應平台指令字串
 */
export function getEnvCommand(serviceName) {
  assertServiceName(serviceName);
  if (platform === 'darwin') {
    return `$(security find-generic-password -a "$USER" -s "${serviceName}" -w 2>/dev/null)`;
  }
  if (platform === 'win32') {
    return `$(powershell -Command "try { ((New-Object Windows.Security.Credentials.PasswordVault).Retrieve('threads-mcp', '${serviceName}')).Password } catch { exit 1 }")`;
  }
  if (platform === 'linux') {
    return `$(secret-tool lookup application threads-mcp service "${serviceName}" 2>/dev/null)`;
  }
  return '';
}
