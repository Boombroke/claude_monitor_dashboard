/**
 * index.ts — 组装并启动 ccmon 守护进程。
 *
 * M1 接线：config → store → reconciler → manager → sessionsWatcher + liveness reaper
 *          → http(SSE + REST + hooks 接收) 。
 * notifier / transcriptTailer / hooks installer 作为叶子模块后续接入（见下方 TODO 挂载点）。
 */

import type { Config, HookPayload } from './types.ts';
import { InMemorySessionStore } from './core/store.ts';
import { DefaultReconciler } from './core/reconciler.ts';
import { SessionManager } from './core/manager.ts';
import { SessionsWatcher } from './watch/sessionsWatcher.ts';
import { LivenessReaper } from './core/liveness.ts';
import { SseHub } from './server/sse.ts';
import { createHttpServer } from './server/http.ts';

export interface RunningServer {
  url: string;
  stop: () => Promise<void>;
}

export async function startDaemon(cfg: Config): Promise<RunningServer> {
  const store = new InMemorySessionStore();
  const reconciler = new DefaultReconciler({ hookTtlMs: cfg.hookTtlMs });
  const hub = new SseHub();

  // manager 需要 broadcast，而 http 需要 onHook（由 manager 提供）——先声明 manager。
  let onHookRef: (p: HookPayload) => void = () => {};
  const manager = new SessionManager({
    cfg,
    store,
    reconciler,
    broadcast: (event) => hub.broadcast(event),
    // notifier: 叶子模块接入点（M2）
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

  await watcher.start();
  reaper.start();
  const url = await http.listen();

  return {
    url,
    async stop() {
      reaper.stop();
      await watcher.stop();
      await http.close();
    },
  };
}
