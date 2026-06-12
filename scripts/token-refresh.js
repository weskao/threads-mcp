/**
 * Threads 長期 token 自動續期核心（跨平台：macOS / Linux / Windows）。
 *
 * Threads 的長期 token 效期 60 天，但可在「已存在 ≥ 24 小時且尚未過期」時呼叫
 * refresh 端點換得新的 60 天 token，等於把效期時鐘歸零。只要在任一 60 天窗口
 * 內續期過一次就永不過期；一旦真的過期就只能重跑 OAuth。
 *
 * 本模組同時被兩處使用：
 *   - 常駐 server（src/index.ts）以 setInterval 定時呼叫（主方案）
 *   - 獨立 CLI（scripts/refresh_threads_token.js）+ 系統排程（保險方案）
 *
 * token 取得 / 寫回一律 keychain 優先、.env fallback，與 exchange 腳本一致。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';
import {
  getCredential,
  setCredential,
  getEnvCommand,
  isKeychainSupported,
} from './keychain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const STATE_PATH = path.join(PROJECT_ROOT, 'threads', '.token-state.json');

const REFRESH_ENDPOINT = 'https://graph.threads.net/refresh_access_token';
const SECONDS_PER_DAY = 86400;

// 預設：距上次續期 ≥ 7 天才續一次（冪等、留 60 天大緩衝）；token 必須 ≥ 24h 才能續。
const DEFAULT_INTERVAL_DAYS = 7;
const MIN_TOKEN_AGE_HOURS = 24;

/** 解析可能包含 $(command) 的環境變數值（keychain 模式下 .env 存的是指令）。 */
function resolveEnvValue(val) {
  if (!val) return '';
  val = val.trim();
  if (val.startsWith('$(') && val.endsWith(')')) {
    const cmd = val.slice(2, -1);
    try {
      return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  }
  return val;
}

/** 取得目前的長期 token：keychain 優先，否則解析 .env 的值。 */
export function getCurrentAccessToken() {
  if (isKeychainSupported()) {
    const fromKeychain = getCredential('threads-access-token');
    if (fromKeychain) return fromKeychain;
  }
  // 確保即使呼叫端沒先載入也讀得到 .env
  dotenv.config({ path: ENV_PATH });
  return resolveEnvValue(process.env.THREADS_ACCESS_TOKEN);
}

/** 將 key=value 寫回 .env（存在則取代、不存在則附加）。 */
function updateEnvFile(key, value) {
  let envContent = '';
  if (fs.existsSync(ENV_PATH)) envContent = fs.readFileSync(ENV_PATH, 'utf8');
  const regex = new RegExp(`^${key}=.*$`, 'm');
  const next = regex.test(envContent)
    ? envContent.replace(regex, `${key}=${value}`)
    : (envContent.trim() ? `${envContent.trim()}\n${key}=${value}` : `${key}=${value}`);
  fs.writeFileSync(ENV_PATH, next.trim() + '\n', 'utf8');
}

/**
 * 持久化新 token：keychain 優先（.env 同步寫入 $(...) 動態讀取指令以免明文外洩），
 * 否則直接把明文寫回 .env。
 * @returns {'keychain'|'env'} 實際寫入的位置
 */
export function persistAccessToken(token) {
  if (isKeychainSupported() && setCredential('threads-access-token', token)) {
    updateEnvFile('THREADS_ACCESS_TOKEN', getEnvCommand('threads-access-token'));
    return 'keychain';
  }
  updateEnvFile('THREADS_ACCESS_TOKEN', token);
  return 'env';
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

const hoursSince = (iso) => (Date.now() - new Date(iso).getTime()) / 3600000;
const daysSince = (iso) => hoursSince(iso) / 24;

/**
 * 依狀態檔判斷此刻是否該續期。
 * @returns {{ should: boolean, reason: string }}
 */
function decideRefresh(state, { force, intervalDays, refreshBeforeDays }) {
  if (force) return { should: true, reason: 'forced' };
  if (!state || !state.refreshed_at) return { should: true, reason: 'no_state' };

  // 距上次續期不足 24h → API 會拒絕（token 太新），先跳過。
  if (hoursSince(state.refreshed_at) < MIN_TOKEN_AGE_HOURS) {
    return { should: false, reason: 'too_new' };
  }
  if (state.expires_at) {
    const daysLeft = (new Date(state.expires_at).getTime() - Date.now()) / 86400000;
    if (daysLeft <= refreshBeforeDays) {
      return { should: true, reason: `expires_in_${Math.round(daysLeft)}d` };
    }
  }
  if (daysSince(state.refreshed_at) >= intervalDays) {
    return { should: true, reason: 'interval_elapsed' };
  }
  return { should: false, reason: 'fresh' };
}

/**
 * 嘗試續期 Threads 長期 token。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false]            無視排程，立即續期（仍受 API 的 24h 限制）
 * @param {number}  [opts.intervalDays=7]         距上次續期幾天後才再續
 * @param {number}  [opts.refreshBeforeDays=10]   剩餘效期低於幾天就提前續
 * @param {(msg: string) => void} [opts.log]      記錄函式（預設 stderr，避免污染 stdio MCP 通道）
 * @returns {Promise<{ ok: boolean, refreshed: boolean, token?: string, expiresIn?: number, persistedTo?: string, reason: string, error?: string }>}
 */
export async function refreshThreadsToken(opts = {}) {
  const {
    force = false,
    intervalDays = DEFAULT_INTERVAL_DAYS,
    refreshBeforeDays = 10,
    log = (m) => console.error(m),
  } = opts;

  const token = getCurrentAccessToken();
  if (!token) {
    return { ok: false, refreshed: false, reason: 'no_token', error: '找不到 THREADS_ACCESS_TOKEN（keychain 與 .env 皆無）' };
  }

  const state = readState();
  const { should, reason } = decideRefresh(state, { force, intervalDays, refreshBeforeDays });
  if (!should) {
    log(`⏭️  跳過續期（${reason}）`);
    return { ok: true, refreshed: false, reason };
  }

  log(`🔄 嘗試續期 Threads token（觸發原因：${reason}）…`);
  try {
    const res = await axios.get(REFRESH_ENDPOINT, {
      params: { grant_type: 'th_refresh_token', access_token: token },
      timeout: 30000,
    });
    const newToken = res.data?.access_token;
    const expiresIn = res.data?.expires_in;
    if (!newToken) {
      return { ok: false, refreshed: false, reason: 'no_token_in_response', error: JSON.stringify(res.data) };
    }

    const persistedTo = persistAccessToken(newToken);
    const nowIso = new Date().toISOString();
    writeState({
      refreshed_at: nowIso,
      expires_in: expiresIn ?? null,
      expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
    });

    const days = expiresIn ? Math.round(expiresIn / SECONDS_PER_DAY) : '?';
    log(`✅ 續期成功，新 token 效期約 ${days} 天，已寫入 ${persistedTo}`);
    return { ok: true, refreshed: true, token: newToken, expiresIn, persistedTo, reason };
  } catch (err) {
    const apiMsg = err?.response?.data?.error?.message || err?.message || String(err);
    // token 太新（<24h）會被 API 拒絕——視為良性跳過，下次排程再試。
    const tooNew = /24 hours|too soon|at least/i.test(apiMsg);
    log(`${tooNew ? '⏭️' : '❌'}  續期未完成：${apiMsg}`);
    return {
      ok: tooNew,
      refreshed: false,
      reason: tooNew ? 'too_new' : 'api_error',
      error: apiMsg,
    };
  }
}
