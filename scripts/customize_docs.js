import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { execSync } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

function resolveEnvValue(val) {
  if (!val) return '';
  val = val.trim();
  if (val.startsWith('$(') && val.endsWith(')')) {
    const cmd = val.slice(2, -1);
    try {
      return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    } catch (e) {
      return '';
    }
  }
  return val;
}

// 取得 .env 中既有的 APP_ID / BUSINESS_ID（純明碼，無 keychain）
function getExistingConfig() {
  const appId = resolveEnvValue(process.env.APP_ID);
  const businessId = resolveEnvValue(process.env.BUSINESS_ID);
  return { appId, businessId };
}

// 從 Meta 開發者主控台網址解析 APP_ID 與 BUSINESS_ID
// 支援格式：
//   https://developers.facebook.com/apps/123456789
//   https://developers.facebook.com/apps/123456789/dashboard
//   https://developers.facebook.com/apps/123456789/dashboard/?business_id=987654321
// 解析成功回傳 { appId, businessId }，失敗回傳 null
function parseMetaUrl(input) {
  const appIdMatch = input.match(/developers\.facebook\.com\/apps\/(\d+)/);
  if (!appIdMatch) return null;
  const appId = appIdMatch[1];

  let businessId = '';
  try {
    const url = new URL(input.startsWith('http') ? input : 'https://' + input);
    businessId = url.searchParams.get('business_id') || '';
  } catch {
    const bizMatch = input.match(/[?&]business_id=(\d+)/);
    businessId = bizMatch ? bizMatch[1] : '';
  }
  return { appId, businessId };
}

// 將指定 key 以明碼寫回 .env（已存在則更新，否則新增；命名依 .env.example 慣例）
// 統一正規化為 LF 換行，確保跨平台一致性
function upsertEnvValue(key, value) {
  const envPath = path.join(process.cwd(), '.env');
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8').replace(/\r\n/g, '\n');
  }
  const regex = new RegExp(`^${key}=.*$`, 'm');
  let newEnvContent = '';
  if (regex.test(envContent)) {
    newEnvContent = envContent.replace(regex, `${key}=${value}`);
  } else {
    newEnvContent = envContent.trim() ? envContent.trim() + `\n${key}=${value}\n` : `${key}=${value}\n`;
  }
  fs.writeFileSync(envPath, newEnvContent.trim() + '\n', 'utf8');
}

function applyToDocs(appId, businessId) {
  const docFiles = ['SETUP.md'];
  const results = [];

  for (const file of docFiles) {
    const filePath = path.join(process.cwd(), file);
    if (!fs.existsSync(filePath)) {
      results.push({ file, status: 'missing' });
      continue;
    }

    let content = fs.readFileSync(filePath, 'utf8');
    const originalContent = content;

    content = content.replace(/<your_app_id>/g, appId);
    if (businessId) {
      content = content.replace(/<your_business_id>/g, businessId);
    } else {
      content = content.replace(/\/\?business_id=<your_business_id>/g, '/');
      content = content.replace(/&business_id=<your_business_id>/g, '');
      content = content.replace(/\?business_id=<your_business_id>/g, '');
    }

    if (content !== originalContent) {
      fs.writeFileSync(filePath, content, 'utf8');
      results.push({ file, status: 'updated' });
    } else {
      results.push({ file, status: 'unchanged' });
    }
  }
  return results;
}

async function main() {
  // 處理 Ctrl+C，避免 readline 殘留
  process.on('SIGINT', () => {
    console.log('\n\n⚠️  已取消，未做任何變更。');
    rl.close();
    process.exit(0);
  });

  console.log('=== Threads Documentation Customization Helper ===\n');
  console.log('此腳本將協助您將 `SETUP.md` 中的預留位置');
  console.log('替換為您自己實際的 Meta APP_ID 與 BUSINESS_ID，');
  console.log('以利您在閱讀文件時能直接點擊連結跳轉至您的 App 設定頁面。\n');

  const config = getExistingConfig();
  if (config.appId) {
    console.log(`ℹ️  目前已設定：APP_ID=${config.appId}${config.businessId ? `，BUSINESS_ID=${config.businessId}` : ''}`);
    console.log('');
  }

  const hasExisting = Boolean(config.appId);

  console.log('請選擇輸入方式：');
  console.log('  1. 🔗 貼上 Meta 開發者主控台網址（推薦）— 自動解析 APP_ID 與 BUSINESS_ID');
  console.log('  2. ✏️  手動輸入 APP_ID 與 BUSINESS_ID（需先至 Meta 開發者後台查詢）');
  if (hasExisting) {
    console.log('  3. ✅ 沿用現有設定重新套用文件（不更新 .env）');
  }
  console.log('');

  const validModes = hasExisting ? ['1', '2', '3'] : ['1', '2'];
  const modePrompt = hasExisting ? '請輸入選項 (1/2/3): ' : '請輸入選項 (1/2): ';
  let modeInput = '';
  while (!validModes.includes(modeInput)) {
    modeInput = (await question(modePrompt)).trim();
    if (!validModes.includes(modeInput)) {
      console.log(`❌ 請輸入 ${validModes.join('/')}。`);
    }
  }

  let appId = '';
  let businessId = '';
  let skipEnvWrite = false;

  if (modeInput === '3' && hasExisting) {
    // 方式三：沿用現有設定，只重新套用文件
    appId = config.appId;
    businessId = config.businessId;
    skipEnvWrite = true;
  } else if (modeInput === '1') {
    // 方式一：貼上網址自動解析
    console.log('\n支援格式範例：');
    console.log('  https://developers.facebook.com/apps/123456789');
    console.log('  https://developers.facebook.com/apps/123456789/dashboard');
    console.log('  https://developers.facebook.com/apps/123456789/dashboard/?business_id=987654321');

    let parsed = null;
    while (!parsed) {
      const urlInput = (await question('請貼上 Meta 開發者主控台的網址: ')).trim();
      if (!urlInput && config.appId) {
        parsed = { appId: config.appId, businessId: config.businessId };
        console.log('ℹ️  空白輸入，沿用現有設定。');
        break;
      }
      parsed = parseMetaUrl(urlInput);
      if (!parsed) {
        console.log('❌ 無法從網址中解析 APP_ID，請確認格式正確後再試。');
        console.log('   範例：https://developers.facebook.com/apps/123456789/dashboard/?business_id=987654321');
      }
    }
    appId = parsed.appId;
    businessId = parsed.businessId;
    if (!businessId && config.businessId) {
      businessId = config.businessId;
      console.log(`\n🔍 解析結果：APP_ID=${appId}，BUSINESS_ID=${businessId}（URL 中無 BUSINESS_ID，沿用現有設定）`);
    } else {
      console.log(`\n🔍 解析結果：APP_ID=${appId}${businessId ? `，BUSINESS_ID=${businessId}` : '（無 BUSINESS_ID）'}`);
    }

  } else {
    // 方式二：手動輸入
    console.log('\n  💡 如何取得 APP_ID 與 BUSINESS_ID？');
    console.log('  ─────────────────────────────────────────');
    console.log('  1. 前往 https://developers.facebook.com/apps/');
    console.log('  2. 點入您的 Threads 應用程式');
    console.log('  3. 從網址列讀取（以下為範例）：');
    console.log('');
    console.log('     https://developers.facebook.com/apps/123456789');
    console.log('     → APP_ID = 123456789（/apps/ 後的數字）');
    console.log('');
    console.log('     https://developers.facebook.com/apps/123456789/dashboard/?business_id=987654321');
    console.log('     → APP_ID = 123456789，BUSINESS_ID = 987654321（business_id= 後的數字）');
    console.log('');
    console.log('  💡 提示：選項 1「貼上網址」可自動解析，免手動查找。');
    console.log('  ─────────────────────────────────────────');
    const defaultAppIdStr = config.appId ? ` (Enter 保留: ${config.appId})` : '';
    while (!appId) {
      appId = (await question(`\n請輸入 APP_ID${defaultAppIdStr}: `)).trim() || config.appId;
      if (!appId) console.log('❌ APP_ID 為必填欄位，請重新輸入。');
    }

    const busLabel = config.businessId
      ? `請輸入 BUSINESS_ID（Enter 保留: ${config.businessId}）`
      : '請輸入 BUSINESS_ID（選用，若有才填；Enter 略過）';
    const busInput = (await question(`${busLabel}: `)).trim();
    businessId = busInput || config.businessId || '';
  }

  // ── 確認步驟 ──────────────────────────────────────────
  console.log('\n  即將執行以下操作：');
  console.log('  ─────────────────────────────────────────');
  if (!skipEnvWrite) {
    console.log(`  寫入 .env  ：APP_ID=${appId}`);
    if (businessId) console.log(`               BUSINESS_ID=${businessId}`);
  } else {
    console.log(`  .env       ：不更新（沿用 APP_ID=${appId}${businessId ? `，BUSINESS_ID=${businessId}` : ''}）`);
  }
  console.log('  更新文件   ：SETUP.md');
  console.log('  ─────────────────────────────────────────');
  const confirm = (await question('  確認執行？(y/n): ')).trim().toLowerCase();
  if (confirm !== 'y') {
    console.log('\n⚠️  已取消，未做任何變更。');
    rl.close();
    return;
  }

  // ── 寫入 .env ─────────────────────────────────────────
  if (!skipEnvWrite) {
    upsertEnvValue('APP_ID', appId);
    console.log(`\n✅ .env 已更新：APP_ID=${appId}`);
    if (businessId) {
      upsertEnvValue('BUSINESS_ID', businessId);
      console.log(`✅ .env 已更新：BUSINESS_ID=${businessId}`);
    }
  }

  // ── 套用文件 ──────────────────────────────────────────
  const results = applyToDocs(appId, businessId);
  let updatedCount = 0;
  for (const { file, status } of results) {
    if (status === 'updated')   { console.log(`📝 已更新：${file}`); updatedCount++; }
    else if (status === 'unchanged') console.log(`ℹ️  已是最新：${file}`);
    else                             console.log(`⚠️  找不到：${file}，略過。`);
  }

  // ── 完成摘要 ──────────────────────────────────────────
  console.log('\n  ─────────────────────────────────────────');
  if (updatedCount > 0) {
    console.log(`  🎉 完成！已更新 ${updatedCount} 個文件。`);
    console.log('     現在可點擊文件中的 Meta 開發者連結，直接跳轉至您的 App 設定頁面。');
  } else {
    console.log('  ✅ 完成！文件均已是最新狀態，無需更新。');
  }
  console.log('  ─────────────────────────────────────────');

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
