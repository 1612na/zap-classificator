// ---------------------------------------------------------------------------
// dashboard/api.ts — Express REST API para o dashboard do zap-classificator.
//
// Consome o banco via drizzle-orm diretamente (sem repositório intermediário).
// Importa saveClassification do banco/repository para o endpoint de override
// manual, e runIncrementalSync + runWithLock para o trigger de sync.
// ---------------------------------------------------------------------------

import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import path from 'path';
import { eq, gte, desc, isNull, sql, and } from 'drizzle-orm';
import { db } from '../banco/db.js';
import {
  conversations,
  messages,
  classifications,
  classificationHistory,
  syncRuns,
} from '../banco/schema.js';
import { saveClassification } from '../banco/repository.js';
import { runIncrementalSync } from '../scheduler/sync.js';
import { runWithLock, isLocked } from '../scheduler/lock.js';
import type { ClassificationResult } from '../shared/types.js';
import { bus } from '../shared/events.js';

// ---------------------------------------------------------------------------
// QR state — updated via bus events from auth.ts
// ---------------------------------------------------------------------------

let currentQr: string | null = null;
let whatsappStatus: 'pending' | 'connected' = 'pending';

bus.on('whatsapp:qr', ({ qr }) => { currentQr = qr; whatsappStatus = 'pending'; });
bus.on('whatsapp:connected', () => { currentQr = null; whatsappStatus = 'connected'; });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseIntParam(raw: unknown, defaultVal: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : defaultVal;
}

// ---------------------------------------------------------------------------
// createApp
// ---------------------------------------------------------------------------

export function createApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(import.meta.dirname, 'frontend')));

  // -------------------------------------------------------------------------
  // GET /conversations
  // -------------------------------------------------------------------------
  app.get('/conversations', (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = clamp(parseIntParam(req.query['limit'], 50), 1, 200);
      const offset = Math.max(0, parseIntParam(req.query['offset'], 0));

      const filterStatus = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;
      const filterPriority = typeof req.query['priority'] === 'string' ? Number(req.query['priority']) : undefined;
      const filterIntent = typeof req.query['intent'] === 'string' ? req.query['intent'] : undefined;
      const filterClassifiedBy = typeof req.query['classified_by'] === 'string' ? req.query['classified_by'] : undefined;
      const filterSince = typeof req.query['since'] === 'string' ? Number(req.query['since']) : undefined;

      // Build WHERE conditions
      const conditions = [];

      if (filterStatus !== undefined) {
        conditions.push(eq(classifications.status, filterStatus));
      }
      if (filterPriority !== undefined && Number.isFinite(filterPriority)) {
        conditions.push(eq(classifications.priority, filterPriority));
      }
      if (filterIntent !== undefined) {
        conditions.push(eq(classifications.intent, filterIntent));
      }
      if (filterClassifiedBy !== undefined) {
        conditions.push(eq(classifications.classified_by, filterClassifiedBy));
      }
      if (filterSince !== undefined && Number.isFinite(filterSince)) {
        conditions.push(gte(conversations.last_message_at, filterSince));
      }

      const query = db
        .select({
          id: conversations.id,
          contact_id: conversations.contact_id,
          name: conversations.name,
          is_group: conversations.is_group,
          last_message_at: conversations.last_message_at,
          unread_count: conversations.unread_count,
          is_archived: conversations.is_archived,
          created_at: conversations.created_at,
          updated_at: conversations.updated_at,
          classification: {
            id: classifications.id,
            status: classifications.status,
            intent: classifications.intent,
            sentiment: classifications.sentiment,
            priority: classifications.priority,
            summary: classifications.summary,
            next_action: classifications.next_action,
            classified_by: classifications.classified_by,
            model_version: classifications.model_version,
            classified_at: classifications.classified_at,
          },
        })
        .from(conversations)
        .leftJoin(classifications, eq(conversations.id, classifications.conversation_id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(conversations.last_message_at))
        .limit(limit)
        .offset(offset);

      const rows = query.all();
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /conversations/:id
  // -------------------------------------------------------------------------
  app.get('/conversations/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const conversation = db
        .select()
        .from(conversations)
        .where(eq(conversations.id, id))
        .get();

      if (conversation === undefined) {
        res.status(404).json({ error: 'Conversa não encontrada' });
        return;
      }

      const classification = db
        .select()
        .from(classifications)
        .where(eq(classifications.conversation_id, id))
        .get();

      const recentMessages = db
        .select()
        .from(messages)
        .where(eq(messages.chat_id, id))
        .orderBy(desc(messages.timestamp))
        .limit(50)
        .all();

      const history = db
        .select()
        .from(classificationHistory)
        .where(eq(classificationHistory.conversation_id, id))
        .orderBy(desc(classificationHistory.classified_at))
        .all();

      res.json({
        ...conversation,
        classification: classification ?? null,
        messages: recentMessages,
        classification_history: history,
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // PATCH /conversations/:id/classify
  // -------------------------------------------------------------------------
  app.patch('/conversations/:id/classify', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const conversation = db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, id))
        .get();

      if (conversation === undefined) {
        res.status(404).json({ error: 'Conversa não encontrada' });
        return;
      }

      const body = req.body as Partial<ClassificationResult>;

      // Fetch current classification as defaults for omitted fields
      const current = db
        .select()
        .from(classifications)
        .where(eq(classifications.conversation_id, id))
        .get();

      const result: ClassificationResult = {
        status: body.status ?? current?.status as ClassificationResult['status'] ?? 'indefinido',
        intent: body.intent !== undefined ? body.intent : (current?.intent as ClassificationResult['intent'] ?? null),
        sentiment: body.sentiment ?? current?.sentiment as ClassificationResult['sentiment'] ?? 'neutro',
        priority: body.priority ?? current?.priority as ClassificationResult['priority'] ?? 3,
        summary: body.summary ?? current?.summary ?? '',
        next_action: body.next_action ?? current?.next_action ?? '',
        classified_by: 'manual',
        confidence: 1,
      };

      saveClassification(db, id, result);

      const updated = db
        .select()
        .from(classifications)
        .where(eq(classifications.conversation_id, id))
        .get();

      res.json(updated ?? null);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /stats/summary
  // -------------------------------------------------------------------------
  app.get('/stats/summary', (_req: Request, res: Response, next: NextFunction) => {
    try {
      const totalRow = db
        .select({ count: sql<number>`count(*)` })
        .from(conversations)
        .get();
      const total_conversations = totalRow?.count ?? 0;

      // Unclassified: conversations with no classification row
      const unclassifiedRow = db
        .select({ count: sql<number>`count(*)` })
        .from(conversations)
        .leftJoin(classifications, eq(conversations.id, classifications.conversation_id))
        .where(isNull(classifications.id))
        .get();
      const unclassified = unclassifiedRow?.count ?? 0;

      // Count by status
      const statusRows = db
        .select({
          status: classifications.status,
          count: sql<number>`count(*)`,
        })
        .from(classifications)
        .groupBy(classifications.status)
        .all();

      const by_status: Record<string, number> = {};
      for (const row of statusRows) {
        by_status[row.status] = row.count;
      }

      // Count by priority
      const priorityRows = db
        .select({
          priority: classifications.priority,
          count: sql<number>`count(*)`,
        })
        .from(classifications)
        .groupBy(classifications.priority)
        .all();

      const by_priority: Record<string, number> = {};
      for (const row of priorityRows) {
        if (row.priority !== null) {
          by_priority[String(row.priority)] = row.count;
        }
      }

      // Last sync run
      const lastSync = db
        .select({
          started_at: syncRuns.started_at,
          finished_at: syncRuns.finished_at,
          status: syncRuns.status,
        })
        .from(syncRuns)
        .orderBy(desc(syncRuns.started_at))
        .limit(1)
        .get();

      res.json({
        total_conversations,
        by_status,
        by_priority,
        unclassified,
        last_sync: lastSync ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /sync-runs
  // -------------------------------------------------------------------------
  app.get('/sync-runs', (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = clamp(parseIntParam(req.query['limit'], 20), 1, 100);
      const offset = Math.max(0, parseIntParam(req.query['offset'], 0));

      const rows = db
        .select()
        .from(syncRuns)
        .orderBy(desc(syncRuns.started_at))
        .limit(limit)
        .offset(offset)
        .all();

      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /sync/trigger
  // -------------------------------------------------------------------------
  app.post('/sync/trigger', (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (isLocked('incremental-sync')) {
        res.status(409).json({ message: 'Sync já em andamento' });
        return;
      }

      // Fire and forget — do not await so the response is immediate.
      runWithLock('incremental-sync', () => runIncrementalSync(db)).catch((err: unknown) => {
        console.error('[dashboard] sync/trigger error:', err);
      });

      res.status(202).json({ message: 'Sync iniciado' });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /qr — serves the QR scan page
  // -------------------------------------------------------------------------
  app.get('/qr', (_req: Request, res: Response) => {
    res.sendFile(path.join(import.meta.dirname, 'frontend', 'qr.html'));
  });

  // -------------------------------------------------------------------------
  // GET /auth/qr — returns current QR string for web-based scanning
  // -------------------------------------------------------------------------
  app.get('/auth/qr', (_req: Request, res: Response) => {
    res.json({ status: whatsappStatus, qr: currentQr });
  });

  // -------------------------------------------------------------------------
  // Error handler
  // -------------------------------------------------------------------------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[dashboard] Unhandled error:', err);
    const message = err instanceof Error ? err.message : 'Erro interno';
    res.status(500).json({ error: message });
  });

  return app;
}

// ---------------------------------------------------------------------------
// startDashboard
// ---------------------------------------------------------------------------

export function startDashboard(port = Number(process.env['PORT']) || 3000): void {
  const app = createApp();
  app.listen(port, () => {
    console.log(`[dashboard] API rodando em http://localhost:${port}`);
  });
}
