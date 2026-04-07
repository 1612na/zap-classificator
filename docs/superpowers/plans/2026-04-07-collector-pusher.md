# Collector Pusher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar ao coletor local (zap-classificator) um módulo `pusher/` que enfileira no SQLite cada evento capturado e os envia em lote para a Render API, com retry automático em caso de falha.

**Architecture:** Após cada persist local (upsertContact/Conversation/Message), o evento é enfileirado na tabela `push_queue` do SQLite. Um worker cron a cada 30s drena a fila em lotes de 50, agrupando por tipo (contacts → conversations → messages) para respeitar FKs no Render. Em falha, backoff exponencial até 10 tentativas; após isso, status `failed`. Os endpoints REST de query (summary/updated/full) são removidos do coletor local — agora só existem no Render.

**Tech Stack:** Node.js 20+, TypeScript ESM, better-sqlite3, drizzle-orm, node-cron, fetch nativo (Node 18+).

---

## Mapa de Arquivos

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `src/banco/schema.ts` | Modificar | Adicionar tabela `push_queue` |
| `src/pusher/queue.ts` | Criar | enqueue / dequeue / markSent / markFailed |
| `src/pusher/client.ts` | Criar | POST HTTP para Render API com auth |
| `src/pusher/worker.ts` | Criar | Cron job 30s que drena a fila |
| `src/dashboard/api.ts` | Simplificar | Manter só /auth/qr e /qr — remover summary/updated/full |
| `src/index.ts` | Modificar | Registrar worker do pusher; remover startDashboard de query |
| `.env.example` | Criar | Documentar variáveis de ambiente necessárias |
| `drizzle/` | Regenerar | Nova migração com push_queue |

---

## Task 1: Adicionar tabela `push_queue` ao schema

**Files:**
- Modify: `src/banco/schema.ts`

- [ ] **Step 1: Adicionar a tabela ao final de `src/banco/schema.ts`**

```typescript
// push_queue — fila de eventos pendentes de envio para o Render
export const pushQueue = sqliteTable(
  'push_queue',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    entity_type: text('entity_type').notNull(), // 'contact' | 'conversation' | 'message'
    entity_id: text('entity_id').notNull(),
    payload: text('payload').notNull(),          // JSON serializado do DTO
    status: text('status').notNull().default('pending'), // 'pending' | 'sent' | 'failed'
    attempts: integer('attempts').notNull().default(0),
    next_attempt_at: integer('next_attempt_at').notNull(), // Unix ms
    created_at: integer('created_at').notNull(),
    sent_at: integer('sent_at'),
    error: text('error'),
  },
  (table) => [
    index('push_queue_status_idx').on(table.status),
    index('push_queue_next_attempt_idx').on(table.next_attempt_at),
  ],
);
```

- [ ] **Step 2: Adicionar o import do índice no topo do schema (já existe, só verificar)**

O arquivo já importa `index` de `drizzle-orm/sqlite-core` — confirmar que a linha de import inclui `index`:

```typescript
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
```

- [ ] **Step 3: Regenerar migrações drizzle**

```bash
cd /Users/shelfspy/zap-classificator
rm -rf drizzle
npm run db:generate
```

Esperado: cria `drizzle/0000_*.sql` com todas as tabelas incluindo `push_queue`.

- [ ] **Step 4: Resetar DB e rodar migração**

```bash
rm -f data/db.sqlite
npm run db:migrate
```

Esperado: `data/db.sqlite` criado com nova estrutura.

- [ ] **Step 5: Commit**

```bash
git add src/banco/schema.ts drizzle/
git commit -m "feat: add push_queue table to schema"
```

---

## Task 2: Criar `src/pusher/queue.ts`

**Files:**
- Create: `src/pusher/queue.ts`

- [ ] **Step 1: Criar o arquivo**

```typescript
// src/pusher/queue.ts
// Funções de baixo nível para gerenciar a push_queue no SQLite.
// Sem lógica de retry ou HTTP — apenas enqueue/dequeue.

import { eq, lte, and, inArray } from 'drizzle-orm';
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
  const row = db
    .select({ count: pushQueue.id })
    .from(pushQueue)
    .where(eq(pushQueue.status, 'pending'))
    .all();
  return row.length;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/shelfspy/zap-classificator && npm run typecheck 2>&1 | head -20
```

Esperado: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/pusher/queue.ts
git commit -m "feat: add push_queue manager (enqueue/dequeue/markSent/markRetry)"
```

---

## Task 3: Criar `src/pusher/client.ts`

**Files:**
- Create: `src/pusher/client.ts`

- [ ] **Step 1: Criar o arquivo**

```typescript
// src/pusher/client.ts
// Cliente HTTP para POST em lote para a Render API.
// Sem dependências externas — usa fetch nativo do Node 18+.

const RENDER_API_URL = process.env['RENDER_API_URL'] ?? '';
const RENDER_API_KEY = process.env['RENDER_API_KEY'] ?? '';

if (!RENDER_API_URL || !RENDER_API_KEY) {
  console.warn('[pusher/client] RENDER_API_URL ou RENDER_API_KEY não definidos — pusher desabilitado');
}

export type IngestEntityType = 'contact' | 'conversation' | 'message';

// Mapeamento de tipo de entidade para endpoint do Render
const ENDPOINT: Record<IngestEntityType, string> = {
  contact: '/ingest/contacts',
  conversation: '/ingest/conversations',
  message: '/ingest/messages',
};

export interface PushResult {
  ok: boolean;
  error?: string;
}

/**
 * Envia um lote de payloads para o endpoint correspondente no Render.
 * Retorna { ok: true } se o servidor retornar 2xx, { ok: false, error } caso contrário.
 */
export async function pushBatch(
  entityType: IngestEntityType,
  payloads: unknown[],
): Promise<PushResult> {
  if (!RENDER_API_URL || !RENDER_API_KEY) {
    return { ok: false, error: 'RENDER_API_URL/KEY não configurados' };
  }
  if (payloads.length === 0) return { ok: true };

  const url = `${RENDER_API_URL}${ENDPOINT[entityType]}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': RENDER_API_KEY,
      },
      body: JSON.stringify({ data: payloads }),
      signal: AbortSignal.timeout(30_000), // 30s timeout
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, error: `HTTP ${response.status}: ${body.slice(0, 200)}` };
    }

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/shelfspy/zap-classificator && npm run typecheck 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/pusher/client.ts
git commit -m "feat: add Render API HTTP client for batch push"
```

---

## Task 4: Criar `src/pusher/worker.ts`

**Files:**
- Create: `src/pusher/worker.ts`

- [ ] **Step 1: Criar o arquivo**

```typescript
// src/pusher/worker.ts
// Cron job que drena a push_queue a cada 30s.
// Lê itens pendentes, agrupa por tipo, envia em lote para o Render,
// e atualiza status na fila conforme resultado.

import cron from 'node-cron';
import { dequeueBatch, markSent, markRetry, pendingCount } from './queue.js';
import { pushBatch, type IngestEntityType } from './client.js';
import type { Database } from '../banco/db.js';

const BATCH_SIZE = 50;
let running = false;

async function drainQueue(db: Database): Promise<void> {
  if (running) {
    console.log('[pusher] Worker já em execução — pulando ciclo');
    return;
  }
  running = true;

  try {
    const items = dequeueBatch(db, BATCH_SIZE);
    if (items.length === 0) return;

    console.log(`[pusher] Processando ${items.length} itens da fila (${pendingCount(db)} pendentes total)`);

    // Agrupar por tipo — a ordem de processamento já foi garantida pelo dequeueBatch
    const byType = new Map<IngestEntityType, Array<{ id: number; payload: unknown }>>();
    for (const item of items) {
      const type = item.entity_type as IngestEntityType;
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type)!.push({
        id: item.id,
        payload: JSON.parse(item.payload) as unknown,
      });
    }

    // Enviar cada grupo em lote — na ordem: contacts → conversations → messages
    for (const [type, entries] of byType) {
      const payloads = entries.map((e) => e.payload);
      const ids = entries.map((e) => e.id);

      const result = await pushBatch(type, payloads);

      if (result.ok) {
        markSent(db, ids);
        console.log(`[pusher] ✓ ${ids.length} ${type}(s) enviados`);
      } else {
        // Falha no lote inteiro — marcar cada item individualmente para retry
        for (const entry of entries) {
          const original = items.find((i) => i.id === entry.id)!;
          markRetry(db, entry.id, original.attempts, result.error ?? 'unknown');
        }
        console.error(`[pusher] ✗ Falha ao enviar ${type}(s): ${result.error}`);
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Inicia o worker de push. Executa a cada 30 segundos.
 * Retorna a task cron para permitir parar em testes.
 */
export function startPusherWorker(db: Database): cron.ScheduledTask {
  console.log('[pusher] Worker iniciado — ciclo a cada 30s');

  // Executar imediatamente no início (sem esperar 30s)
  void drainQueue(db).catch((err: unknown) => {
    console.error('[pusher] Erro no ciclo inicial:', err);
  });

  return cron.schedule('*/30 * * * * *', () => {
    void drainQueue(db).catch((err: unknown) => {
      console.error('[pusher] Erro no ciclo cron:', err);
    });
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/shelfspy/zap-classificator && npm run typecheck 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/pusher/worker.ts
git commit -m "feat: add pusher worker cron job (30s drain cycle)"
```

---

## Task 5: Simplificar `src/dashboard/api.ts` e atualizar `src/index.ts`

**Files:**
- Modify: `src/dashboard/api.ts`
- Modify: `src/index.ts`

Os endpoints de query (summary/updated/full) migram para o Render. O arquivo local mantém apenas os endpoints de QR para diagnóstico da conexão WhatsApp.

- [ ] **Step 1: Substituir `src/dashboard/api.ts` pela versão simplificada**

```typescript
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
```

- [ ] **Step 2: Reescrever `src/index.ts` para incluir o pusher**

```typescript
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from './banco/db.js';
import {
  upsertContact,
  upsertConversation,
  upsertMessage,
  ensureContactStub,
} from './banco/repository.js';
import { normalizeContact, normalizeChat, normalizeMessage } from './ingestao/normalizer.js';
import { bus } from './shared/events.js';
import { createConnection } from './whatsapp/auth.js';
import { startLocalApi } from './dashboard/api.js';
import { enqueue } from './pusher/queue.js';
import { startPusherWorker } from './pusher/worker.js';

async function main(): Promise<void> {
  migrate(db, { migrationsFolder: './drizzle' });
  console.log('[index] Banco de dados inicializado');

  // ── Persist + enqueue ────────────────────────────────────────────────────

  bus.on('message:received', (e) => {
    try {
      const now = Date.now();
      const isGroup = e.chatId.endsWith('@g.us');
      upsertConversation(db, {
        id: e.chatId,
        contact_id: null,
        name: null,
        is_group: isGroup ? 1 : 0,
        last_message_at: e.timestamp,
        unread_count: 0,
        created_at: now,
        updated_at: now,
      });
      const msg = normalizeMessage(e);
      upsertMessage(db, msg);
      enqueue(db, 'message', msg.id, msg);
    } catch (err) {
      console.error('[bus] message:received error', err);
    }
  });

  bus.on('chat:updated', (e) => {
    try {
      const normalized = normalizeChat(e);
      if (normalized.contact_id !== null) {
        ensureContactStub(db, normalized.contact_id);
      }
      upsertConversation(db, normalized);
      enqueue(db, 'conversation', normalized.id, normalized);
    } catch (err) {
      console.error('[bus] chat:updated error', err);
    }
  });

  bus.on('contact:updated', (e) => {
    try {
      const contact = normalizeContact(e);
      upsertContact(db, contact);
      enqueue(db, 'contact', contact.id, contact);
    } catch (err) {
      console.error('[bus] contact:updated error', err);
    }
  });

  // ── Workers ──────────────────────────────────────────────────────────────

  startPusherWorker(db);
  startLocalApi();

  // ── WhatsApp ─────────────────────────────────────────────────────────────

  console.log('[index] Iniciando conexão WhatsApp…');
  await createConnection();
}

main().catch((err) => {
  console.error('[index] Erro fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/shelfspy/zap-classificator && npm run typecheck 2>&1
```

Esperado: zero erros.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/api.ts src/index.ts
git commit -m "feat: integrate pusher worker into index; simplify local API to QR-only"
```

---

## Task 6: Criar `.env.example` e documentar variáveis

**Files:**
- Create: `.env.example`

- [ ] **Step 1: Criar `.env.example` na raiz do projeto**

```bash
# .env.example — copie para .env e preencha os valores reais

# URL base da Render API (sem barra no final)
# Ex: https://zap-api.onrender.com
RENDER_API_URL=https://sua-render-api.onrender.com

# Chave secreta compartilhada entre o coletor e a Render API
# Gere com: openssl rand -hex 32
RENDER_API_KEY=sua-chave-secreta-aqui

# Porta local para diagnóstico (padrão: 3000)
PORT=3000
```

- [ ] **Step 2: Garantir que `.env` está no `.gitignore`**

```bash
grep -q "^\.env$" /Users/shelfspy/zap-classificator/.gitignore || echo ".env" >> /Users/shelfspy/zap-classificator/.gitignore
```

- [ ] **Step 3: Typecheck + lint final**

```bash
cd /Users/shelfspy/zap-classificator && npm run typecheck && npm run lint 2>&1
```

Esperado: zero erros.

- [ ] **Step 4: Commit final**

```bash
git add .env.example .gitignore
git commit -m "chore: add .env.example with RENDER_API_URL/KEY vars"
```

---

## Self-Review

### Cobertura dos requisitos

| Requisito | Task | Status |
|---|---|---|
| SQLite como buffer de retry | Task 1 (push_queue) | ✓ |
| enqueue após cada persist local | Task 5 (index.ts) | ✓ |
| Ordem de envio: contacts → conversations → messages | Task 2 (dequeueBatch TYPE_ORDER) | ✓ |
| Retry com backoff exponencial, cap 10 tentativas | Task 2 (markRetry) | ✓ |
| Lote de 50 por ciclo | Tasks 2/4 (BATCH_SIZE=50) | ✓ |
| Auth X-Api-Key no header | Task 3 (client.ts) | ✓ |
| Timeout de 30s por request | Task 3 (AbortSignal.timeout) | ✓ |
| Worker cron 30s | Task 4 (worker.ts) | ✓ |
| Endpoints de query removidos do local | Task 5 (api.ts) | ✓ |
| Endpoint /health para diagnóstico | Task 5 (api.ts) | ✓ |
| Variáveis de ambiente documentadas | Task 6 (.env.example) | ✓ |

### Risco

**`push_queue.onConflictDoNothing`** — se o mesmo `entity_id` for reenfileirado antes de ser enviado (ex: duas atualizações rápidas da mesma conversa), o segundo `enqueue` é ignorado silenciosamente. Isso significa que a versão mais nova não será enviada até que o item pendente original seja processado. Para conversas (onde `last_message_at` muda frequentemente), isso pode atrasar a atualização no Render por até o próximo ciclo. Comportamento aceitável dado o polling de 2min do Manus.
