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

// 取得環境變數或 Keychain 中的值
function getExistingConfig() {
  let appId = '';
  let businessId = '';

  if (process.platform === 'darwin') {
    try {
      appId = execSync('security find-generic-password -a "$USER" -s "threads-app-id" -w 2>/dev/null', { encoding: 'utf8' }).trim();
    } catch (e) {}
  }

  if (!appId) {
    appId = resolveEnvValue(process.env.THREADS_APP_ID);
  }

  businessId = resolveEnvValue(process.env.THREADS_BUSINESS_ID);

  return { appId, businessId };
}

// 更新 .env 檔案中的 THREADS_BUSINESS_ID
function updateEnvBusinessId(businessId) {
  const envPath = path.join(process.cwd(), '.env');
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }
  const key = 'THREADS_BUSINESS_ID';
  const regex = new RegExp(`^${key}=.*$`, 'm');
  let newEnvContent = '';
  if (regex.test(envContent)) {
    newEnvContent = envContent.replace(regex, `${key}=${businessId}`);
  } else {
    newEnvContent = envContent.trim() ? envContent.trim() + `\n${key}=${businessId}\n` : `${key}=${businessId}\n`;
  }
  fs.writeFileSync(envPath, newEnvContent.trim() + '\n', 'utf8');
}

async function main() {
  console.log('=== Threads Documentation Customization Helper ===\n');
  console.log('此腳本將協助您將 `SETUP.md` 與 `GET_THREADS_TOKEN.md` 中的預留位置（如 `<your_app_id>` 與 `<your_business_id>`）');
  console.log('替換為您自己實際的 Meta App ID 與 Business ID，以利您在閱讀文件時能直接點擊連結跳轉至您的 App 設定頁面。\n');

  const config = getExistingConfig();
  
  let defaultAppIdStr = config.appId ? ` (預設: ${config.appId})` : '';
  let appIdInput = (await question(`請輸入您的 Threads App ID (Client ID)${defaultAppIdStr}: `)).trim();
  const appId = appIdInput || config.appId;

  if (!appId) {
    console.error('❌ 錯誤：App ID 為必填欄位！');
    rl.close();
    process.exit(1);
  }

  let defaultBusIdStr = config.businessId ? ` (預設: ${config.businessId})` : '';
  let busIdInput = (await question(`請輸入您的 Meta 商業管理員編號 Business ID (選用，若無請直接按 Enter)${defaultBusIdStr}: `)).trim();
  const businessId = busIdInput || config.businessId;

  // 如果有輸入 Business ID，且與現有不同，寫入 .env
  if (businessId && businessId !== config.businessId) {
    updateEnvBusinessId(businessId);
    console.log(`✅ 已在 .env 檔案中新增/更新 THREADS_BUSINESS_ID=${businessId}`);
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
