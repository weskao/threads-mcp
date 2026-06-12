PROJECT_DIR := $(shell pwd)
DIST_ENTRY  := $(PROJECT_DIR)/dist/index.js
HTTP_URL    := http://127.0.0.1:8307/mcp
PLIST       := $(HOME)/Library/LaunchAgents/com.threads-mcp.server.plist

# Inline shell utility functions ─ inject into any recipe with $(SHELL_UTILS);
define SHELL_UTILS
notify() { \
  local s="$$1" m="$$2" t="$${3:-Notification}"; \
  if [ "$$s" = "true" ]; then afplay /System/Library/Sounds/Glass.aiff 2>/dev/null; \
  else afplay /System/Library/Sounds/Basso.aiff 2>/dev/null; fi; \
  osascript -e "display notification \"$$m\" with title \"$$t\"" 2>/dev/null || true; \
}
endef

.DEFAULT_GOAL := list

.PHONY: list help notify build clean dev lint start start-http \
        install-service uninstall-service service-start service-stop service-status \
        use-http use-stdio get-token exchange-token setup-mcp

list:
	@echo "Available commands:"
	@echo ""
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {command=$$1; sub(/.*: /, "", command); gsub(/\\n/, "\n\t\t\t\t", $$2); printf "\033[36m%-32s\033[0m %s\n", "make " command, $$2}'
	@echo ""

help: list  ## 同 list，列出所有可用指令

notify: ## 發送系統音效 + macOS 通知\n必填：msg  可選：title（預設 Notification）、success（預設 true）\n範例：make notify msg="Build done" title="CI" success=false
	@$(SHELL_UTILS); notify "$(if $(success),$(success),true)" "$(msg)" "$(if $(title),$(title),Notification)"

# ── Build ─────────────────────────────────────────────────────────────────

build: ## 編譯 TypeScript → dist/
	npm run build

clean: ## 刪除 dist/
	npm run clean

dev: ## Watch 模式（tsx）
	npm run dev

lint: ## 僅型別檢查（tsc --noEmit）
	npm run lint

# ── Run ───────────────────────────────────────────────────────────────────

start: ## 以 stdio 模式執行（每個 IDE 各自啟動）
	npm run start

start-http: ## 在前景以 HTTP 模式執行（port 8307）
	npm run start:http

# ── macOS launchd service ─────────────────────────────────────────────────

install-service: build ## build + 安裝 + 啟動 launchd 常駐服務
	npm run install-autostart
	launchctl load $(PLIST)
	@echo "✓ Service installed and started"
	@echo "  Register with Claude: make use-http"

uninstall-service: ## 停止並移除 launchd 服務
	-launchctl unload $(PLIST) 2>/dev/null
	npm run uninstall-autostart

service-start: ## 啟動 launchd 服務（同 thmcp_load）
	launchctl load $(PLIST)

service-stop: ## 停止 launchd 服務（同 thmcp_unload）
	launchctl unload $(PLIST)

service-status: ## 確認服務在 :8307 上運行（同 thmcp_check）
	@launchctl list | grep threads-mcp && echo "---" && lsof -i :8307 | grep LISTEN \
	  || echo "Service not running"

# ── Claude MCP config ─────────────────────────────────────────────────────

use-http: ## 將 Claude config 切換至 HTTP 模式（共用常駐行程，port 8307）
	claude mcp add --transport http --scope user threads $(HTTP_URL)
	@echo "✓ Claude now uses HTTP: $(HTTP_URL)"
	@echo "  Restart Claude Code to apply"

use-stdio: ## 將 Claude config 切回 stdio 模式（每個 IDE 各自啟動）
	-claude mcp remove --scope user threads 2>/dev/null
	claude mcp add --scope user threads node -- $(DIST_ENTRY)
	@echo "✓ Claude now uses stdio: $(DIST_ENTRY)"
	@echo "  Restart Claude Code to apply"

# ── Token & setup ─────────────────────────────────────────────────────────

get-token: ## 取得 / 更新 Threads 60 天 access token
	npm run get-token

exchange-token: ## 將短期 token 換成 60 天長期 token
	npm run exchange-token

setup-mcp: ## 互動式將 MCP server 登記至 Claude
	npm run setup-mcp
