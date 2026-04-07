// src/dashboard/api.ts
// API local mínima — apenas diagnóstico de conexão WhatsApp.
// Os endpoints de query (summary/updated/full) estão na Render API.

import express, { type Request, type Response } from 'express';
import path from 'path';
import { bus } from '../shared/events.js';

let currentQr: string | null = null;
let whatsappStatus: 'pending' | 'connected' = 'pending';

bus.on('whatsapp:qr', ({ qr }) => { currentQr = qr; whatsappStatus = 'pending'; });
bus.on('whatsapp:connected', () => { currentQr = null; whatsappStatus = 'connected'; });

export function createApp(): express.Application {
  const app = express();

  app.get('/auth/qr', (_req: Request, res: Response) => {
    res.json({ status: whatsappStatus, qr: currentQr });
  });

  app.get('/qr', (_req: Request, res: Response) => {
    res.sendFile(path.join(import.meta.dirname, 'frontend', 'qr.html'));
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, whatsapp: whatsappStatus, ts: new Date().toISOString() });
  });

  return app;
}

export function startLocalApi(port = Number(process.env['PORT']) || 3000): void {
  const app = createApp();
  app.listen(port, () => {
    console.log(`[local-api] Diagnóstico em http://localhost:${port}/health`);
    console.log(`[local-api] QR scan em http://localhost:${port}/qr`);
  });
}
