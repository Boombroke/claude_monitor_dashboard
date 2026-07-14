/**
 * index.ts — 组装并启动 ccmon 守护进程。
 *
 * 接线：config → store → reconciler → manager → sessionsWatcher + transcriptTailer
 *        + liveness reaper + notifier(desktop/ntfy) → http(SSE + REST + hooks 接收)。
 */

import type { Config, HookPayload, NotificationChannel } from './types.ts';
import { InMemorySessionStore } from './core/store.ts';
import { DefaultReconciler } from './core/reconciler.ts';
import { SessionManager } from './core/manager.ts';
import { SessionsWatcher } from './watch/sessionsWatcher.ts';
import { TranscriptTailer } from './watch/transcriptTailer.ts';
import { LivenessReaper } from './core/liveness.ts';
import { SseHub } from './server/sse.ts';
import { createHttpServer } from './server/http.ts';
import { Notifier } from './notify/notifier.ts';
import { DesktopChannel } from './notify/desktop.ts';
import { NtfyChannel } from './notify/ntfy.ts';

export interface RunningServer {
  url: string;
  stop: () => Promise<void>;
}

export async function startDaemon(cfg: Config): Promise<RunningServer> {
  const store = new InMemorySessionStore();
  const reconciler = new DefaultReconciler({ hookTtlMs: cfg.hookTtlMs });
  const hub = new SseHub();

  // transcript tailer：抽取标记喂给 manager。先声明，稍后由 manager 的
  // onTrack/onUntrack 驱动它跟踪/停止会话。
  const tailer = new TranscriptTailer(cfg, {
    onMarkers: (markers) => manager.onMarkers(markers),
  });

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
    broadcast: (view) => hub.broadcast({ type: 'notification', notification: view }),
  });

  // manager 需要 broadcast，而 http 需要 onHook（由 manager 提供）——先声明 manager。
  let onHookRef: (p: HookPayload) => void = () => {};
  const manager: SessionManager = new SessionManager({
    cfg,
    store,
    reconciler,
    notifier,
    broadcast: (event) => hub.broadcast(event),
    onTrack: (sessionId, sessionCwd) => tailer.track(sessionId, sessionCwd),
    onUntrack: (sessionId) => tailer.untrack(sessionId),
  });
  onHookRef = (p) => manager.onHook(p);

  const http = await createHttpServer({
    cfg,
    store,
    hub,
    onHook: (p) => onHookRef(p),
  });

  const watcher = new SessionsWatcher(cfg, {
    onUpsert: (snap) => manager.onFileSnapshot(snap),
    onRemove: (pid) => manager.onFileRemoved(pid),
  });

  const reaper = new LivenessReaper({
    intervalMs: 5_000,
    deadThreshold: 2,
    getPids: () => manager.livePids(),
    onDead: (pid) => manager.onPidDead(pid),
  });

  await tailer.start();
  await watcher.start();
  reaper.start();
  const url = await http.listen();

  return {
    url,
    async stop() {
      reaper.stop();
      await watcher.stop();
      await tailer.stop();
      await http.close();
    },
  };
}
