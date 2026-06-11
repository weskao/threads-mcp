import fs from 'fs';
import path from 'path';
import axios from 'axios';
import readline from 'readline';
import { URL } from 'url';
import { execSync } from 'child_process';
import dotenv from 'dotenv';

// 載入現有環境變數
dotenv.config();

// Meta OAuth 強制要求 redirect_uri 必須是 https 開頭，即使是 localhost。
// 我們將 redirect_uri 設定為 https 協定，這樣 Meta 就會放行。
// 用戶授權後，瀏覽器會跳轉到此 URL (即使網頁載入失敗也沒關係)，用戶只需複製網址列貼回即可。
const REDIRECT_URI = 'https://localhost:3000/auth/callback';

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
  console.log('=== Threads API Access Token Helper ===\n');
  console.log('此腳本將協助您取得 Threads API 的長期 Access Token。');
  console.log('請先確保您已在 Meta for Developers 建立了應用程式，並已將 Threads API 加入該應用程式。');
  console.log(`請在應用程式設定中，將 Valid OAuth Redirect URI 精確設定為: ${REDIRECT_URI}\n`);

  let clientId = '';
  let clientSecret = '';
  let hasKeychainId = false;
  let hasKeychainSecret = false;

  if (process.platform === 'darwin') {
    try {
      clientId = execSync('security find-generic-password -a "$USER" -s "threads-app-id" -w 2>/dev/null', { encoding: 'utf8' }).trim();
      if (clientId) hasKeychainId = true;
    } catch (e) {}
    try {
      clientSecret = execSync('security find-generic-password -a "$USER" -s "threads-app-secret" -w 2>/dev/null', { encoding: 'utf8' }).trim();
      if (clientSecret) hasKeychainSecret = true;
    } catch (e) {}
  }

  // 備用讀取環境變數 (處理普通字串與指令)
  if (!clientId) {
    clientId = resolveEnvValue(process.env.THREADS_APP_ID);
  }
  if (!clientSecret) {
    clientSecret = resolveEnvValue(process.env.THREADS_APP_SECRET);
  }

  // 若仍缺乏，則手動輸入
  if (clientId) {
    if (hasKeychainId) {
      console.log(`🔑 已從系統 Keychain 成功取得 threads-app-id: ${clientId}`);
    } else {
      console.log(`🔑 已從環境變數取得 threads-app-id: ${clientId}`);
    }
  } else {
    console.log('\n💡 提示：您可以登入 Meta for Developers 取得您的 App ID');
    const openMeta = (await question('是否直接為您在瀏覽器中開啟 Meta 我的應用程式頁面？(y/n): ')).trim().toLowerCase();
    if (openMeta === 'y' || openMeta === 'yes') {
      try {
        const startCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
        execSync(`${startCmd} "https://developers.facebook.com/apps/"`);
        console.log('✅ 已嘗試在瀏覽器中開啟 Meta for Developers。');
      } catch (e) {
        console.log('無法自動開啟瀏覽器，請手動前往 https://developers.facebook.com/apps/');
      }
    }
    clientId = (await question('請輸入您的 Threads App ID (Client ID): ')).trim();
  }

  if (clientSecret) {
    if (hasKeychainSecret) {
      console.log(`🔑 已從系統 Keychain 成功取得 threads-app-secret (已自動填入)`);
    } else {
      console.log(`🔑 已從環境變數取得 threads-app-secret (已自動填入)`);
    }
  } else {
    clientSecret = (await question('請輸入您的 Threads App Secret (Client Secret): ')).trim();
  }

  if (!clientId || !clientSecret) {
    console.error('錯誤：App ID 與 App Secret 為必填欄位！');
    rl.close();
    process.exit(1);
  }

  // 詢問是否存入 macOS Keychain 或寫回 .env
  if (process.platform === 'darwin') {
    const user = process.env.USER || 'default';
    if (!hasKeychainId && clientId) {
      const saveId = (await question('\n偵測到系統 Keychain 中尚未儲存 Threads App ID，是否將其存入系統 Keychain？(y/n): ')).trim().toLowerCase();
      if (saveId === 'y' || saveId === 'yes') {
        try {
          execSync(`security add-generic-password -s "threads-app-id" -a "${user}" -w "${clientId}" -U`);
          hasKeychainId = true;
          updateEnvFile('THREADS_APP_ID', '$(security find-generic-password -a "$USER" -s "threads-app-id" -w 2>/dev/null)');
          console.log('✅ 已成功將 App ID 儲存至 macOS Keychain，並將對應指令寫回 .env。');
        } catch (err) {
          console.error('❌ 儲存至 Keychain 失敗：', err.message);
          updateEnvFile('THREADS_APP_ID', clientId);
          console.log('已將明文 App ID 寫回 .env。');
        }
      } else {
        updateEnvFile('THREADS_APP_ID', clientId);
        console.log('已將明文 App ID 寫回 .env。');
      }
    }

    if (!hasKeychainSecret && clientSecret) {
      const saveSecret = (await question('偵測到系統 Keychain 中尚未儲存 Threads App Secret，是否將其存入系統 Keychain？(y/n): ')).trim().toLowerCase();
      if (saveSecret === 'y' || saveSecret === 'yes') {
        try {
          execSync(`security add-generic-password -s "threads-app-secret" -a "${user}" -w "${clientSecret}" -U`);
          hasKeychainSecret = true;
          updateEnvFile('THREADS_APP_SECRET', '$(security find-generic-password -a "$USER" -s "threads-app-secret" -w 2>/dev/null)');
          console.log('✅ 已成功將 App Secret 儲存至 macOS Keychain，並將對應指令寫回 .env。');
        } catch (err) {
          console.error('❌ 儲存至 Keychain 失敗：', err.message);
          updateEnvFile('THREADS_APP_SECRET', clientSecret);
          console.log('已將明文 App Secret 寫回 .env。');
        }
      } else {
        updateEnvFile('THREADS_APP_SECRET', clientSecret);
        console.log('已將明文 App Secret 寫回 .env。');
      }
    }
  } else {
    // 非 macOS 環境，直接寫回 .env
    updateEnvFile('THREADS_APP_ID', clientId);
    updateEnvFile('THREADS_APP_SECRET', clientSecret);
    console.log('✅ 已將明文 App ID 與 App Secret 寫入 .env。');
  }

  const authUrl = `https://threads.net/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=threads_basic,threads_content_publish,threads_manage_insights,threads_read_replies&response_type=code`;

  console.log(`\n-------------------------------------------------------------`);
  console.log(`正在為您在預設瀏覽器中開啟授權網址...`);
  console.log(`若瀏覽器未自動開啟，請手動複製以下網址開啟：`);
  console.log(`-------------------------------------------------------------`);
  console.log(authUrl);
  console.log(`-------------------------------------------------------------\n`);

  try {
    const startCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
    execSync(`${startCmd} "${authUrl}"`);
  } catch (e) {
    // 靜態忽略瀏覽器開啟失敗的錯誤，使用者仍可手動複製
  }
  
  console.log('【授權操作指引】');
  console.log('1. 開啟上方網址並同意授權。');
  console.log('2. 授權完成後，瀏覽器會嘗試跳轉至 https://localhost:3000/auth/callback?code=... ');
  console.log('   (此時網頁顯示「無法連線」或「連線不安全」是正常現象，請勿擔心！)');
  console.log('3. 請直接複製瀏覽器上方網址列的「完整 URL」，並貼在下方輸入欄中。\n');
  console.log('💡 備用方案提示：如果重新導向設定一直遇到 URL Blocked 錯誤，您可以按 Ctrl+C 中斷腳本，');
  console.log('   改用 Graph API Explorer (https://developers.facebook.com/tools/explorer/) 取得短期 Token，');
  console.log('   並執行 "npm run exchange-token" 來快速完成 60 天 Token 的設定。\n');

  const callbackUrlInput = (await question('請貼上重導向後的完整 URL: ')).trim();

  if (!callbackUrlInput) {
    console.error('錯誤：未輸入重導向 URL！');
    rl.close();
    process.exit(1);
  }

  let code = '';
  try {
    const parsedUrl = new URL(callbackUrlInput);
    code = parsedUrl.searchParams.get('code');
  } catch (e) {
    // 嘗試直接從字串中擷取 code
    const match = callbackUrlInput.match(/[?&]code=([^&#]+)/);
    if (match) {
      code = match[1];
    }
  }

  if (!code) {
    if (callbackUrlInput.includes('error_message') || callbackUrlInput.includes('error_code')) {
      console.error('\n❌ 授權失敗！偵測到 Meta 傳回錯誤訊息：');
      try {
        const errorUrl = new URL(callbackUrlInput);
        const errMsg = errorUrl.searchParams.get('error_message');
        const errCode = errorUrl.searchParams.get('error_code');
        console.error(`   - 錯誤代碼 (Error Code): ${errCode}`);
        console.error(`   - 錯誤原因 (Error Message): ${errMsg}`);
        
        if (errCode === '1349168') {
          console.error('\n👉 排查與設定指引 (Error Code 1349168):');
          console.error('   這代表您的 Redirect URI 尚未被您的 Meta App 後台認可。');
          console.error('   1. 請前往左側選單的 「Use cases」 (使用案例) > 點選 「Threads API」 > 點選 「Customize」 或 「Settings」。');
          console.error('   2. 確保在 「Valid OAuth Redirect URIs」 填入: https://localhost:3000/auth/callback');
          console.error('   3. 請注意！填入後必須點擊下拉選單的建議值（讓它變成藍色/灰色氣泡 Tag），並點選右下角的「儲存變更」才會生效。');
        }
      } catch (e) {
        console.error(`   ${callbackUrlInput}`);
      }
      console.error('\n💡 提示：如果重新導向設定一直無法生效，您可以：');
      console.error('   1. 開啟 https://developers.facebook.com/tools/explorer/ 取得短期 Token。');
      console.error('   2. 在終端機執行 "npm run exchange-token"，將該短期 Token 交換為 60 天長期 Token。');
    } else {
      console.error('錯誤：無法從輸入的 URL 中解析出 authorization code。請確認複製了完整的網址。');
    }
    rl.close();
    process.exit(1);
  }

  // 移除 Meta 可能附加在尾端的 #_
  const cleanedCode = code.replace(/#_$/, '');

  console.log('\n[1/3] 已成功解析 Authorization Code。');
  console.log('正在向 Threads API 交換短期 Access Token...');

  try {
    const params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
    params.append('grant_type', 'authorization_code');
    params.append('redirect_uri', REDIRECT_URI);
    params.append('code', cleanedCode);

    const shortLivedRes = await axios.post('https://graph.threads.net/oauth/access_token', params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const shortLivedToken = shortLivedRes.data.access_token;
    const userId = shortLivedRes.data.user_id;

    console.log(`\n[2/3] 成功取得短期 Access Token (User ID: ${userId})。`);
    console.log('正在向 Threads API 交換長期 Access Token (60 天效期)...');

    const longLivedRes = await axios.get('https://graph.threads.net/access_token', {
      params: {
        grant_type: 'th_exchange_token',
        client_secret: clientSecret,
        access_token: shortLivedToken
      }
    });

    const longLivedToken = longLivedRes.data.access_token;
    const expiresIn = longLivedRes.data.expires_in;

    console.log(`\n[3/3] 成功取得長期 Access Token！`);
    console.log(`有效期 (秒): ${expiresIn} (約 60 天)`);
    console.log(`\n您的 Threads Access Token 如下：`);
    console.log(`----------------------------------------`);
    console.log(longLivedToken);
    console.log(`----------------------------------------\n`);

    const envPath = path.join(process.cwd(), '.env');
    
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    const tokenRegex = /^THREADS_ACCESS_TOKEN=.*$/m;
    let newEnvContent = '';
    
    if (tokenRegex.test(envContent)) {
      newEnvContent = envContent.replace(tokenRegex, `THREADS_ACCESS_TOKEN=${longLivedToken}`);
      console.log(`已在現有的 .env 檔案中更新 THREADS_ACCESS_TOKEN。`);
    } else {
      newEnvContent = envContent + `\nTHREADS_ACCESS_TOKEN=${longLivedToken}\n`;
      console.log(`已在 .env 檔案中新增 THREADS_ACCESS_TOKEN。`);
    }

    fs.writeFileSync(envPath, newEnvContent.trim() + '\n', 'utf8');
    console.log(`成功儲存 Access Token 至 ${envPath}`);

    // macOS Keychain 儲存功能
    if (process.platform === 'darwin') {
      const saveKeychain = (await question('\n偵測到 macOS 環境，是否將 Long-lived Token 存入系統 Keychain (服務名稱: threads-access-token)? (y/n): ')).trim().toLowerCase();
      if (saveKeychain === 'y' || saveKeychain === 'yes') {
        try {
          const user = process.env.USER || 'default';
          execSync(`security add-generic-password -s "threads-access-token" -a "${user}" -w "${longLivedToken}" -U`);
          console.log('✅ 已成功將 Token 儲存至 macOS Keychain。');
          
          // 同時修改其於 .env 裡面的值
          updateEnvFile('THREADS_ACCESS_TOKEN', '$(security find-generic-password -a "$USER" -s "threads-access-token" -w 2>/dev/null)');
          console.log('✅ 已成功將 .env 中的 THREADS_ACCESS_TOKEN 更新為 Keychain 讀取指令。');
        } catch (keychainErr) {
          console.error('❌ 儲存至 Keychain 失敗：', keychainErr.message);
        }
      }
    }
    
  } catch (err) {
    console.error('\n錯誤：取得 Token 失敗！');
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
