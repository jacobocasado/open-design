# Open Design WebUI

跨平台、终端启动的 Open Design Web 运行时（无 Electron）。

## 前置条件
- 已安装 Node.js 24+（`node --version`）。

## 启动 / 停止
- mac/Linux：`./open-design.sh start`，停止 `./open-design.sh stop`
- Windows：`open-design.cmd start`，停止 `open-design.cmd stop`
- 双击：mac `Open Design WebUI.command`、Windows `Open Design WebUI.bat`、Linux `open-design-webui.desktop`

`start` **默认在后台运行**：打印访问地址后即返回，关闭终端或 Ctrl+C 都不会停止服务；停止请用 `stop`。若想前台运行（systemd / Docker / 调试，Ctrl+C 即停），加 `--foreground`。检测到图形界面时自动打开浏览器；无图形界面（服务器）仅打印地址。

启动输出为多语言：默认跟随系统 `LANG`/`LC_*`，也可用 `--lang en|zh-CN` 或配置文件 `lang` 指定。

## 架构：为什么只有一个访问地址
本发行物是两进程（web + daemon），但你只需要 **web 地址**——就是终端打印的那个。`/api` 不是单独端口：web 服务器会把 `/api/*` **反代**到内部 daemon，所以浏览器/UI 用同一个地址即可，**不需要 token**。token 只用于**程序化直连 daemon API**。启动输出会说明这三点。

daemon 默认监听固定端口 `7457`（与 web 的 `7456` 对应，重启稳定），绑定在与 web 相同的 host 上；仅当你要直连 daemon API 时才需要它的地址。

## 配置（优先级：命令行 > webui.config.json > 环境变量 > 默认）
- `--port <N>`（默认 7456）：浏览器访问端口（web）
- `--daemon-port <N>`（默认 7457）：daemon 监听端口；填 `0` 改为随机环回端口
- `--host <ADDR>`（默认 127.0.0.1；填 `0.0.0.0` 开启远程访问，启动输出会显示可访问的局域网 IP）
- `--token <T>`：保护**直连** daemon `/api`（程序化客户端用 `Authorization: Bearer <T>`）；远程 host 且未设 token 时会自动生成并写回 `webui.config.json`，重启复用
- `--no-open`：不自动打开浏览器
- `--foreground`：前台运行（默认后台），Ctrl+C 即停
- `--lang <en|zh-CN>`：启动输出语言（默认跟随系统）
- `--config <PATH>`：指定配置文件

**首次 `start` 会自动在脚本同级目录创建 `webui.config.json`**（复制 `webui.config.example.json`，没有则写入默认值）；已存在则不覆盖。可直接编辑它持久化配置。配置键：`port`（web 端口）、`daemonPort`（daemon 端口，`0` = 随机环回）、`host`、`token`、`openBrowser`、`lang`（启动输出语言），以及两个可选键 `namespace`（运行时命名空间，隔离多实例）与 `dataDir`（覆盖数据目录，等价 `OD_DATA_DIR`）。

## 安全提示
开启远程访问（`host=0.0.0.0`）时，token 仅保护直连 daemon API 的程序化客户端；**Web UI 自身不做应用层鉴权**。如需保护远程 Web UI，请在前面架设反向代理（nginx/caddy basic-auth）或使用 VPN / 网络隔离。
