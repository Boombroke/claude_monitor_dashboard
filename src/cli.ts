#!/usr/bin/env node
/**
 * cli.ts — ccmon 命令行入口。
 *
 * 子命令：
 *   start   启动监控守护进程（默认）
 *   status  一次性打印当前会话状态（读文件，不起服务）
 *   doctor  环境体检（在叶子模块 hooks-cli 中完整实现，这里给最小版）
 *   install-hooks  写入 hook 配置（叶子模块 hooks-cli 实现）
 *
 * install-hooks / 完整 doctor 由 hooks-cli 叶子模块补全；此处保留占位与路由。
 */

import { loadConfig, type ConfigOverrides } from './config.ts';
import { startDaemon } from './index.ts';
import type { Config } from './types.ts';

interface ParsedArgs {
  command: string;
  overrides: ConfigOverrides;
  flags: Set<string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'start', ...rest] = argv;
  const overrides: ConfigOverrides = {};
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    switch (a) {
      case '--lan':
        overrides.lan = true;
        break;
      case '--redact':
        overrides.redact = true;
        break;
      case '--dry-run':
        flags.add('dry-run');
        break;
      case '--port':
        overrides.port = Number(rest[++i]);
        break;
      case '--host':
        overrides.host = rest[++i];
        break;
      case '--token':
        overrides.token = rest[++i];
        break;
      case '--ntfy-topic':
        overrides.ntfyTopic = rest[++i];
        break;
      default:
        flags.add(a);
    }
  }
  return { command, overrides, flags };
}

async function main(): Promise<void> {
  const { command, overrides, flags } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(overrides);

  switch (command) {
    case 'start': {
      const server = await startDaemon(cfg);
      process.stdout.write(`ccmon 已启动 → ${server.url}\n`);
      if (cfg.host === '0.0.0.0') {
        const { lanIPv4, pairingUrl } = await import('./server/net.ts');
        const ip = lanIPv4();
        if (ip) {
          process.stdout.write(`  LAN 访问（手机同一 WiFi）：${pairingUrl(ip, cfg.port, cfg.token)}\n`);
          const base = server.url.replace(/\/$/, '');
          process.stdout.write(`  扫码配对：浏览器打开 ${base}/api/pairing 查看二维码\n`);
        } else {
          process.stdout.write('  LAN：未检测到局域网 IPv4 地址\n');
        }
        if (cfg.token) process.stdout.write(`  token：${cfg.token}\n`);
      }
      process.stdout.write('  按 Ctrl-C 停止。\n');
      const shutdown = async () => {
        process.stdout.write('\n正在停止…\n');
        await server.stop();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
      break;
    }

    case 'status': {
      await printStatus(cfg);
      break;
    }

    case 'doctor': {
      const { runDoctor } = await import('./hooks/doctor.ts');
      const { ok, lines } = await runDoctor(cfg);
      process.stdout.write('ccmon doctor：\n' + lines.map((l) => '  ' + l).join('\n') + '\n');
      process.exit(ok ? 0 : 1);
      break;
    }

    case 'install-hooks': {
      const { installHooks } = await import('./hooks/installer.ts');
      const dryRun = flags.has('dry-run');
      const res = await installHooks(cfg, { dryRun, port: cfg.port, ...(cfg.token ? { token: cfg.token } : {}) });
      process.stdout.write(res.diff + '\n');
      if (dryRun) {
        process.stdout.write('（dry-run：未写入。去掉 --dry-run 实际安装。）\n');
      } else if (res.changed) {
        process.stdout.write(`已写入 ${cfg.settingsPath}${res.backupPath ? `（备份：${res.backupPath}）` : ''}\n`);
      } else {
        process.stdout.write('无变更（hooks 已是最新）。\n');
      }
      break;
    }

    case 'uninstall-hooks': {
      const { uninstallHooks } = await import('./hooks/installer.ts');
      const res = await uninstallHooks(cfg);
      if (res.changed) {
        process.stdout.write(`已移除 ccmon hooks${res.backupPath ? `（备份：${res.backupPath}）` : ''}\n`);
      } else {
        process.stdout.write('无 ccmon hooks 可移除。\n');
      }
      break;
    }

    default:
      process.stderr.write(
        `未知命令：${command}\n用法：ccmon [start|status|doctor|install-hooks|uninstall-hooks]\n`,
      );
      process.exit(1);
  }
}

/** status：直接读 sessions 目录打印一览（不起服务）。 */
async function printStatus(cfg: Config): Promise<void> {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { parseSessionFile } = await import('./watch/sessionsWatcher.ts');
  let files: string[] = [];
  try {
    files = (await readdir(cfg.sessionsDir)).filter((f) => f.endsWith('.json'));
  } catch {
    process.stdout.write('（无 sessions 目录或为空）\n');
    return;
  }
  const rows: string[] = [];
  for (const f of files) {
    try {
      const snap = parseSessionFile(await readFile(join(cfg.sessionsDir, f), 'utf8'));
      if (snap) {
        const wf = snap.waitingFor ? ` (${snap.waitingFor})` : '';
        rows.push(`  ${String(snap.pid).padEnd(7)} ${snap.status.padEnd(8)}${wf.padEnd(20)} ${snap.name}`);
      }
    } catch {
      /* skip */
    }
  }
  process.stdout.write(`Claude 会话（${rows.length}）：\n${rows.join('\n')}\n`);
}

main().catch((err) => {
  process.stderr.write(`ccmon 错误：${err?.stack ?? err}\n`);
  process.exit(1);
});
