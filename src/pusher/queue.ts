// src/pusher/queue.ts
// Funções de baixo nível para gerenciar a push_queue no SQLite.
// Sem lógica de retry ou HTTP — apenas enqueue/dequeue.

import { eq, lte, and, inArray, sql } from 'drizzle-orm';
import { pushQueue } from '../banco/schema.js';
import type { Database } from '../banco/db.js';

export type EntityType = 'contact' | 'conversation' | 'message';

// ---------------------------------------------------------------------------
// enqueue — adiciona um item à fila com next_attempt_at = agora
// ---------------------------------------------------------------------------

export function enqueue(
  db: Database,
  entityType: EntityType,
  entityId: string,
  payload: unknown,
): void {
  const now = Date.now();
  db.insert(pushQueue)
    .values({
      entity_type: entityType,
      entity_id: entityId,
      payload: JSON.stringify(payload),
      status: 'pending',
      attempts: 0,
      next_attempt_at: now,
      created_at: now,
    })
    .onConflictDoNothing() // entidade já enfileirada — não duplicar
    .run();
}

// ---------------------------------------------------------------------------
// dequeueBatch — retorna até `limit` itens prontos para envio
// agrupados por tipo (contacts primeiro, depois conversations, depois messages)
// para respeitar dependências de FK no Render.
// ---------------------------------------------------------------------------

const TYPE_ORDER: EntityType[] = ['contact', 'conversation', 'message'];

export interface QueueItem {
  id: number;
  entity_type: EntityType;
  entity_id: string;
  payload: string;
  attempts: number;
}

export function dequeueBatch(db: Database, limit = 50): QueueItem[] {
  const now = Date.now();
  const items: QueueItem[] = [];

  for (const type of TYPE_ORDER) {
    if (items.length >= limit) break;
    const remaining = limit - items.length;

    const rows = db
      .select({
        id: pushQueue.id,
        entity_type: pushQueue.entity_type,
        entity_id: pushQueue.entity_id,
        payload: pushQueue.payload,
        attempts: pushQueue.attempts,
      })
      .from(pushQueue)
      .where(
        and(
          eq(pushQueue.status, 'pending'),
          eq(pushQueue.entity_type, type),
          lte(pushQueue.next_attempt_at, now),
        ),
      )
      .limit(remaining)
      .all();

    items.push(...(rows as QueueItem[]));
  }

  return items;
}

// ---------------------------------------------------------------------------
// markSent — remove o item da fila (mantemos apenas falhas para diagnóstico)
// ---------------------------------------------------------------------------

export function markSent(db: Database, ids: number[]): void {
  if (ids.length === 0) return;
  db.update(pushQueue)
    .set({ status: 'sent', sent_at: Date.now() })
    .where(inArray(pushQueue.id, ids))
    .run();
}

// ---------------------------------------------------------------------------
// markRetry — incrementa tentativas e agenda próximo retry com backoff exp.
// Após MAX_ATTEMPTS, marca como 'failed'.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 30_000;   // 30s
const BACKOFF_MAX_MS  = 1_800_000; // 30min

export function markRetry(db: Database, id: number, attempts: number, error: string): void {
  const nextAttempts = attempts + 1;
  if (nextAttempts >= MAX_ATTEMPTS) {
    db.update(pushQueue)
      .set({ status: 'failed', attempts: nextAttempts, error })
      .where(eq(pushQueue.id, id))
      .run();
    return;
  }
  const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempts), BACKOFF_MAX_MS);
  db.update(pushQueue)
    .set({
      attempts: nextAttempts,
      next_attempt_at: Date.now() + delay,
      error,
    })
    .where(eq(pushQueue.id, id))
    .run();
}

// ---------------------------------------------------------------------------
// pendingCount — usado para logging
// ---------------------------------------------------------------------------

export function pendingCount(db: Database): number {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(pushQueue)
    .where(eq(pushQueue.status, 'pending'))
    .get();
  return result?.count ?? 0;
}
