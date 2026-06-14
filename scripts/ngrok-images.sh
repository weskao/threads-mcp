#!/usr/bin/env sh
# Launch an ngrok tunnel to the local image server used by publish_thread_local_image.
#
# Port resolution (highest precedence first), mirroring src/index.ts:
#   1. LOCAL_IMAGE_SERVER_PORT environment variable
#   2. LOCAL_IMAGE_SERVER_PORT in the project .env file
#   3. Default 51847 (matches LOCAL_FILE_SERVER_DEFAULT_PORT in src/api/local-file-server.ts)
#
# Static domain (optional): set NGROK_URL=your-static-domain.ngrok-free.dev in .env
# or as an environment variable to pass --url=<domain> to ngrok.
#
# Note: the tunnel forwards to 127.0.0.1 (IPv4) on purpose. The local file
# server binds to 127.0.0.1 only; forwarding to "localhost" can resolve to
# IPv6 (::1) and fail with "connection refused".
set -eu

DEFAULT_PORT=51847
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
ENV_FILE="$PROJECT_ROOT/.env"

PORT=""
SOURCE=""
NGROK_DOMAIN=""

# Helper: read a variable value from .env file (last occurrence wins).
read_env_var() {
  local key="$1"
  if [ -f "$ENV_FILE" ]; then
    local line
    line=$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$ENV_FILE" | tail -n 1 || true)
    if [ -n "$line" ]; then
      local val
      val=${line#*=}
      # Strip surrounding whitespace, quotes, and a trailing CR (CRLF files).
      val=$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
        -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" -e 's/\r$//')
      printf '%s' "$val"
    fi
  fi
}

# 1. Shell environment variable takes precedence.
if [ -n "${LOCAL_IMAGE_SERVER_PORT:-}" ]; then
  PORT="$LOCAL_IMAGE_SERVER_PORT"
  SOURCE="env var"
fi

# 2. Otherwise read from .env.
if [ -z "$PORT" ]; then
  PORT=$(read_env_var LOCAL_IMAGE_SERVER_PORT)
  [ -n "$PORT" ] && SOURCE=".env"
fi

# 3. Fall back to the default.
if [ -z "$PORT" ]; then
  PORT="$DEFAULT_PORT"
  SOURCE="default"
fi

# Validate the resolved port is numeric.
case "$PORT" in
  ''|*[!0-9]*)
    echo "ngrok-images: resolved port '$PORT' is not numeric; using default $DEFAULT_PORT" >&2
    PORT="$DEFAULT_PORT"
    SOURCE="default"
    ;;
esac

# Resolve optional static ngrok domain (shell env var > .env).
if [ -n "${NGROK_URL:-}" ]; then
  NGROK_DOMAIN="$NGROK_URL"
else
  NGROK_DOMAIN=$(read_env_var NGROK_URL)
fi
# Strip protocol prefix and trailing slash if user accidentally included them.
NGROK_DOMAIN=$(printf '%s' "$NGROK_DOMAIN" | sed -e 's|^https\?://||' -e 's|/$||')

if ! command -v ngrok >/dev/null 2>&1; then
  echo "ngrok-images: 'ngrok' not found in PATH. Install it first (see SETUP.md)." >&2
  exit 127
fi

ADDR="127.0.0.1:$PORT"
if [ -n "$NGROK_DOMAIN" ]; then
  echo "ngrok-images: forwarding ngrok ($NGROK_DOMAIN) -> http://$ADDR (port from $SOURCE)" >&2
  exec ngrok http "--url=$NGROK_DOMAIN" "$ADDR"
else
  echo "ngrok-images: forwarding ngrok -> http://$ADDR (port from $SOURCE)" >&2
  exec ngrok http "$ADDR"
fi
