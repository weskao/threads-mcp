#!/usr/bin/env node
/**
 * Threads token 續期 CLI（保險方案，供 npm script 與系統排程呼叫）。
 *
 *   node scripts/refresh_threads_token.js            # 依排程判斷是否續期
 *   node scripts/refresh_threads_token.js --force    # 立即續期（仍受 API 的 24h 限制）
 *   node scripts/refresh_threads_token.js --quiet    # 僅在實際續期或失敗時輸出
 *
 * 退出碼：0 = 成功或良性跳過；1 = 續期失敗（缺 token / API 錯誤）。
 */
import { refreshThreadsToken } from './token-refresh.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const quiet = args.includes('--quiet');

const result = await refreshThreadsToken({
  force,
  // CLI 直接走 stdout（無 MCP 通道顧慮）；quiet 模式下跳過訊息不輸出。
  log: (m) => {
    if (!quiet || /✅|❌/.test(m)) console.log(m);
  },
});

if (!result.ok) {
  console.error(`✖ token 續期失敗：${result.error ?? result.reason}`);
  process.exit(1);
}
process.exit(0);
