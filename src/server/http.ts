/**
 * http.ts — Fastify 应用：静态 PWA + /events(SSE) + /api/* + /hooks。
 *
 * 鉴权：非 loopback（lan 模式）时，/api、/events、/hooks 一律校验 Bearer token
 * （或 ?token= 查询参，方便手机扫码带 token 访问 UI）。loopback 下默认放行。
 */

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { AgentKind, Config, Session, HookPayload, ServerEvent } from '../types.ts';
import type { SessionStore } from '../types.ts';
import { SseHub } from './sse.ts';
import { isSea, readAsset, contentTypeFor, PUBLIC_ASSETS } from './assets.ts';

/** 供 sse.ts 使用的最小 reply 形状。 */
export type ServerReply = FastifyReply;

/** 历史查询接口（由 db/history.History 实现；此处解耦声明避免直接耦合）。 */
export interface HistoryProvider {
  eventsFor(sessionId: string, limit?: number): unknown[];
  notificationsFor(sessionId: string, limit?: number): unknown[];
  stateDurations(sessionId: string): Record<string, number>;
}

export interface HttpDeps {
  cfg: Config;
  store: SessionStore;
  hub: SseHub;
  /** 收到 provider 推送（/hooks=claude、/ingest/:agent）时分发给对应 provider。 */
  dispatchPush: (agent: AgentKind, body: unknown) => void;
  /** 可选：持久化历史查询（M3）。 */
  history?: HistoryProvider;
  now?: () => number;
}

export interface HttpServer {
  listen: () => Promise<string>;
  close: () => Promise<void>;
  /** 供上层把 store/notifier 事件广播出去。 */
  broadcast: (event: ServerEvent) => void;
}

export async function createHttpServer(deps: HttpDeps): Promise<HttpServer> {
  const { cfg, store, hub, dispatchPush, history } = deps;
  const now = deps.now ?? Date.now;
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

  // —— 鉴权钩子（仅非 loopback 时强制） ——
  const requireAuth = cfg.lan && !!cfg.token;
  app.addHook('onRequest', async (req, reply) => {
    if (!requireAuth) return;
    if (req.url === '/health') return;
    if (isAuthorized(req, cfg.token!)) return;
    // 允许 UI 静态资源在带 ?token 时通过；否则 401。
    await reply.code(401).send({ error: 'unauthorized' });
  });

  // —— 静态 PWA ——
  // 开发模式从磁盘 public/ 读（@fastify/static）；SEA 单文件模式从嵌入资源读。
  if (isSea()) {
    // 单文件：为每个已知资源注册路由；`/` → index.html。
    for (const name of PUBLIC_ASSETS) {
      const route = name === 'index.html' ? '/' : `/${name}`;
      app.get(route, async (_req, reply) => {
        const buf = await readAsset(name);
        if (!buf) return reply.code(404).send({ error: 'not found' });
        return reply.header('Content-Type', contentTypeFor(name)).send(buf);
      });
    }
  } else {
    const { default: fastifyStatic } = await import('@fastify/static');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
    await app.register(fastifyStatic, { root: publicDir, prefix: '/' });
  }

  // —— 健康检查 ——
  app.get('/health', async () => ({ ok: true, time: now() }));

  // —— REST：会话列表 / 单会话时间线 ——
  app.get('/api/sessions', async () => ({ sessions: store.all() satisfies Session[] }));
  app.get('/api/sessions/:id/timeline', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = store.get(id);
    if (!s) return reply.code(404).send({ error: 'not found' });
    return { sessionId: id, events: s.events };
  });

  // —— 持久化历史（重启后仍可查）；未启用 history 时回退到内存时间线 ——
  app.get('/api/sessions/:id/history', async (req) => {
    const { id } = req.params as { id: string };
    if (!history) {
      const s = store.get(id);
      return { sessionId: id, events: s ? s.events : [], notifications: [], durations: {}, persisted: false };
    }
    return {
      sessionId: id,
      events: history.eventsFor(id),
      notifications: history.notificationsFor(id),
      durations: history.stateDurations(id),
      persisted: true,
    };
  });

  // —— 配对：LAN URL + 二维码（QR 模块可用时返回 SVG，否则仅 URL） ——
  app.get('/api/pairing', async (_req, reply) => {
    const { lanIPv4, pairingUrl } = await import('./net.ts');
    const ip = lanIPv4();
    if (!ip) return reply.code(404).send({ error: 'no LAN address' });
    const url = pairingUrl(ip, cfg.port, cfg.token);
    let svg: string | undefined;
    try {
      // 动态路径避免静态解析——QR 模块为可选增强，未构建时优雅降级为仅 URL。
      const qrPath = './qr.ts';
      const mod = (await import(qrPath)) as { qrSvg: (t: string) => string };
      svg = mod.qrSvg(url);
    } catch {
      svg = undefined; // QR 模块不可用/编码失败：仅返回 URL
    }
    if ((_req.query as Record<string, unknown> | undefined)?.format === 'svg' && svg) {
      return reply.header('Content-Type', 'image/svg+xml').send(svg);
    }
    return { url, ip, port: cfg.port, hasQr: !!svg, svg };
  });

  // —— ntfy 手机订阅配对：扫码一键订阅（不依赖 LAN，走公网推送）——
  app.get('/api/ntfy-pairing', async () => {
    if (!cfg.ntfy) return { enabled: false };
    const { server: ntfyServer, topic } = cfg.ntfy;
    // ntfy 深链：ntfy://<host>/<topic> 一扫即订阅（部分相机不认 → 附 https 兜底手动订阅）。
    const host = ntfyServer.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const secure = ntfyServer.startsWith('https');
    const deepLink = `ntfy://${host}/${topic}${secure ? '' : '?secure=false'}`;
    const webUrl = `${ntfyServer.replace(/\/+$/, '')}/${topic}`;
    let deepQr: string | undefined;
    let webQr: string | undefined;
    try {
      const qrPath = './qr.ts';
      const mod = (await import(qrPath)) as { qrSvg: (t: string) => string };
      deepQr = mod.qrSvg(deepLink);
      webQr = mod.qrSvg(webUrl);
    } catch {
      /* QR 不可用：仅返回 URL 文本 */
    }
    return { enabled: true, server: ntfyServer, topic, deepLink, webUrl, deepQr, webQr };
  });

  // —— 发一条测试推送，验证手机是否已订阅成功 ——
  app.post('/api/ntfy-test', async (_req, reply) => {
    if (!cfg.ntfy) return reply.code(409).send({ ok: false, reason: 'ntfy 未启用' });
    try {
      const url = `${cfg.ntfy.server.replace(/\/+$/, '')}/${cfg.ntfy.topic}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { Title: 'ccmon', Tags: 'white_check_mark', Priority: 'default' },
        body: 'ccmon 测试推送：如果你在手机上看到这条，说明订阅成功 ✅',
        signal: AbortSignal.timeout(5000),
      });
      return { ok: res.ok };
    } catch (e) {
      return reply.code(502).send({ ok: false, reason: String((e as Error).message) });
    }
  });

  // —— 进入会话：聚焦其终端标签页（macOS），或降级在 cwd 开新终端 ——
  // 注意：这是会改动桌面的副作用操作，LAN 模式下亦启用（用户已知悉）。
  app.post('/api/sessions/:id/focus', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = store.get(id);
    if (!s) return reply.code(404).send({ error: 'not found' });
    const { focusSession } = await import('./focus.ts');
    const result = await focusSession(s.pid, s.cwd);
    if (!result.ok) return reply.code(409).send({ ok: false, reason: result.reason });
    return { ok: true, method: result.method };
  });

  // —— SSE ——
  app.get('/events', (req, reply) => {
    hub.addClient(reply, store.all(), now());
    // 不 return，交由 SSE 保持连接打开。
  });

  // —— Hook 接收（Claude 遗留入口）——
  app.post('/hooks', async (req, reply) => {
    const body = req.body as HookPayload | undefined;
    if (!body || typeof body.hook_event_name !== 'string' || typeof body.session_id !== 'string') {
      return reply.code(400).send({ error: 'bad payload' });
    }
    // 绝不 info 级别记录 tool_input（可能含 secret）。
    dispatchPush('claude', body);
    return reply.code(200).send({ ok: true });
  });

  // —— 通用 provider 推送入口（opencode 插件等）——
  app.post('/ingest/:agent', async (req, reply) => {
    const { agent } = req.params as { agent: string };
    if (agent !== 'claude' && agent !== 'codex' && agent !== 'opencode') {
      return reply.code(404).send({ error: 'unknown agent' });
    }
    dispatchPush(agent, req.body);
    return reply.code(200).send({ ok: true });
  });

  const server: HttpServer = {
    async listen() {
      const addr = await app.listen({ host: cfg.host, port: cfg.port });
      return addr;
    },
    async close() {
      hub.close();
      await app.close();
    },
    broadcast(event) {
      hub.broadcast(event);
    },
  };
  return server;
}

function isAuthorized(req: FastifyRequest, token: string): boolean {
  const auth = req.headers.authorization;
  if (auth && auth === `Bearer ${token}`) return true;
  const q = (req.query as Record<string, unknown> | undefined)?.token;
  return typeof q === 'string' && q === token;
}
