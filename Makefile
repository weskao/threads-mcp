# Makefile — Unix (macOS / Linux) convenience aliases over the npm scripts.
#
# Every target just delegates to `npm run …`; the real cross-platform logic
# lives in the Node scripts under scripts/ (single source of truth). Windows
# users — who have no make / POSIX shell — run the npm scripts directly, e.g.
# `npm run ps-check`, `npm run service-status`, `npm run use-http`.

.DEFAULT_GOAL := list

.PHONY: list help notify build clean dev lint start start-http start-stdio ngrok-images \
        install-service uninstall-service service-start service-stop service-status ps-check kill-stale \
        config-check use-http use-stdio get-token exchange-token setup-mcp

list:
	@echo "Available commands:"
	@echo ""
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {command=$$1; sub(/.*: /, "", command); gsub(/\\n/, "\n\t\t\t\t", $$2); printf "\033[36m%-32s\033[0m %s\n", "make " command, $$2}'
	@echo ""

help: list  ## 同 list，列出所有可用指令

notify: ## 發送通知（macOS 音效+橫幅；其他平台印至 console）\n必填：msg  可選：title（預設 Notification）、success（預設 true）\n範例：make notify msg="Build done" title="CI" success=false
	@npm run --silent notify -- "$(msg)" "$(if $(title),$(title),Notification)" "$(if $(success),$(success),true)"

# ── Build ─────────────────────────────────────────────────────────────────

build: ## 編譯 TypeScript → dist/
	npm run build

clean: ## 刪除 dist/（跨平台）
	npm run clean

dev: ## Watch 模式（tsx）
	npm run dev

lint: ## 僅型別檢查（tsc --noEmit）
	npm run lint

# ── Run ───────────────────────────────────────────────────────────────────

start: ## 在前景以 HTTP 模式執行（預設，port 8307）
	npm run start

start-http: ## 在前景以 HTTP 模式執行（port 8307，同 start）
	npm run start:http

start-stdio: ## 以 stdio 模式執行（每個 IDE 各自啟動）
	npm run start:stdio

ngrok-images: ## 啟動 ngrok tunnel（port 取自 .env，預設 51847）供 publish_thread_local_image 使用\n需先安裝 ngrok 並完成 authtoken 設定（見 SETUP.md）
	sh scripts/ngrok-images.sh

# ── Resident service（跨平台：launchd / systemd / Task Scheduler）──────────

install-service: build ## build + 安裝並啟動常駐服務（跨平台）
	npm run install-autostart
	@echo "✓ Service installed and started — register with: make use-http"

uninstall-service: ## 停止並移除常駐服務（跨平台）
	npm run uninstall-autostart

service-start: ## 啟動常駐服務
	npm run service-start

service-stop: ## 停止常駐服務
	npm run service-stop

service-status: ## 確認常駐服務狀態（含 :8307 監聽）
	npm run service-status

ps-check: ## 列出所有執行中的 threads-mcp 行程（偵測殭屍／重複 stdio 行程）
	npm run ps-check

kill-stale: ## 清掉所有 stdio 殘留行程（保留 --http 常駐行程）\n注意：MCP 設定仍指向 stdio 的 IDE，重連時會再 spawn — 請先 make use-http
	npm run kill-stale

# ── Claude MCP config ─────────────────────────────────────────────────────

config-check: ## 顯示目前 Claude user-scope 的 threads 設定（確認是 stdio 還是 http）
	npm run config-check

use-http: ## 將 Claude config 切換至 HTTP 模式（共用常駐行程，port 8307）
	npm run use-http

use-stdio: ## 將 Claude config 切回 stdio 模式（每個 IDE 各自啟動）
	npm run use-stdio

# ── Token & setup ─────────────────────────────────────────────────────────

get-token: ## 取得 / 更新 Threads 60 天 access token
	npm run get-token

exchange-token: ## 將短期 token 換成 60 天長期 token
	npm run exchange-token

setup-mcp: ## 互動式將 MCP server 登記至 Claude
	npm run setup-mcp
