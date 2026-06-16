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

async function main() {
  console.log('=== Threads Documentation Customization Helper ===\n');
  console.log('此腳本將協助您將 `SETUP.md` 與 `GET_THREADS_TOKEN.md` 中的預留位置（如 `<your_app_id>` 與 `<your_business_id>`）');
  console.log('替換為您自己實際的 Meta App ID 與 Business ID，以利您在閱讀文件時能直接點擊連結跳轉至您的 App 設定頁面。\n');

  const config = getExistingConfig();
  if (config.appId) {
    console.log(`ℹ️  目前已設定：APP_ID=${config.appId}${config.businessId ? `，BUSINESS_ID=${config.businessId}` : ''}`);
    console.log('   直接按 Enter 保留現有值，或重新輸入以更新。\n');
  }

  console.log('請選擇輸入方式：');
  console.log('  1. 貼上 Meta 開發者主控台網址（推薦）— 自動解析 App ID 與 Business ID');
  console.log('  2. 手動輸入 App ID 與 Business ID\n');

  let modeInput = '';
  while (modeInput !== '1' && modeInput !== '2') {
    modeInput = (await question('請輸入選項 (1/2): ')).trim();
    if (modeInput !== '1' && modeInput !== '2') {
      console.log('❌ 請輸入 1 或 2。');
    }
  }

  let appId = '';
  let businessId = '';

  if (modeInput === '1') {
    // 方式一：貼上網址自動解析
    console.log('\n支援格式：');
    console.log('  https://developers.facebook.com/apps/123456789');
    console.log('  https://developers.facebook.com/apps/123456789/dashboard/?business_id=987654321');

    let parsed = null;
    while (!parsed) {
      const urlInput = (await question('請貼上 Meta 開發者主控台的網址: ')).trim();
      if (!urlInput && config.appId) {
        parsed = { appId: config.appId, businessId: config.businessId };
        console.log('ℹ️  保留現有設定。');
        break;
      }
      parsed = parseMetaUrl(urlInput);
      if (!parsed) {
        console.log('❌ 無法從網址中解析 App ID，請確認格式正確後再試。');
        console.log('   範例：https://developers.facebook.com/apps/123456789/dashboard/?business_id=987654321');
      }
    }
    appId = parsed.appId;
    businessId = parsed.businessId;
    console.log(`\n🔍 解析結果：APP_ID=${appId}${businessId ? `，BUSINESS_ID=${businessId}` : '（無 Business ID）'}`);

  } else {
    // 方式二：手動輸入
    const defaultAppIdStr = config.appId ? ` (預設: ${config.appId})` : '';
    while (!appId) {
      appId = (await question(`\n請輸入 App ID${defaultAppIdStr}: `)).trim() || config.appId;
      if (!appId) console.log('❌ App ID 為必填欄位，請重新輸入。');
    }

    const defaultBusIdStr = config.businessId ? ` (預設: ${config.businessId})` : '';
    const busInput = (await question(`請輸入 Business ID（選用，若無請直接按 Enter）${defaultBusIdStr}: `)).trim();
    businessId = busInput || config.businessId || '';
  }

  upsertEnvValue('APP_ID', appId);
  console.log(`\n✅ 已在 .env 檔案中新增/更新 APP_ID=${appId}`);

  if (businessId) {
    upsertEnvValue('BUSINESS_ID', businessId);
    console.log(`✅ 已在 .env 檔案中新增/更新 BUSINESS_ID=${businessId}`);
  }

  const docFiles = ['SETUP.md', 'GET_THREADS_TOKEN.md'];
  let modifiedCount = 0;

  for (const file of docFiles) {
    const filePath = path.join(process.cwd(), file);
    if (!fs.existsSync(filePath)) {
      console.log(`⚠️ 找不到文件: ${file}，略過。`);
      continue;
    }

    let content = fs.readFileSync(filePath, 'utf8');
    let originalContent = content;

    // 1. 替換 App ID
    content = content.replace(/<your_app_id>/g, appId);

    // 2. 替換 Business ID
    if (businessId) {
      content = content.replace(/<your_business_id>/g, businessId);
    } else {
      // 若沒有提供 Business ID，清理相關 URL 參數，避免無效 query
      // 匹配 /?business_id=<your_business_id>) 或 &business_id=<your_business_id>
      content = content.replace(/\/\?business_id=<your_business_id>/g, '/');
      content = content.replace(/&business_id=<your_business_id>/g, '');
      content = content.replace(/\?business_id=<your_business_id>/g, '');
    }

    if (content !== originalContent) {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`📝 已成功更新: \`${file}\``);
      modifiedCount++;
    } else {
      console.log(`ℹ️ 文件 \`${file}\` 無需更新或已是最新狀態。`);
    }
  }

  console.log(`\n🎉 設定完成！共更新了 ${modifiedCount} 個 Markdown 文件。`);
  console.log('現在您可以點擊文件中的 Meta 開發者超連結，直接跳轉到對應的設定頁面。');
  
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
