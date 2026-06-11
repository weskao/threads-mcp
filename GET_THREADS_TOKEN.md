# 🧵 Threads API Access Token 取得指南

本指南將引導您從頭開始設定 Meta 開發者帳號、建立 App，並使用我們為您編寫的自動化輔助腳本，成功取得 60 天有效期的 Threads 長期 Access Token，並自動寫入專案的 `.env` 檔案中。

---

## 📋 第一階段：Meta 開發者設定與 App 初始化

Threads API 串接必須透過 Meta 開發者平台進行。請依循以下步驟完成基礎設定：

> [!TIP]
> 💡 跨平台金鑰庫快速自動帶入秘訣  
> 您可以預先將憑證存入系統的安全儲存區，執行 `npm run get-token`（或 `npm run exchange-token`）時，腳本會**自動從系統安全金鑰庫取得憑證並帶入**，不需再手動輸入與詢問！
> 
> * **macOS**:
>   ```bash
>   security add-generic-password -s "threads-app-id" -a "$USER" -w "您的_APP_ID"
>   security add-generic-password -s "threads-app-secret" -a "$USER" -w "您的_APP_SECRET"
>   ```
> * **Windows (PowerShell)**:
>   ```powershell
>   $v = New-Object Windows.Security.Credentials.PasswordVault
>   $v.Add((New-Object Windows.Security.Credentials.PasswordCredential('threads-mcp', 'threads-app-id', '您的_APP_ID')))
>   $v.Add((New-Object Windows.Security.Credentials.PasswordCredential('threads-mcp', 'threads-app-secret', '您的_APP_SECRET')))
>   ```
> * **Linux (Secret Service)**:
>   ```bash
>   echo -n "您的_APP_ID" | secret-tool store --label="Threads MCP App ID" application threads-mcp service threads-app-id
>   echo -n "您的_APP_SECRET" | secret-tool store --label="Threads MCP App Secret" application threads-mcp service threads-app-secret
>   ```
4. 輸入或自動帶入憑證後，腳本會輸出一個 **授權網址**：
   ```text
   https://threads.net/oauth/authorize?client_id=...&redirect_uri=https://localhost:3000/auth/callback...
   ```
5. **複製該網址並在瀏覽器中開啟**，然後登入您已接受測試人員邀請的 Threads 帳號，並同意授權。
6. 授權完成後，瀏覽器會嘗試跳轉至 `https://localhost:3000/auth/callback?code=...`：
   * 由於本地可能沒有啟用 HTTPS 伺服器，**網頁顯示「無法連線」或「連線不安全」是正常現象，請勿擔心！**
7. **直接複製瀏覽器上方網址列的「完整 URL」**（必須包含 `code=` 參數）。
8. 將複製的完整 URL 貼回終端機的輸入欄位中，然後按下 Enter。
9. 腳本會自動完成以下步驟：
   - 解析出 authorization code。
   - 向 Threads API 交換短期 Access Token。
   - 用短期 Token 換取 **60 天有效的長期 Access Token**。
   - 自動將該長期 Token 寫入專案根目錄下的 `.env` 檔案中。

   **瀏覽器授權畫面參考截圖：**
   ![Threads OAuth Consent Screen](docs/images/threads_oauth_consent.png)

---

### 🔹 方案 B：使用 Graph API Explorer（免設定 localhost，初次設定最快 ⚡，對 Windows 友善）

此方案不需設定任何本機重導向 (Redirect URI) 或 Uninstall / Delete 回呼網址。只要在 Meta 提供的網頁工具中取得短期 Token，即可透過腳本快速完成長期 Token 的交換。

#### 執行步驟：
1. 前往 [Meta Graph API Explorer](https://developers.facebook.com/tools/explorer/) 並在右上角切換至您的 Threads App。
2. 點擊 **「Generate Access Token」** 取得短期 Token（效期約 1~2 小時）。
   ![Graph API Explorer 設定與 Generate](docs/images/graph_explorer_token.png)
3. 開啟終端機，確保路徑位於 `threads-mcp` 專案根目錄下。
4. 執行以下命令來啟動交換腳本：
   ```bash
   npm run exchange-token
   ```
5. 腳本會提示您輸入：
   - **Threads App Secret (Client Secret)**
   - **在 Explorer 取得的短期 Token**
6. 腳本會自動向 Threads API 發送請求，完成交換，並將 60 天長期的 Token 自動寫入 `.env` 檔案中。

---

## 🔑 跨平台安全功能：儲存至系統金鑰庫

不論您是執行 **方案 A** 還是 **方案 B**，在支援的系統（macOS、Windows、Linux）下，當腳本成功取得長期 Token 後皆會主動詢問：
> `是否將 Long-lived Token 存入系統安全金鑰庫中以提高安全性？(y/n):`

若您輸入 `y`，腳本會自動在背景將 Token 安全地寫入您的系統安全金鑰庫（如 macOS Keychain、Windows PasswordVault、Linux Secret Service），並將 `.env` 中的對應變數設為安全的動態讀取指令，確保您的 Token 擁有系統層級的安全加密保護。

---

## 🔍 第三階段：驗證您的設定

完成 Token 設定後，建議透過以下兩種方式驗證您的設定是否成功：

### 1. 使用官方工具線上驗證
您可以前往 Meta 官方的 [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/)，將取得的 Long-lived Token 貼入進行偵錯，以確認：
* **Expires (有效期限)** 是否顯示為約 60 天（而非僅有 1~2 小時）。
* **Scopes (權限範圍)** 是否已包含 `threads_basic`, `threads_content_publish`, `threads_manage_insights`, `threads_read_replies` 等必要權限。

### 2. 執行本機專案驗證
在專案目錄下執行：
```bash
# 執行專案驗證
npx tsx src/index.ts
```
確認終端機沒有出現認證錯誤後，您的 Threads MCP 伺服器即可正常運行！

---

## 🛠️ 實用工具：驗證 Token 狀態與效期

如果您想隨時檢查手邊 Token 的剩餘時間、權限範圍或是否有效，可以使用 Meta 官方提供的偵錯工具：

* **工具名稱**：Access Token Debugger (存取權杖偵錯工具)
* **工具網址**：[Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/)
* **主要用途**：
  1. **檢查過期時間 (Expires)**：確認您的長期 Token 是否仍有足夠的使用天數（應顯示為約 60 天），或是否已經過期。
  2. **確認權限範圍 (Scopes)**：檢查 Token 是否包含 `threads_basic`、`threads_content_publish`、`threads_manage_insights`、`threads_read_replies` 等必要權限。
  3. **偵測狀態 (Valid)**：查看 Token 是否為有效狀態（True），若 Token 已被手動撤銷或過期，此處會顯示錯誤原因。

---

## 💡 常見錯誤排查 (Troubleshooting)

* **OAuth Error / Redirect URI Mismatch**: 請確認 Meta Developers 平台中的「Valid OAuth Redirect URIs」是否精確填寫為 `https://localhost:3000/auth/callback`，且沒有多餘的斜線或空格。
* **User is not a tester**: 請確認您已在手機的 Threads App 設定中「接受」了邀請，否則 Meta 會拒絕該帳號的 OAuth 授權。
