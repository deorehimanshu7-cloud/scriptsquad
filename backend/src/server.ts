import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

import authRoutes from './routes/auth';
import farmRoutes from './routes/farms';
import fieldRoutes from './routes/fields';
import evidenceRoutes from './routes/evidence';
import worldModelRoutes from './routes/world-model';
import systemRoutes from './routes/system';
import weatherRoutes from './routes/weather';
import satelliteRoutes from './routes/satellite';
import investigationsRoutes from './routes/investigations';
import simulationRoutes from './routes/simulation';
import assistantRoutes from './routes/assistant';
import analyzeRoutes from './routes/analyze';
import envRoutes from './routes/env';
import farmerRoutes from './routes/farmer';
import digitalTwinRoutes from './routes/digital-twin';
import { devicesRouter, sensorsRouter, fieldSensorsRouter } from './routes/sensors';
import voiceDeviceRoutes from './routes/voice-devices';

import { errorHandler } from './middleware/error-handler';
import { connectMqtt, mqttStatus } from './services/sensors/mqtt-client';
import { dbHealth } from './data/db';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : 'http://localhost:5173', credentials: true }));
app.use(compression());
app.use((req, _res, next) => {
  req.headers['x-request-id'] = req.headers['x-request-id'] || uuidv4();
  next();
});
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Auth brute-force protection
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false, message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many auth requests. Try again later.' } } }));

app.get('/api/health', async (_req, res) => {
  const db = await dbHealth();
  res.json({ success: true, data: { status: db.ok ? 'healthy' : 'degraded', database_mode: db.mode, database: { status: db.ok ? 'AVAILABLE' : 'UNAVAILABLE', postgis: db.postgis, detail: db.detail }, version: '2.0.0' } });
});

// Core API surface
app.use('/api/auth', authRoutes);
app.use('/api/farms', farmRoutes);
app.use('/api/fields', fieldRoutes);            // fields CRUD + geometry + AOI import
app.use('/api/fields', analyzeRoutes);          // /:fieldId/analyze + intelligence GETs
app.use('/api/fields', envRoutes);              // /:fieldId/soil|terrain|water|crop
app.use('/api/fields', fieldSensorsRouter);     // /:fieldId/devices|sensors|observations
app.use('/api/fields/:fieldId/evidence', evidenceRoutes);
app.use('/api/fields/:fieldId/world-model', worldModelRoutes);
app.use('/api/fields/:fieldId/weather', weatherRoutes);
app.use('/api/fields/:fieldId/satellite', satelliteRoutes);
app.use('/api/fields/:fieldId/investigations', investigationsRoutes);
app.use('/api/fields/:fieldId/simulation', simulationRoutes);
app.use('/api/fields/:fieldId/digital-twin', digitalTwinRoutes);
app.use('/api/devices', devicesRouter);
app.use('/api/sensors', sensorsRouter);
app.use('/api/voice-devices', voiceDeviceRoutes);
app.use('/api', farmerRoutes);                  // /api/farmer-observations + /:fieldId/verifications etc.
app.use('/api/assistant', assistantRoutes);
app.use('/api/system', systemRoutes);

app.use((_req, res) => { res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }); });
app.use(errorHandler);

app.listen(PORT, async () => {
  console.log(`\n🌍 AGRIFUR2 Backend v2.0 running on port ${PORT}`);
  console.log(`🗄️  Database mode: ${dbHealth ? (await dbHealth()).mode : 'unknown'}`);
  const h = await dbHealth();
  console.log(h.ok ? `   → ${h.detail}` : `   ⚠ ${h.detail}`);
  if (h.mode === 'postgres' && !h.postgis) {
    console.error('   ✗ PostGIS extension missing — run: psql ... -c "CREATE EXTENSION IF NOT EXISTS postgis;" or use DATABASE_MODE=sqlite-dev for development.');
  }

  const mqttUrl = process.env.MQTT_BROKER;
  if (mqttUrl) {
    const connected = await connectMqtt(mqttUrl, { username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD });
    console.log(connected ? `📡 MQTT connected: ${mqttUrl}` : `📡 MQTT unavailable (${mqttUrl}) — status: ${mqttStatus()}`);
  } else {
    console.log('📡 MQTT not configured (set MQTT_BROKER) — status UNAVAILABLE');
  }

  const aiKey = process.env.AI_API_KEY;
  console.log(aiKey ? `🤖 AI: ${process.env.AI_MODEL || 'gpt-4o-mini'} (LLM configured)` : '🤖 AI: local grounded engine (set AI_API_KEY for LLM)');
});

export default app;
