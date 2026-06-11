import fs from 'fs';
import path from 'path';
import axios from 'axios';
import readline from 'readline';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
import { getCredential, setCredential, getEnvCommand, isKeychainSupported } from './keychain.js';

// 載入現有環境變數
dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

// 解析可能包含 $(command) 的環境變數值
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

// 更新 .env 檔案
function updateEnvFile(key, value) {
  const envPath = path.join(process.cwd(), '.env');
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
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
  console.log('=== Threads Long-Lived Token Exchanger ===');
  console.log('此腳本將協助您將短期 Token 交換為 60 天效期的長期 Token，並自動寫入 .env 中。');
  console.log('此腳本支援 Windows, macOS 與 Linux。\n');

  let clientSecret = '';
  let hasKeychainSecret = false;

  if (isKeychainSupported()) {
    clientSecret = getCredential('threads-app-secret');
    if (clientSecret) hasKeychainSecret = true;
  }

  // 備用讀取環境變數 (處理普通字串與指令)
  if (!clientSecret) {
    clientSecret = resolveEnvValue(process.env.THREADS_APP_SECRET);
  }

  if (clientSecret) {
    if (hasKeychainSecret) {
      console.log(`🔑 已從系統安全儲存區成功取得 threads-app-secret (已自動填入)`);
    } else {
      console.log(`🔑 已從環境變數取得 threads-app-secret (已自動填入)`);
    }
  } else {
    clientSecret = (await question('請輸入您的 Threads App Secret (Client Secret): ')).trim();
  }

  if (!clientSecret) {
    console.error('錯誤：App Secret 為必填欄位！');
    rl.close();
    process.exit(1);
  }

  // 詢問是否存入系統金鑰庫或寫回 .env
  if (isKeychainSupported()) {
    if (!hasKeychainSecret && clientSecret) {
      const saveSecret = (await question('\n偵測到系統金鑰庫中尚未儲存 Threads App Secret，是否將其存入系統安全儲存區以提高安全性？(y/n): ')).trim().toLowerCase();
      if (saveSecret === 'y' || saveSecret === 'yes') {
        if (setCredential('threads-app-secret', clientSecret)) {
          hasKeychainSecret = true;
          updateEnvFile('THREADS_APP_SECRET', getEnvCommand('threads-app-secret'));
          console.log('✅ 已成功將 App Secret 儲存至系統安全儲存區，並將對應指令寫回 .env。');
        } else {
          updateEnvFile('THREADS_APP_SECRET', clientSecret);
          console.log('已將明文 App Secret 寫回 .env。');
        }
      } else {
        updateEnvFile('THREADS_APP_SECRET', clientSecret);
        console.log('已將明文 App Secret 寫回 .env。');
      }
    }
  } else {
    updateEnvFile('THREADS_APP_SECRET', clientSecret);
    console.log('✅ 已將明文 App Secret 寫入 .env。');
  }

  console.log('\n💡 提示：您可以前往 Graph API Explorer 生成您的短期 Token。');
  const openExplorer = (await question('是否直接為您在瀏覽器中開啟 Graph API Explorer 頁面？(y/n): ')).trim().toLowerCase();
  if (openExplorer === 'y' || openExplorer === 'yes') {
    try {
      const startCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
      execSync(`${startCmd} "https://developers.facebook.com/tools/explorer/"`);
      console.log('✅ 已嘗試在瀏覽器中開啟 Graph API Explorer。');
    } catch (e) {
      console.log('無法自動開啟瀏覽器，請手動前往 https://developers.facebook.com/tools/explorer/');
    }
  }
  const shortLivedToken = (await question('\n請輸入您在 Explorer 取得的短期 Token: ')).trim();

  if (!shortLivedToken) {
    console.error('錯誤：短期 Token 為必填欄位！');
    rl.close();
    process.exit(1);
  }

  console.log('\n正在向 Threads API 發送交換請求...');

  try {
    const res = await axios.get('https://graph.threads.net/access_token', {
      params: {
        grant_type: 'th_exchange_token',
        client_secret: clientSecret,
        access_token: shortLivedToken
      }
    });

    const longLivedToken = res.data.access_token;
    const expiresIn = res.data.expires_in;

    console.log('✅ 成功取得長期 Token！');
    console.log(`有效期 (秒): ${expiresIn} (約 60 天)`);

    const envPath = path.join(process.cwd(), '.env');

    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    const tokenRegex = /^THREADS_ACCESS_TOKEN=.*$/m;
    let newEnvContent = '';

    if (tokenRegex.test(envContent)) {
      newEnvContent = envContent.replace(tokenRegex, `THREADS_ACCESS_TOKEN=${longLivedToken}`);
      console.log('✅ 已在現有的 .env 檔案中更新 THREADS_ACCESS_TOKEN。');
    } else {
      newEnvContent = envContent.trim() ? envContent.trim() + `\nTHREADS_ACCESS_TOKEN=${longLivedToken}\n` : `THREADS_ACCESS_TOKEN=${longLivedToken}\n`;
      console.log('✅ 已在 .env 檔案中新增 THREADS_ACCESS_TOKEN。');
    }

    fs.writeFileSync(envPath, newEnvContent.trim() + '\n', 'utf8');
    console.log(`📍 儲存路徑: ${envPath}`);

    // 系統安全金鑰庫儲存功能
    if (isKeychainSupported()) {
      const saveKeychain = (await question('\n是否將 Long-lived Token 存入系統安全金鑰庫中以提高安全性？(y/n): ')).trim().toLowerCase();
      if (saveKeychain === 'y' || saveKeychain === 'yes') {
        if (setCredential('threads-access-token', longLivedToken)) {
          console.log('✅ 已成功將 Token 儲存至系統安全儲存區。');
          updateEnvFile('THREADS_ACCESS_TOKEN', getEnvCommand('threads-access-token'));
          console.log('✅ 已成功將 .env 中的 THREADS_ACCESS_TOKEN 更新為安全讀取指令。');
        }
      }
    }

    console.log('\n🎉 設定完成！您現在可以正常啟動您的 Threads MCP 伺服器了。');

  } catch (err) {
    console.error('\n❌ 交換 Token 失敗，請確認您的 App Secret 與短期 Token 是否正確。');
    if (axios.isAxiosError(err)) {
      console.error('API 錯誤回應：', err.response?.data || err.message);
    } else {
      console.error(err);
    }
  }

  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
