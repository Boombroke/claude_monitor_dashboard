# ccmon — 本地 Claude Code 会话监控 + 通知中心

一眼看清本机上所有 `claude` CLI 会话的状态：谁在**干活**、谁卡在**等你审批**、谁**跑完了等你看**、谁**空闲**。当会话「需要你」时，桌面弹通知，手机收 [ntfy](https://ntfy.sh) 推送。

> Watch every local Claude Code session at a glance and get pinged when one needs approval, finishes, or is waiting on you.

## 为什么

平时同时开很多个 `claude` 会话时，很难分辨哪个在跑、哪个卡住等审批、哪个已经完成。ccmon 是一个**轻量的本地服务 + Web/PWA 界面**，实时汇总本机所有会话状态，并在关键时刻通知你 —— 包括推到手机。

## 特点

- **零配置监控**：直接读 `~/.claude/sessions/*.json` 的实时 `status`（busy/idle/waiting），不装任何 hook 就能用。
- **多端查看**：本地服务提供 Web 界面，可装成 PWA；同一局域网内手机浏览器扫码即可访问，离网靠 ntfy 推送兜底。
- **只读安全**：只观察不操作，默认绑 `127.0.0.1`，绝不读取 `ide/*.lock`、`daemon/control.key` 等含密钥的文件。
- **精准通知**：需审批 / 已完成 / 等你输入 三类事件，带去重、限流、合并与「你正盯着终端时不打扰」的存在感抑制。
- **历史留存**：状态转移与通知持久化到本地 SQLite，重启后仍可回看每个会话的时间线。

## 快速开始

```bash
git clone git@github.com:Boombroke/claude_monitor_dashboard.git
cd claude_monitor_dashboard
npm install
node src/cli.ts start          # 或 npm start
```

打开 `http://127.0.0.1:7420` 即可看到本机所有 Claude 会话的实时卡片。**无需任何配置**。

> 需要 Node.js ≥ 22（用其内置的 TypeScript 直跑与 `node:sqlite`，无编译步骤）。

## 命令

```bash
ccmon start                       # 启动监控服务（默认 http://127.0.0.1:7420）
ccmon start --lan --token <T>     # 绑局域网，手机可访问（强制 token）
ccmon start --ntfy-topic <topic>  # 启用 ntfy 手机推送
ccmon status                      # 一次性打印当前会话状态（不起服务）
ccmon doctor                      # 环境体检
ccmon install-hooks --dry-run     # 预览要写入 ~/.claude/settings.json 的 hook（不写盘）
ccmon install-hooks               # 安装 hook（先自动备份，无损合并）
ccmon uninstall-hooks             # 移除本工具写入的 hook
```

## 状态检测怎么工作

- **零配置**：读 `~/.claude/sessions/<pid>.json` 的实时 `status`（`busy`→工作中、`idle`→空闲/完成、`waiting`→等待），配合 transcript 末尾的完成标记（`turn_duration`/`away_summary`/`end_turn`）判定「已完成等你」。
- **可选 hook 增强**（`ccmon install-hooks`）：`Notification`(permission_prompt/idle_prompt) + `Stop` hook 用 `async` curl 无阻塞地把事件 POST 给本地守护进程，给出更低延迟、更精确的「需审批 / 等你输入」信号。
  - 注意：以 `--dangerously-skip-permissions` 运行的会话不会触发审批弹窗，此时靠文件 `waiting` 状态兜底。

## 手机通知（ntfy）

```bash
ccmon start --ntfy-topic ccmon-<你的随机字符串>
```

在手机装 [ntfy app](https://ntfy.sh) 并订阅同名 topic。当会话进入「需要你」状态（需审批 / 等你输入）时，手机即收到推送。默认只推「需要你」类；「已完成」是否推送可配置。

## 局域网访问（手机）

```bash
ccmon start --lan --token <你的token>
```

同一 WiFi 下手机浏览器访问 `http://<Mac的LAN-IP>:<端口>/?token=<token>`。启动时会打印该地址；浏览器打开 `/api/pairing` 可看到二维码，手机扫码直接带 token 访问。离网时不建隧道，靠 ntfy 推送兜底。

## 安全 / 隐私

- 默认绑 `127.0.0.1`；`--lan` 才对外，且强制 bearer token。
- 绝不读取或记录 `~/.claude/ide/*.lock`、`~/.claude/daemon/control.key`（含密钥）。
- UI/通知只显示低敏字段（会话名、项目、状态、标题、模型、截断的提示词）；`--redact` 可只显状态+项目。

## 技术栈

Node.js + TypeScript（免编译直跑）· Fastify · chokidar（文件监听）· SSE（实时推送）· 原生 vanilla JS PWA（无构建步骤）· `node:sqlite`（历史）· ntfy（手机推送）

## 里程碑

- **M1** ✅ 零配置文件监听仪表盘（busy/idle/done + DEAD 检测）
- **M2** ✅ hook 接收 + 桌面/ntfy 通知（去重/限流/合并/存在感抑制）
- **M3** ✅ PWA 升级（时间线/过滤/搜索/静音/安装）+ SQLite 历史 + LAN 二维码配对
  - Web Push 已评估后跳过：手机推送由 ntfy 覆盖，且本地 HTTP 下浏览器 push 受限。

## 开发

```bash
npm run typecheck    # tsc 类型检查
npm test             # node:test 全量单测
npm run dev          # 带 --watch 的开发模式
```

## License

MIT
