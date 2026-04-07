# Render API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar o serviço `zap-api` que roda no Render — recebe dados do coletor local via `POST /ingest/*`, persiste em PostgreSQL, e serve os endpoints de query para o Manus CRM (`GET /conversations/summary`, `GET /conversations/updated`, `GET /conversations/:id/full`).

**Architecture:** Projeto Express + TypeScript independente. Dois grupos de rotas com responsabilidades distintas: `routes/ingest.ts` (recebe do coletor, faz upsert no PostgreSQL) e `routes/query.ts` (serve o Manus com os 3 endpoints do contrato). Middleware `middleware/auth.ts` valida `X-Api-Key` em todos os endpoints. Schema PostgreSQL espelha o SQLite do coletor (sem `push_queue`).

**Tech Stack:** Node.js 20+, TypeScript ESM, Express 4, drizzle-orm + `pg` (PostgreSQL), `dotenv`, render.yaml para deploy.

---

## Mapa de Arquivos (novo projeto em `/Users/shelfspy/zap-api/`)

```
zap-api/
├── src/
│   ├── db/
│   │   ├── client.ts        # conexão PostgreSQL via drizzle
│   │   └── schema.ts        # tabelas PG: contacts, conversations, messages
│   ├── middleware/
│   │   └── auth.ts          # valida X-Api-Key header
│   ├── routes/
│   │   ├── ingest.ts        # POST /ingest/contacts|conversations|messages
│   │   └── query.ts         # GET /conversations/summary|updated|:id/full
│   ├── helpers/
│   │   └── format.ts        # toE164, mapMsgType, buildApiMessage, etc.
│   └── index.ts             # Express app + listen
├── drizzle/                 # migrações geradas
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── .env.example
├── .gitignore
└── render.yaml              # deploy config para o Render
```

---

## Task 1: Inicializar projeto `zap-api`

**Files:**
- Create: `/Users/shelfspy/zap-api/package.json`
- Create: `/Users/shelfspy/zap-api/tsconfig.json`
- Create: `/Users/shelfspy/zap-api/.gitignore`
- Create: `/Users/shelfspy/zap-api/drizzle.config.ts`

- [ ] **Step 1: Criar diretório e `package.json`**

```bash
mkdir -p /Users/shelfspy/zap-api
```

Criar `/Users/shelfspy/zap-api/package.json`:

```json
{
  "name": "zap-api",
  "version": "1.0.0",
  "description": "Render API — recebe dados do coletor WhatsApp e serve o CRM Manus",
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src --ext .ts",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "drizzle-orm": "^0.41.0",
    "express": "^4.19.2",
    "dotenv": "^16.4.5",
    "pg": "^8.11.5"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.5",
    "@typescript-eslint/eslint-plugin": "^7.18.0",
    "@typescript-eslint/parser": "^7.18.0",
    "drizzle-kit": "^0.30.0",
    "eslint": "^8.57.0",
    "tsx": "^4.19.1",
    "typescript": "^5.5.4"
  }
}
```

- [ ] **Step 2: Criar `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": false,
    "verbatimModuleSyntax": false
  },
  "include": ["src/**/*", "drizzle.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Criar `drizzle.config.ts`**

```typescript
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
} satisfies Config;
```

- [ ] **Step 4: Criar `.gitignore`**

```
node_modules/
dist/
.env
*.log
```

- [ ] **Step 5: Instalar dependências**

```bash
cd /Users/shelfspy/zap-api && npm install
```

Esperado: `node_modules/` criado sem erros.

- [ ] **Step 6: Inicializar repositório git**

```bash
cd /Users/shelfspy/zap-api && git init && git add . && git commit -m "chore: init zap-api project"
```

---

## Task 2: Schema PostgreSQL

**Files:**
- Create: `src/db/schema.ts`
- Create: `src/db/client.ts`

- [ ] **Step 1: Criar `src/db/schema.ts`**

```typescript
import {
  pgTable,
  text,
  bigint,
  boolean,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// contacts
export const contacts = pgTable('contacts', {
  id: text('id').primaryKey(),               // número limpo ex: "5511999998888"
  name: text('name'),
  push_name: text('push_name'),
  display_name: text('display_name'),
  is_business: boolean('is_business').default(false).notNull(),
  avatar_url: text('avatar_url'),
  about: text('about'),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
});

// conversations
export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),             // JID completo ex: "5511...@s.whatsapp.net"
    contact_id: text('contact_id').references(() => contacts.id),
    name: text('name'),
    is_group: boolean('is_group').default(false).notNull(),
    last_message_at: bigint('last_message_at', { mode: 'number' }),
    unread_count: integer('unread_count').default(0).notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('conversations_last_message_at_idx').on(table.last_message_at)],
);

// messages
export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    chat_id: text('chat_id').notNull().references(() => conversations.id),
    sender_jid: text('sender_jid'),
    from_me: boolean('from_me').default(false).notNull(),
    timestamp: bigint('timestamp', { mode: 'number' }).notNull(),
    text: text('text'),
    message_type: text('message_type').notNull(),
    has_media: boolean('has_media').default(false).notNull(),
    media_url: text('media_url'),
    media_mime: text('media_mime'),
    is_forwarded: boolean('is_forwarded').default(false).notNull(),
    quoted_message_id: text('quoted_message_id'),
    raw_payload: text('raw_payload').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('messages_chat_id_idx').on(table.chat_id),
    index('messages_timestamp_idx').on(table.timestamp),
  ],
);
```

- [ ] **Step 2: Criar `src/db/client.ts`**

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env['DATABASE_URL'],
  ssl: process.env['NODE_ENV'] === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
});

export const db = drizzle(pool, { schema });
export type Database = typeof db;
```

- [ ] **Step 3: Criar `.env.example`**

```bash
# .env.example — copie para .env e preencha

# PostgreSQL — fornecido pelo Render automaticamente em produção
DATABASE_URL=postgresql://user:password@host:5432/dbname

# Chave secreta — deve ser a mesma configurada em RENDER_API_KEY no coletor
# Gere com: openssl rand -hex 32
COLLECTOR_API_KEY=sua-chave-secreta-aqui

# Ambiente
NODE_ENV=development
```

- [ ] **Step 4: Gerar migração**

Criar primeiro um `.env` local para o drizzle-kit conseguir conectar:

```bash
cd /Users/shelfspy/zap-api
cp .env.example .env
# Editar .env com DATABASE_URL de um PostgreSQL local ou do Render
npm run db:generate
```

Esperado: `drizzle/0000_*.sql` com CREATE TABLE para contacts, conversations, messages.

- [ ] **Step 5: Commit**

```bash
cd /Users/shelfspy/zap-api
git add src/db/ drizzle/ .env.example drizzle.config.ts
git commit -m "feat: PostgreSQL schema and drizzle client"
```

---

## Task 3: Middleware de autenticação

**Files:**
- Create: `src/middleware/auth.ts`

- [ ] **Step 1: Criar `src/middleware/auth.ts`**

```typescript
import type { Request, Response, NextFunction } from 'express';

const COLLECTOR_API_KEY = process.env['COLLECTOR_API_KEY'] ?? '';

if (!COLLECTOR_API_KEY) {
  console.warn('[auth] COLLECTOR_API_KEY não definido — todos os requests serão rejeitados!');
}

/**
 * Middleware que valida o header X-Api-Key.
 * Rejeita com 401 se ausente ou incorreto.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-api-key'];
  if (!key || key !== COLLECTOR_API_KEY) {
    res.status(401).json({ error: 'Unauthorized — X-Api-Key inválido ou ausente' });
    return;
  }
  next();
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/shelfspy/zap-api
git add src/middleware/auth.ts
git commit -m "feat: add X-Api-Key auth middleware"
```

---

## Task 4: Rota de ingestão (`POST /ingest/*`)

**Files:**
- Create: `src/routes/ingest.ts`

Recebe arrays de contacts, conversations e messages do coletor. Faz upsert idempotente no PostgreSQL. Retorna `{ accepted: N }`.

- [ ] **Step 1: Criar `src/routes/ingest.ts`**

```typescript
import { Router, type Request, type Response, type NextFunction } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { contacts, conversations, messages } from '../db/schema.js';

export const ingestRouter = Router();

// ---------------------------------------------------------------------------
// Tipos dos payloads enviados pelo coletor (espelham NormalizedContact/Chat/Message)
// ---------------------------------------------------------------------------

interface IngestContact {
  id: string;
  name: string | null;
  push_name: string | null;
  display_name: string | null;
  is_business: 0 | 1;
  avatar_url: string | null;
  about: string | null;
  created_at: number;
  updated_at: number;
}

interface IngestConversation {
  id: string;
  contact_id: string | null;
  name: string | null;
  is_group: 0 | 1;
  last_message_at: number | null;
  unread_count: number;
  created_at: number;
  updated_at: number;
}

interface IngestMessage {
  id: string;
  chat_id: string;
  sender_jid: string | null;
  from_me: 0 | 1;
  timestamp: number;
  text: string | null;
  message_type: string;
  has_media: 0 | 1;
  media_url: string | null;
  media_mime: string | null;
  is_forwarded: 0 | 1;
  quoted_message_id: string | null;
  raw_payload: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// POST /ingest/contacts
// ---------------------------------------------------------------------------

ingestRouter.post('/contacts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = req.body as { data: IngestContact[] };
    if (!Array.isArray(data) || data.length === 0) {
      res.status(400).json({ error: 'data deve ser um array não vazio' });
      return;
    }

    const values = data.map((c) => ({
      id: c.id,
      name: c.name,
      push_name: c.push_name,
      display_name: c.display_name,
      is_business: c.is_business === 1,
      avatar_url: c.avatar_url,
      about: c.about,
      created_at: c.created_at,
      updated_at: c.updated_at,
    }));

    await db
      .insert(contacts)
      .values(values)
      .onConflictDoUpdate({
        target: contacts.id,
        set: {
          name: sql`excluded.name`,
          push_name: sql`excluded.push_name`,
          display_name: sql`excluded.display_name`,
          is_business: sql`excluded.is_business`,
          avatar_url: sql`excluded.avatar_url`,
          about: sql`excluded.about`,
          updated_at: sql`excluded.updated_at`,
        },
      });

    res.json({ accepted: data.length });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /ingest/conversations
// ---------------------------------------------------------------------------

ingestRouter.post('/conversations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = req.body as { data: IngestConversation[] };
    if (!Array.isArray(data) || data.length === 0) {
      res.status(400).json({ error: 'data deve ser um array não vazio' });
      return;
    }

    const values = data.map((c) => ({
      id: c.id,
      contact_id: c.contact_id,
      name: c.name,
      is_group: c.is_group === 1,
      last_message_at: c.last_message_at,
      unread_count: c.unread_count,
      created_at: c.created_at,
      updated_at: c.updated_at,
    }));

    await db
      .insert(conversations)
      .values(values)
      .onConflictDoUpdate({
        target: conversations.id,
        set: {
          // Preservar contact_id se já existir e o novo for null
          contact_id: sql`CASE WHEN excluded.contact_id IS NOT NULL THEN excluded.contact_id ELSE conversations.contact_id END`,
          last_message_at: sql`excluded.last_message_at`,
          unread_count: sql`excluded.unread_count`,
          name: sql`excluded.name`,
          updated_at: sql`excluded.updated_at`,
        },
      });

    res.json({ accepted: data.length });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /ingest/messages
// ---------------------------------------------------------------------------

ingestRouter.post('/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = req.body as { data: IngestMessage[] };
    if (!Array.isArray(data) || data.length === 0) {
      res.status(400).json({ error: 'data deve ser um array não vazio' });
      return;
    }

    const values = data.map((m) => ({
      id: m.id,
      chat_id: m.chat_id,
      sender_jid: m.sender_jid,
      from_me: m.from_me === 1,
      timestamp: m.timestamp,
      text: m.text,
      message_type: m.message_type,
      has_media: m.has_media === 1,
      media_url: m.media_url,
      media_mime: m.media_mime,
      is_forwarded: m.is_forwarded === 1,
      quoted_message_id: m.quoted_message_id,
      raw_payload: m.raw_payload,
      created_at: m.created_at,
    }));

    await db
      .insert(messages)
      .values(values)
      .onConflictDoNothing(); // mensagem é imutável

    res.json({ accepted: data.length });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 2: Commit**

```bash
cd /Users/shelfspy/zap-api
git add src/routes/ingest.ts
git commit -m "feat: POST /ingest/* endpoints with idempotent upsert"
```

---

## Task 5: Helpers de formatação

**Files:**
- Create: `src/helpers/format.ts`

- [ ] **Step 1: Criar `src/helpers/format.ts`**

```typescript
// src/helpers/format.ts
// Funções puras de transformação de dados para as respostas da API.

export type ApiMessageType = 'text' | 'image' | 'document' | 'audio' | 'video' | 'sticker';

const MSG_TYPE_MAP: Record<string, ApiMessageType> = {
  conversation: 'text',
  extendedTextMessage: 'text',
  imageMessage: 'image',
  videoMessage: 'video',
  documentMessage: 'document',
  audioMessage: 'audio',
  stickerMessage: 'sticker',
};

export function mapMsgType(raw: string): ApiMessageType {
  return MSG_TYPE_MAP[raw] ?? 'text';
}

export function toE164(rawPhone: string): string {
  return rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;
}

export interface ApiContact {
  phone: string;
  name: string | null;
  push_name: string | null;
  is_business: boolean;
  avatar_url: string | null;
}

export interface ApiContactFull extends ApiContact {
  about: string | null;
}

export interface ApiMessage {
  id: string;
  from: string;
  direction: 'inbound' | 'outbound';
  type: ApiMessageType;
  text: string | null;
  timestamp: string; // ISO 8601
  has_media: boolean;
}

export interface ApiMessageFull extends ApiMessage {
  media_url: string | null;
  media_mime: string | null;
  quoted_message_id: string | null;
  is_forwarded: boolean;
}

export function buildFrom(fromMe: boolean, senderJid: string | null, chatId: string): string {
  if (fromMe) return 'me';
  return senderJid ?? chatId;
}

export function buildApiMessage(row: {
  id: string;
  from_me: boolean;
  sender_jid: string | null;
  chat_id: string;
  message_type: string;
  text: string | null;
  timestamp: number;
  has_media: boolean;
}): ApiMessage {
  return {
    id: row.id,
    from: buildFrom(row.from_me, row.sender_jid, row.chat_id),
    direction: row.from_me ? 'outbound' : 'inbound',
    type: mapMsgType(row.message_type),
    text: row.text,
    timestamp: new Date(row.timestamp).toISOString(),
    has_media: row.has_media,
  };
}

export function buildApiMessageFull(row: {
  id: string;
  from_me: boolean;
  sender_jid: string | null;
  chat_id: string;
  message_type: string;
  text: string | null;
  timestamp: number;
  has_media: boolean;
  media_url: string | null;
  media_mime: string | null;
  quoted_message_id: string | null;
  is_forwarded: boolean;
}): ApiMessageFull {
  return {
    ...buildApiMessage(row),
    media_url: row.media_url,
    media_mime: row.media_mime,
    quoted_message_id: row.quoted_message_id,
    is_forwarded: row.is_forwarded,
  };
}

export const UNKNOWN_CONTACT: ApiContactFull = {
  phone: '+0',
  name: null,
  push_name: null,
  is_business: false,
  avatar_url: null,
  about: null,
};
```

- [ ] **Step 2: Commit**

```bash
cd /Users/shelfspy/zap-api
git add src/helpers/format.ts
git commit -m "feat: add API response format helpers"
```

---

## Task 6: Rota de query (`GET /conversations/*`)

**Files:**
- Create: `src/routes/query.ts`

Implementa os 3 endpoints do contrato Manus. Lógica idêntica ao `dashboard/api.ts` do coletor, mas usando PostgreSQL (async/await em vez de sync).

**Nota crítica:** `/conversations/updated` deve ser registrado ANTES de `/conversations/:id/full`.

- [ ] **Step 1: Criar `src/routes/query.ts`**

```typescript
import { Router, type Request, type Response, type NextFunction } from 'express';
import { desc, gte, lt, eq, sql, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { conversations, contacts, messages } from '../db/schema.js';
import {
  buildApiMessage,
  buildApiMessageFull,
  toE164,
  UNKNOWN_CONTACT,
  type ApiContact,
  type ApiContactFull,
  type ApiMessage,
  type ApiMessageFull,
} from '../helpers/format.js';

export const queryRouter = Router();

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function parseIntParam(raw: unknown, def: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : def;
}

// ---------------------------------------------------------------------------
// GET /conversations/summary
// ---------------------------------------------------------------------------

queryRouter.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseIntParam(req.query['page'], 1));
    const limit = clamp(parseIntParam(req.query['limit'], 50), 1, 100);
    const offset = (page - 1) * limit;

    const sinceRaw = req.query['since'] ?? req.query['updated_after'];
    const sinceMs = sinceRaw ? new Date(String(sinceRaw)).getTime() : null;

    const whereClause =
      sinceMs && Number.isFinite(sinceMs)
        ? gte(conversations.last_message_at, sinceMs)
        : undefined;

    const [totalRow, rows] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(conversations)
        .where(whereClause)
        .then((r) => r[0]),
      db
        .select({
          id: conversations.id,
          is_group: conversations.is_group,
          last_message_at: conversations.last_message_at,
          unread_count: conversations.unread_count,
          contact_id: conversations.contact_id,
          contact_name: contacts.name,
          contact_push_name: contacts.push_name,
          contact_is_business: contacts.is_business,
          contact_avatar_url: contacts.avatar_url,
        })
        .from(conversations)
        .leftJoin(contacts, eq(conversations.contact_id, contacts.id))
        .where(whereClause)
        .orderBy(desc(conversations.last_message_at))
        .limit(limit)
        .offset(offset),
    ]);

    const total = totalRow?.count ?? 0;

    const data = await Promise.all(
      rows.map(async (row) => {
        const [countRow, sampleRows] = await Promise.all([
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(messages)
            .where(eq(messages.chat_id, row.id))
            .then((r) => r[0]),
          db
            .select({
              id: messages.id,
              from_me: messages.from_me,
              sender_jid: messages.sender_jid,
              chat_id: messages.chat_id,
              message_type: messages.message_type,
              text: messages.text,
              timestamp: messages.timestamp,
              has_media: messages.has_media,
            })
            .from(messages)
            .where(eq(messages.chat_id, row.id))
            .orderBy(desc(messages.timestamp))
            .limit(10),
        ]);

        const contact: ApiContact = row.contact_id
          ? {
              phone: toE164(row.contact_id),
              name: row.contact_name,
              push_name: row.contact_push_name,
              is_business: row.contact_is_business ?? false,
              avatar_url: row.contact_avatar_url,
            }
          : UNKNOWN_CONTACT;

        return {
          conversation_id: row.id,
          type: row.is_group ? 'group' : 'individual',
          contact,
          last_message_at: row.last_message_at
            ? new Date(row.last_message_at).toISOString()
            : new Date(0).toISOString(),
          message_count: countRow?.count ?? 0,
          unread_count: row.unread_count,
          sample_messages: sampleRows.map(buildApiMessage) as ApiMessage[],
        };
      }),
    );

    const lastItem = rows[rows.length - 1];
    res.json({
      data,
      pagination: {
        page,
        limit,
        total,
        has_next: offset + rows.length < total,
        next_cursor: lastItem?.last_message_at
          ? new Date(lastItem.last_message_at).toISOString()
          : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /conversations/updated  ← DEVE vir ANTES de /:id
// ---------------------------------------------------------------------------

queryRouter.get('/updated', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sinceRaw = req.query['since'];
    if (!sinceRaw) {
      res.status(400).json({ error: 'Parâmetro "since" obrigatório (ISO 8601)' });
      return;
    }

    const sinceMs = new Date(String(sinceRaw)).getTime();
    if (!Number.isFinite(sinceMs)) {
      res.status(400).json({ error: 'Formato inválido para "since" — use ISO 8601' });
      return;
    }

    const limit = clamp(parseIntParam(req.query['limit'], 50), 1, 100);

    const rows = await db
      .select({ id: conversations.id, last_message_at: conversations.last_message_at })
      .from(conversations)
      .where(gte(conversations.last_message_at, sinceMs))
      .orderBy(conversations.last_message_at)
      .limit(limit);

    const lastItem = rows[rows.length - 1];
    // +1ms evita sobreposição no próximo ciclo de sync
    const syncToken = lastItem?.last_message_at
      ? new Date(lastItem.last_message_at + 1).toISOString()
      : null;

    res.json({
      data: rows.map((r) => ({
        conversation_id: r.id,
        last_message_at: r.last_message_at
          ? new Date(r.last_message_at).toISOString()
          : new Date(0).toISOString(),
      })),
      sync_token: syncToken,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /conversations/:id/full
// ---------------------------------------------------------------------------

queryRouter.get('/:id/full', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const msgLimit = clamp(parseIntParam(req.query['limit'], 200), 1, 500);
    const beforeRaw = req.query['before'];
    const beforeMs = beforeRaw ? new Date(String(beforeRaw)).getTime() : null;

    const conv = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .then((r) => r[0]);

    if (!conv) {
      res.status(404).json({ error: 'Conversa não encontrada' });
      return;
    }

    const contactRow = conv.contact_id
      ? await db
          .select()
          .from(contacts)
          .where(eq(contacts.id, conv.contact_id))
          .then((r) => r[0])
      : null;

    const contact: ApiContactFull = contactRow
      ? {
          phone: toE164(contactRow.id),
          name: contactRow.name,
          push_name: contactRow.push_name,
          is_business: contactRow.is_business,
          avatar_url: contactRow.avatar_url,
          about: contactRow.about,
        }
      : UNKNOWN_CONTACT;

    const msgWhere =
      beforeMs && Number.isFinite(beforeMs)
        ? and(eq(messages.chat_id, id), lt(messages.timestamp, beforeMs))
        : eq(messages.chat_id, id);

    const [countRow, msgRows] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(eq(messages.chat_id, id))
        .then((r) => r[0]),
      db
        .select({
          id: messages.id,
          from_me: messages.from_me,
          sender_jid: messages.sender_jid,
          chat_id: messages.chat_id,
          message_type: messages.message_type,
          text: messages.text,
          timestamp: messages.timestamp,
          has_media: messages.has_media,
          media_url: messages.media_url,
          media_mime: messages.media_mime,
          quoted_message_id: messages.quoted_message_id,
          is_forwarded: messages.is_forwarded,
        })
        .from(messages)
        .where(msgWhere)
        .orderBy(desc(messages.timestamp))
        .limit(msgLimit),
    ]);

    res.json({
      conversation_id: conv.id,
      type: conv.is_group ? 'group' : 'individual',
      contact,
      created_at: new Date(conv.created_at).toISOString(),
      last_message_at: conv.last_message_at
        ? new Date(conv.last_message_at).toISOString()
        : new Date(0).toISOString(),
      message_count: countRow?.count ?? 0,
      messages: msgRows.map(buildApiMessageFull) as ApiMessageFull[],
    });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 2: Commit**

```bash
cd /Users/shelfspy/zap-api
git add src/routes/query.ts
git commit -m "feat: GET /conversations/summary|updated|:id/full endpoints"
```

---

## Task 7: Entry point `src/index.ts` e `render.yaml`

**Files:**
- Create: `src/index.ts`
- Create: `render.yaml`

- [ ] **Step 1: Criar `src/index.ts`**

```typescript
import 'dotenv/config';
import express from 'express';
import { requireApiKey } from './middleware/auth.js';
import { ingestRouter } from './routes/ingest.js';
import { queryRouter } from './routes/query.js';
import { db } from './db/client.js';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const PORT = Number(process.env['PORT']) || 3001;

async function main(): Promise<void> {
  // Rodar migrações ao iniciar
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('[zap-api] Migrações aplicadas');

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Health check público (sem auth) — usado pelo Render para verificar deploy
  app.get('/health', (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  // Todas as demais rotas exigem X-Api-Key
  app.use(requireApiKey);

  app.use('/ingest', ingestRouter);
  app.use('/conversations', queryRouter);

  // Error handler
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error('[zap-api] Erro:', err);
      const message = err instanceof Error ? err.message : 'Erro interno';
      res.status(500).json({ error: message });
    },
  );

  app.listen(PORT, () => {
    console.log(`[zap-api] Servidor em http://localhost:${PORT}`);
    console.log(`[zap-api] Ingest:  POST /ingest/contacts|conversations|messages`);
    console.log(`[zap-api] Query:   GET  /conversations/summary|updated|:id/full`);
  });
}

main().catch((err) => {
  console.error('[zap-api] Erro fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Criar `render.yaml`**

```yaml
services:
  - type: web
    name: zap-api
    env: node
    region: oregon
    plan: free
    buildCommand: npm install && npm run build
    startCommand: node dist/index.js
    envVars:
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL
        fromDatabase:
          name: zap-db
          property: connectionString
      - key: COLLECTOR_API_KEY
        sync: false  # preencher manualmente no dashboard do Render

databases:
  - name: zap-db
    plan: free
    region: oregon
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/shelfspy/zap-api && npm run typecheck 2>&1
```

Esperado: zero erros TypeScript.

- [ ] **Step 4: Teste de smoke local (requer PostgreSQL local ou Render)**

```bash
cd /Users/shelfspy/zap-api
# Com DATABASE_URL preenchido no .env:
npm run dev
```

Em outro terminal:

```bash
# Health check
curl http://localhost:3001/health
# Esperado: {"ok":true,"ts":"..."}

# Teste de auth
curl http://localhost:3001/conversations/summary
# Esperado: 401 {"error":"Unauthorized..."}

# Teste com chave
curl -H "X-Api-Key: sua-chave-aqui" http://localhost:3001/conversations/summary
# Esperado: {"data":[],"pagination":{"page":1,"limit":50,"total":0,"has_next":false,"next_cursor":null}}
```

- [ ] **Step 5: Commit final**

```bash
cd /Users/shelfspy/zap-api
git add src/index.ts render.yaml
git commit -m "feat: Express entry point and render.yaml deploy config"
```

---

## Task 8: Deploy no Render

- [ ] **Step 1: Criar repositório no GitHub**

```bash
cd /Users/shelfspy/zap-api
gh repo create zap-api --private --source=. --remote=origin --push
```

- [ ] **Step 2: Deploy via Render Dashboard**

1. Acesse https://dashboard.render.com → **New** → **Blueprint**
2. Conecte o repositório `zap-api`
3. O Render detecta o `render.yaml` automaticamente
4. Clique em **Apply** — isso cria o Web Service + PostgreSQL juntos
5. Após deploy, acesse **Environment** → preencha `COLLECTOR_API_KEY` com o valor gerado (`openssl rand -hex 32`)
6. O mesmo valor deve ir em `RENDER_API_KEY` no `.env` do coletor local

- [ ] **Step 3: Verificar deploy**

```bash
curl https://zap-api.onrender.com/health
# Esperado: {"ok":true,"ts":"..."}
```

- [ ] **Step 4: Atualizar `.env` do coletor com URL do Render**

No arquivo `/Users/shelfspy/zap-classificator/.env`:

```
RENDER_API_URL=https://zap-api.onrender.com
RENDER_API_KEY=<mesmo valor de COLLECTOR_API_KEY no Render>
```

---

## Self-Review

### Cobertura dos requisitos

| Requisito | Task | Status |
|---|---|---|
| POST /ingest/contacts (upsert idempotente) | Task 4 | ✓ |
| POST /ingest/conversations (upsert preservando contact_id) | Task 4 | ✓ |
| POST /ingest/messages (INSERT OR IGNORE) | Task 4 | ✓ |
| GET /conversations/summary paginado | Task 6 | ✓ |
| GET /conversations/updated com sync_token +1ms | Task 6 | ✓ |
| GET /conversations/:id/full com cursor before | Task 6 | ✓ |
| Auth X-Api-Key em todas as rotas não-health | Task 3 + Task 7 | ✓ |
| /health público para Render health check | Task 7 | ✓ |
| Migração automática ao iniciar | Task 7 | ✓ |
| render.yaml com PostgreSQL incluído | Task 7 | ✓ |
| Schema PG espelha SQLite do coletor | Task 2 | ✓ |
| Tipos 0\|1 convertidos para boolean no PG | Task 4 | ✓ |

### Risco

**Plano free do Render hiberna após 15min de inatividade.** O primeiro request após hibernação leva ~30s para cold start. O Manus faz polling a cada 2min — isso acorda o serviço regularmente, então na prática não hibernará durante operação normal. Mas no primeiro acesso após inatividade noturna haverá delay.

**Solução futura:** Render tem plano pago ($7/mês) que desabilita hibernação. Para produção real, recomendar o upgrade.
