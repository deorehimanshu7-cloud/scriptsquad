import { Router, Request, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { dbHealth, dbMode } from '../data/db';
import { PROVIDER_CATALOG } from '../services/providers/registry';
import { jobList, jobById } from '../services/jobs';
import { queryEvents } from '../services/events';
import { registerSseClient } from '../services/events';
import { recentProviderSuccessRate } from '../data/system';
import { isConnected } from '../services/sensors/mqtt-client';
import { dbRun } from '../data/db';

const router = Router();

async function pingProvider(id: string): Promise<{ status: string; latency_ms: number; error?: string }> {
  const start = Date.now();
  try {
    switch (id) {
      case 'copernicus': {
        const { CopernicusAdapter } = await import('../services/providers/adapters/copernicus');
        const ok = await new CopernicusAdapter().healthCheck();
        return { status: ok ? 'AVAILABLE' : 'UNAVAILABLE', latency_ms: Date.now() - start };
      }
      case 'landsat-earth-search': {
        const { LandsatAdapter } = await import('../services/providers/adapters/landsat');
        const ok = await new LandsatAdapter().healthCheck();
        return { status: ok ? 'AVAILABLE' : 'UNAVAILABLE', latency_ms: Date.now() - start };
      }
      case 'open-meteo':
      case 'open-meteo-elevation': {
        const { OpenMeteoAdapter } = await import('../services/providers/adapters/open-meteo');
        const ok = await new OpenMeteoAdapter().healthCheck();
        return { status: ok ? 'AVAILABLE' : 'UNAVAILABLE', latency_ms: Date.now() - start };
      }
      case 'soilgrids': {
        const { SoilGridsAdapter } = await import('../services/providers/adapters/soilgrids');
        const ok = await new SoilGridsAdapter().healthCheck();
        return { status: ok ? 'AVAILABLE' : 'UNAVAILABLE', latency_ms: Date.now() - start };
      }
      case 'bhoonidhi': {
        const configured = !!(process.env.BHOONIDHI_CLIENT_ID && process.env.BHOONIDHI_CLIENT_SECRET);
        return { status: configured ? 'AUTH_REQUIRED' : 'AUTH_REQUIRED', latency_ms: 0, error: configured ? undefined : 'Bhoonidhi adapter implemented; credentials required (BHOONIDHI_CLIENT_ID / BHOONIDHI_CLIENT_SECRET).' };
      }
      case 'ai-llm': {
        const configured = !!process.env.AI_API_KEY;
        return { status: configured ? 'AVAILABLE' : 'AUTH_REQUIRED', latency_ms: 0, error: configured ? undefined : 'Set AI_API_KEY to enable LLM reasoning.' };
      }
      default:
        return { status: 'UNKNOWN', latency_ms: 0 };
    }
  } catch {
    return { status: 'UNAVAILABLE', latency_ms: Date.now() - start };
  }
}

router.get('/health', async (_req: Request, res: Response) => {
  const db = await dbHealth();
  const mqtt = process.env.MQTT_BROKER ? (isConnected() ? 'AVAILABLE' : 'DEGRADED') : 'UNAVAILABLE';
  res.json({
    success: true,
    data: {
      status: db.ok ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      version: '2.0.0',
      database_mode: db.mode,
      database: { status: db.ok ? 'AVAILABLE' : 'UNAVAILABLE', detail: db.detail, postgis: db.postgis },
      mqtt: { status: mqtt, note: process.env.MQTT_BROKER ? undefined : 'MQTT not configured (set MQTT_BROKER).' },
      services: {
        api: 'AVAILABLE',
        redis: process.env.REDIS_URL ? 'UNKNOWN' : 'UNAVAILABLE',
        storage: 'AVAILABLE',
      },
    },
  });
});

router.get('/providers', authenticate, async (_req: Request, res: Response) => {
  const rows = await Promise.all(PROVIDER_CATALOG.map(async (p) => {
    const health = await pingProvider(p.id);
    const rate = await recentProviderSuccessRate(p.id).catch(() => ({ success_rate: null, count: 0 }));
    await dbRun(`INSERT INTO providers (id, name, type, status, last_check)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, last_check = EXCLUDED.last_check, updated_at = $5`,
      [p.id, p.name, p.type, health.status, new Date().toISOString()]).catch(() => {});
    return {
      id: p.id, name: p.name, type: p.type,
      status: health.status,
      status_detail: health.error,
      latency_ms: health.latency_ms,
      last_check: new Date().toISOString(),
      requires_credentials: p.requires_credentials,
      configured: p.configured,
      success_rate_measured: rate.success_rate,
      requests_measured: rate.count,
    };
  }));
  res.json({ success: true, data: rows });
});

router.get('/providers/health', authenticate, async (_req: Request, res: Response) => {
  const rows = await Promise.all(PROVIDER_CATALOG.map(async (p) => {
    const health = await pingProvider(p.id);
    return { provider: p.id, type: p.type, status: health.status, latency_ms: health.latency_ms, last_check: new Date().toISOString(), detail: health.error };
  }));
  res.json({ success: true, data: rows });
});

router.get('/jobs', authenticate, async (_req: Request, res: Response) => {
  const jobs = await jobList(200);
  res.json({ success: true, data: jobs, total: jobs.length });
});

router.get('/jobs/:jobId', authenticate, async (req: Request, res: Response) => {
  const job = await jobById(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });
  res.json({ success: true, data: job });
});

router.get('/events', authenticate, async (req: Request, res: Response) => {
  const events = await queryEvents({
    fieldId: typeof req.query.field_id === 'string' ? req.query.field_id : undefined,
    type: typeof req.query.type === 'string' ? req.query.type : undefined,
    limit: 200,
  });
  res.json({ success: true, data: events });
});

// Server-Sent Events stream (optional auth query param for dev convenience)
router.get('/events/stream', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (payload: string) => res.write(payload);
  const unregister = registerSseClient(send);
  res.write(`data: ${JSON.stringify({ type: 'STREAM_READY', created_at: new Date().toISOString() })}\n\n`);
  req.on('close', () => unregister());
});

router.get('/audit', authenticate, async (req: AuthRequest, res: Response) => {
  const { listAudit } = await import('../data/system');
  const rows = await listAudit(req.query.user_only === '1' ? req.user!.id : undefined, 200);
  res.json({ success: true, data: rows });
});

export default router;
