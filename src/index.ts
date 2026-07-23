/**
 * index.ts — 组装并启动 ccmon 守护进程。
 *
 * 接线：config → store → hub(commit/debounce/fan-out) + notifier + history
 *        → 启用的 providers（各自 start(sink)）→ http(SSE + REST + /hooks + /ingest)。
 */

import type { AgentKind, Config, NotificationChannel } from './types.ts';
import { InMemorySessionStore } from './core/store.ts';
import { Hub } from './core/hub.ts';
import { SseHub } from './server/sse.ts';
import { createHttpServer } from './server/http.ts';
import { Notifier } from './notify/notifier.ts';
import { DesktopChannel } from './notify/desktop.ts';
import { NtfyChannel } from './notify/ntfy.ts';
import { History } from './db/history.ts';
import { PriorityStore } from './db/priorities.ts';
import type { Provider } from './providers/types.ts';
import { ClaudeProvider } from './providers/claude/provider.ts';
import { CodexProvider } from './providers/codex/provider.ts';
import { OpencodeProvider } from './providers/opencode/provider.ts';

export interface RunningServer {
  url: string;
  stop: () => Promise<void>;
}

export async function startDaemon(cfg: Config): Promise<RunningServer> {
  // 优先级持久化（JSON 文件）。失败不致命：降级为无持久化。
  let priorities: PriorityStore | undefined;
  try {
    priorities = new PriorityStore();
  } catch {
    priorities = undefined;
  }
  // store 首次物化会话时，从持久化回填用户指派的优先级（跨重启/DEAD 重建仍在）。
  const store = new InMemorySessionStore(
    priorities
      ? {
          hydrate: (k) => {
            const p = priorities!.get(k);
            return p ? { priority: p } : undefined;
          },
        }
      : {},
  );
  const sse = new SseHub();

  // 历史持久化（node:sqlite）。失败不致命：降级为无持久化。
  let history: History | undefined;
  try {
    history = new History();
  } catch {
    history = undefined;
  }

  // 通知渠道：桌面（受配置开关）+ ntfy（仅当配置了 topic）。
  const channels: NotificationChannel[] = [new DesktopChannel(cfg.desktopNotifications)];
  if (cfg.ntfy) {
    channels.push(
      new NtfyChannel({
        server: cfg.ntfy.server,
        topic: cfg.ntfy.topic,
        includeContext: cfg.ntfy.includeContext,
        ntfyOnDone: cfg.ntfyOnDone,
      }),
    );
  }
  const notifier = new Notifier(cfg, channels, {
    broadcast: (view) => {
      sse.broadcast({ type: 'notification', notification: view });
      history?.recordNotification(view);
    },
  });

  // 内核提交引擎：store 变更 → SSE 广播 + 通知 + 历史。
  const hub = new Hub({
    cfg,
    store,
    notifier,
    broadcast: (event) => sse.broadcast(event),
    onStateTransition: (session, from) =>
      history?.recordTransition(session.key, session.stateSince, from, session.state, session.attentionReason),
  });

  // 构建启用的 providers（claude 文件监听 · codex rollout 尾读 · opencode 插件推送）。
  const providers = new Map<AgentKind, Provider>();
  if (cfg.providers?.claude?.enabled ?? true) {
    providers.set('claude', new ClaudeProvider(cfg));
  }
  if (cfg.providers?.codex?.enabled) {
    providers.set('codex', new CodexProvider(cfg));
  }
  if (cfg.providers?.opencode?.enabled) {
    providers.set('opencode', new OpencodeProvider(cfg));
  }

  const http = await createHttpServer({
    cfg,
    store,
    hub: sse,
    dispatchPush: (agent, body) => providers.get(agent)?.onPush?.(body),
    ...(history ? { history } : {}),
    ...(priorities ? { priorities } : {}),
  });

  for (const [agent, provider] of providers) {
    await provider.start(hub.makeSink(agent));
  }
  const url = await http.listen();

  return {
    url,
    async stop() {
      for (const provider of providers.values()) await provider.stop();
      await http.close();
      history?.close();
    },
  };
}
