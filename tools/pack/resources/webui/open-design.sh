#!/usr/bin/env sh
# Open Design WebUI 启动器外壳。校验 Node 24 后转发到 webui-launcher。
set -e
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENTRY="$SCRIPT_DIR/app/node_modules/@open-design/packaged/dist/webui-launcher.mjs"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请安装 Node 24 后重试：https://nodejs.org" >&2
  exit 1
fi
MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 24 ]; then
  echo "需要 Node 24+，当前为 $(node --version)。请升级后重试。" >&2
  exit 1
fi
export OD_RESOURCE_ROOT="$SCRIPT_DIR/app/resources/open-design"
# Install root holding the launcher scripts + webui.config(.example).json, so
# the launcher discovers/scaffolds config independent of the caller's cwd.
export OD_WEBUI_HOME="$SCRIPT_DIR"
exec node "$ENTRY" "$@"
