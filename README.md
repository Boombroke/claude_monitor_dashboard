# ccmon — 本地 Claude Code 会话监控 + 通知中心

一眼看清本机上所有 `claude` CLI 会话的状态：谁在**干活**、谁卡在**等你审批**、谁**跑完了等你看**、谁**空闲**。当会话「需要你」时，桌面弹通知，手机收 [ntfy](https://ntfy.sh) 推送。

> Watch every local Claude Code session at a glance and get pinged when one needs approval, finishes, or is waiting on you.

## 为什么

平时同时开很多个 `claude` 会话时，很难分辨哪个在跑、哪个卡住等审批、哪个已经完成。ccmon 是一个**轻量的本地服务 + Web/PWA 界面**，实时汇总本机所有会话状态，并在关键时刻通知你 —— 包括推到手机。

## 特点

- **零配置监控**：直接读 `~/.claude/sessions/*.json` 的实时 `status`（busy/idle/waiting），不装任何 hook 就能用。
- **多端查看**：本地服务提供 Web 界面，可装成 PWA；同一局域网内手机浏览器也能看，离网靠 ntfy 推送兜底。
- **只读安全**：只观察不操作，默认绑 `127.0.0.1`，绝不读取 `ide/*.lock`、`daemon/control.key` 等含密钥的文件。
- **精准通知**：需审批 / 已完成 / 等你输入 三类事件，带去重、限流、合并与「你正盯着终端时不打扰」的存在感抑制。

## 状态

开发中。里程碑：

- **M1** ✅ 零配置文件监听仪表盘（busy/idle/done + DEAD 检测）
- **M2** ✅ hook 接收 + 桌面/ntfy 通知（去重/限流/合并/存在感抑制）
- **M3** 🚧 PWA 打磨 + 历史（SQLite）+ Web Push + LAN 二维码配对

## 技术栈

Node.js + TypeScript · Fastify · chokidar · SSE · Preact/Vite（PWA）· better-sqlite3（历史）

## 用法（规划中）

```bash
ccmon start                 # 启动监控服务（默认 http://127.0.0.1:7420）
ccmon status                # 查看当前会话状态
ccmon install-hooks --dry-run   # 预览要写入 ~/.claude/settings.json 的 hook（可选增强）
ccmon doctor                # 环境体检
```

## License

MIT
