import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import pino from 'pino';
import { dashboardData, renderDashboard } from './dashboard.js';
import { UsageStore } from './db.js';
import { RouterEngine } from './routing.js';
import { proxyChatCompletion } from './upstream.js';
import type { AppConfig, ChatCompletionRequest } from './types.js';

export function createApp(config: AppConfig, store = new UsageStore(config.database.path)): Hono {
  const app = new Hono();
  const log = pino({ name: 'agentmux' });
  const router = new RouterEngine(config, store);
  const corsOrigins = config.server.cors_origins ?? [];

  app.use('*', logger());
  if (corsOrigins.length > 0) {
    app.use('/v1/*', cors({ origin: corsOrigins }));
  }
  app.use('/v1/*', async (c, next) => {
    const expected = config.server.api_key;
    if (!expected && config.server.allow_unauthenticated === true) return next();
    if (!expected) {
      return c.json({ error: { message: 'Server API key is not configured' } }, 503);
    }
    const auth = c.req.header('authorization') ?? '';
    if (auth !== `Bearer ${expected}`) return c.json({ error: { message: 'Unauthorized' } }, 401);
    return next();
  });

  app.get('/health', (c) => c.json(healthPayload(config, store)));
  app.get('/dashboard', (c) => c.html(renderDashboard(config, store)));
  app.get('/dashboard/data', (c) => c.json(dashboardData(config, store)));

  app.get('/v1/models', (c) =>
    c.json({
      object: 'list',
      data: Object.keys(config.models).map((id) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'agentmux'
      }))
    })
  );

  app.post('/v1/chat/completions', async (c) => {
    const body = (await c.req.json()) as ChatCompletionRequest;
    if (!body.model || typeof body.model !== 'string') {
      return c.json({ error: { message: 'model is required' } }, 400);
    }
    const candidates = router.select(body.model);
    if (candidates.length === 0) {
      return c.json({ error: { message: `No available upstreams for model ${body.model}` } }, 503);
    }
    const result = await proxyChatCompletion(config, store, body, candidates);
    log.info({ model: body.model, upstream: result.upstreamId }, 'routed chat completion');
    return result.response;
  });

  app.notFound((c) => c.json({ error: { message: 'Not found' } }, 404));
  app.onError((error, c) => {
    log.error({ error: error instanceof Error ? error.message : error }, 'request failed');
    return c.json(
      { error: { message: error instanceof Error ? error.message : 'Internal Server Error' } },
      500
    );
  });

  return app;
}

export function startServer(config: AppConfig): void {
  const _server = startHttpServer(config);
  void _server;
}

export function startHttpServer(config: AppConfig, store?: UsageStore): ServerType {
  const app = createApp(config, store);
  return serve(
    { fetch: app.fetch, hostname: config.server.host, port: config.server.port },
    (info) => {
      console.log(`AgentMux listening on http://${info.address}:${info.port}`);
    }
  );
}

export function closeHttpServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: NodeJS.ErrnoException) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    });
  });
}

export function healthPayload(
  config: AppConfig,
  store: UsageStore
): {
  status: 'ok' | 'degraded';
  upstreams: Array<{ id: string; state: string; cooldown_until?: number | undefined }>;
  models: string[];
} {
  const upstreams = config.upstreams.map((upstream) => {
    const state = store.recoverExpiredCooldown(upstream.id);
    return { id: upstream.id, state: state.state, cooldown_until: state.cooldown_until };
  });
  return {
    status: upstreams.some((u) => u.state === 'healthy' || u.state === 'probation')
      ? 'ok'
      : 'degraded',
    upstreams,
    models: Object.keys(config.models)
  };
}
