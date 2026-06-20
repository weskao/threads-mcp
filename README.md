# 🧵 Threads MCP Server — 強化版 Fork Project

> Fork of [baguskto/threads-mcp](https://github.com/baguskto/threads-mcp)。
> 在原本的 Threads MCP 伺服器之上，新增**本地圖片／影片發文**、**常駐 HTTP 模式**、
> **Token 自動續期**、**發文記錄**，以及一份完整的**繁體中文安裝指南**。
>
> 🖥️ 支援平台：**macOS · Linux · Windows**
>
> 📖 原作者的完整工具與 API 參數說明請見 **[README.upstream.md](README.upstream.md)**。

---

## ⚡ 快速開始

完整流程（取得 Token、掛載到 Claude、常駐服務、ngrok）請看 **[SETUP.md](SETUP.md)**。

```bash
npm install
npm run build              # 編譯 TypeScript → dist/（啟動伺服器前必跑）
npm run get-token          # 取得 60 天長期 Threads Token（或 npm run exchange-token）
npm run setup-mcp          # 掛載到 Claude Desktop / Claude Code
npm run install-autostart  # （選用）安裝常駐 HTTP 服務並開機自啟
```

> 💡 `npm run build` 會把 `src/` 編譯到 `dist/index.js`，是啟動伺服器的前置步驟。`npm run setup-mcp` 與 `npm run install-autostart` 在偵測不到 `dist/index.js` 時會自動先跑一次 `npm run build`。

---

## ✨ 這個 Fork 多了什麼

相對於上游，本 fork 額外提供：

### 📸 本地圖片／影片發文

- `publish_thread_local_image`：直接指定**本機檔案路徑**發佈圖文，無需事先上傳至外部圖床。
- 背景啟動暫時的本地 HTTP 伺服器供 Threads API 取圖，發文完成後自動關閉。
- NAT／防火牆環境會自動偵測並透過 **ngrok** 對外轉發（`npm run ngrok-images`）。

### 🖥️ 常駐 HTTP 伺服器模式（多 IDE 共用）

- 預設改為 **Streamable HTTP** 常駐模式：整台機器只跑一個行程，所有 IDE 共用 `http://127.0.0.1:8307/mcp`。
- 一鍵安裝開機自啟：`npm run install-autostart`（macOS launchd／Linux systemd／Windows Task Scheduler）。
- 只綁定 `127.0.0.1`、不對外網開放，並啟用 **DNS-rebinding 防護**（驗證 `Host`／`Origin`，僅放行 loopback）。
- 仍可用 `--stdio` 切回「每個 IDE 各自啟動」的模式（stdio 用戶端設定務必在 `dist/index.js` 後加 `--stdio`）。

### 🔄 Token 60 天自動續期

- 常駐服務定時檢查，在效期 ≤ 10 天時自動續期；另搭配系統排程作為雙保險。
- 手動觸發：`npm run refresh-token`（加 `-- --force` 立即續期）。
- 取得後可用 [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/) 確認效期與權限（詳見 [SETUP.md](SETUP.md)）。

### 📝 發文記錄

- 已發佈貼文自動寫入 `docs/published_posts_log.jsonl`（含 post id、發佈時間、圖片清單）。

### 🛠️ 開發者便利工具

- 繁體中文安裝指南 **[SETUP.md](SETUP.md)**。
- `npm run customize-docs`：把文件中的 `<your_app_id>` 佔位符換成你的真實 ID，輸出個人專用 `SETUP.local.md`（已加入 `.gitignore`，不進版控）。
- 跨平台 `npm run` 腳本（Windows／macOS／Linux 皆可）：`npm run use-http`、`use-stdio`、`ps-check`、`kill-stale`、`config-check`…；macOS／Linux 另有同名 `make` 捷徑。

---

## 🧰 指令

- 入門 5 步見上方〈快速開始〉。
- 服務管理、Claude 設定切換（HTTP／stdio）、ngrok、診斷等**完整指令對照**見 **[SETUP.md](SETUP.md)** 的〈跨平台指令對照〉。
- 跨平台一律用 `npm run …`（**Windows／macOS／Linux 皆適用**）；macOS／Linux 可用同名 `make` 捷徑（如 `make build`、`make use-http`），Windows 沒有 `make` 直接用 `npm run`。

---

## 📂 文件導覽

| 檔案                                     | 內容                                               |
| ---------------------------------------- | -------------------------------------------------- |
| [SETUP.md](SETUP.md)                     | 完整安裝、Token 取得、常駐服務、ngrok 設定（繁中） |
| [README.upstream.md](README.upstream.md) | 上游原始 README：完整工具清單與 API 參數           |

---

## 🙏 致謝

本專案 fork 自 [baguskto/threads-mcp](https://github.com/baguskto/threads-mcp)。
核心 Threads API 工具由原作者開發；本 fork 著重於部署體驗、Token 維運與本地發文流程。

## 📄 授權

MIT（與上游一致）。
