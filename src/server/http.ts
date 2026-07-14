/**
 * http.ts — Fastify 应用：静态 PWA + /events(SSE) + /api/* + /hooks。
 *
 * 鉴权：非 loopback（lan 模式）时，/api、/events、/hooks 一律校验 Bearer token
 * （或 ?token= 查询参，方便手机扫码带 token 访问 UI）。loopback 下默认放行。
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Config, Session, HookPayload, ServerEvent } from '../types.ts';
import type { SessionStore } from '../types.ts';
import { SseHub } from './sse.ts';

/** 供 sse.ts 使用的最小 reply 形状。 */
export type ServerReply = FastifyReply;

const __dirname = dirname(fileURLToPath(import.meta.url));
/** public/ 位于仓库根，相对 src/server 上溯两级。 */
const PUBLIC_DIR = join(__dirname, '..', '..', 'public');

export interface HttpDeps {
  cfg: Config;
  store: SessionStore;
  hub: SseHub;
  /** 收到 hook POST 时回调（reconciler 消费）。 */
  onHook: (payload: HookPayload) => void;
  now?: () => number;
}

export interface HttpServer {
  listen: () => Promise<string>;
  close: () => Promise<void>;
  /** 供上层把 store/notifier 事件广播出去。 */
  broadcast: (event: ServerEvent) => void;
}

export async function createHttpServer(deps: HttpDeps): Promise<HttpServer> {
  const { cfg, store, hub, onHook } = deps;
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
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/' });

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

  // —— SSE ——
  app.get('/events', (req, reply) => {
    hub.addClient(reply, store.all(), now());
    // 不 return，交由 SSE 保持连接打开。
  });

  // —— Hook 接收 ——
  app.post('/hooks', async (req, reply) => {
    const body = req.body as HookPayload | undefined;
    if (!body || typeof body.hook_event_name !== 'string' || typeof body.session_id !== 'string') {
      return reply.code(400).send({ error: 'bad payload' });
    }
    // 绝不 info 级别记录 tool_input（可能含 secret）。
    onHook(body);
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
