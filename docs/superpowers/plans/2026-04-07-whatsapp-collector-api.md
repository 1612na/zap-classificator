# WhatsApp Collector API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refatorar o zap-classificator para ser um coletor puro de dados WhatsApp que expõe uma API REST consumível pelo CRM IR Audit (Manus IA), removendo toda a lógica de classificação própria.

**Architecture:** O sistema mantém Baileys para captura de eventos WhatsApp, persiste dados no SQLite via drizzle-orm, e expõe três endpoints REST para que o Manus faça triagem (summary paginado), ingestão completa (full com paginação por cursor) e sync incremental. Nenhuma classificação é feita localmente.

**Tech Stack:** Node.js 20+, TypeScript ESM, @whiskeysockets/baileys, better-sqlite3, drizzle-orm, Express 4.

---

## Mapa de Arquivos

| Arquivo | Ação | Responsabilidade nova |
|---|---|---|
| `src/banco/schema.ts` | Modificar | Remover classifications/classificationHistory; adicionar campos a contacts e messages |
| `src/shared/types.ts` | Modificar | Remover ClassificationResult; atualizar DTOs; adicionar tipos da resposta da API |
| `src/shared/events.ts` | Modificar | Adicionar push_name, about a ContactUpdatedEvent; campos de mídia a MessageReceivedEvent |
| `src/whatsapp/listener.ts` | Modificar | Capturar push_name, about, sender_jid, campos de mídia |
| `src/ingestao/normalizer.ts` | Modificar | Mapear os novos campos dos eventos para os DTOs |
| `src/banco/repository.ts` | Modificar | Remover funções de classificação; manter upserts |
| `src/dashboard/api.ts` | Substituir | Nova API com 4 endpoints contrato Manus |
| `src/index.ts` | Modificar | Remover scheduler e classificacao; inicializar só Baileys + banco + API |
| `src/classificacao/` | Deletar | — |
| `src/scheduler/` | Deletar | — |
| `src/dashboard/frontend/` | Deletar | — |
| `drizzle/` | Resetar | Deletar migrações antigas; gerar nova do zero |

---

## Task 1: Resetar migrações e reescrever schema

**Files:**
- Modify: `src/banco/schema.ts`
- Delete: `drizzle/` (migrações antigas)

- [ ] **Step 1: Deletar migrações antigas**

```bash
rm -rf /Users/shelfspy/zap-classificator/drizzle
```

- [ ] **Step 2: Reescrever `src/banco/schema.ts` completo**

```typescript
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

// contacts — número limpo sem @s.whatsapp.net como PK
export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),              // e.g. "5511999998888"
  name: text('name'),                        // nome na agenda do dispositivo
  push_name: text('push_name'),              // nome exibido no WhatsApp pelo contato
  display_name: text('display_name'),        // verifiedName para contas business
  is_business: integer('is_business').default(0),
  avatar_url: text('avatar_url'),
  about: text('about'),                      // texto de status do contato
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
});

// conversations — JID completo como PK
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),             // e.g. "5511999998888@s.whatsapp.net"
    contact_id: text('contact_id').references(() => contacts.id),
    name: text('name'),
    is_group: integer('is_group').default(0),
    last_message_at: integer('last_message_at'), // Unix ms
    unread_count: integer('unread_count').default(0),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (table) => [index('conversations_last_message_at_idx').on(table.last_message_at)],
);

// messages — ID único do WhatsApp como PK
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    chat_id: text('chat_id').notNull().references(() => conversations.id),
    sender_jid: text('sender_jid'),          // null se from_me; JID do remetente em grupos
    from_me: integer('from_me').notNull(),   // 0 | 1
    timestamp: integer('timestamp').notNull(), // Unix ms
    text: text('text'),                       // null para mídia sem legenda
    message_type: text('message_type').notNull(), // raw Baileys key: imageMessage, etc.
    has_media: integer('has_media').default(0),   // 0 | 1
    media_url: text('media_url'),
    media_mime: text('media_mime'),
    is_forwarded: integer('is_forwarded').default(0), // 0 | 1
    quoted_message_id: text('quoted_message_id'),
    raw_payload: text('raw_payload').notNull(),
    created_at: integer('created_at').notNull(),
  },
  (table) => [
    index('messages_chat_id_idx').on(table.chat_id),
    index('messages_timestamp_idx').on(table.timestamp),
  ],
);

// sync_runs — log de execuções para diagnóstico
export const syncRuns = sqliteTable('sync_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  run_type: text('run_type').notNull(),
  started_at: integer('started_at').notNull(),
  finished_at: integer('finished_at'),
  conversations_processed: integer('conversations_processed').default(0),
  messages_ingested: integer('messages_ingested').default(0),
  error: text('error'),
  status: text('status').default('running'),
});
```

- [ ] **Step 3: Gerar nova migração drizzle**

```bash
cd /Users/shelfspy/zap-classificator && npm run db:generate
```

Esperado: cria `drizzle/0000_*.sql` com o novo schema.

- [ ] **Step 4: Apagar DB antigo (se existir) e rodar migração**

```bash
rm -f /Users/shelfspy/zap-classificator/data/db.sqlite
npm run db:migrate
```

Esperado: `drizzle-kit migrate` cria `data/db.sqlite` com o novo schema.

- [ ] **Step 5: Commit**

```bash
git add src/banco/schema.ts drizzle/
git commit -m "feat: rewrite schema — remove classifications, add media/contact fields"
```

---

## Task 2: Atualizar tipos e contratos de eventos

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/events.ts`

- [ ] **Step 1: Reescrever `src/shared/types.ts`**

```typescript
// ---------------------------------------------------------------------------
// DTOs internos — usados entre ingestao/ e banco/
// ---------------------------------------------------------------------------

export interface NormalizedMessage {
  id: string;
  chat_id: string;
  sender_jid: string | null;
  from_me: 0 | 1;
  timestamp: number;         // Unix ms
  text: string | null;
  message_type: string;      // raw Baileys key
  has_media: 0 | 1;
  media_url: string | null;
  media_mime: string | null;
  is_forwarded: 0 | 1;
  quoted_message_id: string | null;
  raw_payload: string;       // JSON bruto do objeto Baileys
  created_at: number;        // Unix ms
}

export interface NormalizedChat {
  id: string;                // full JID
  contact_id: string | null; // null para grupos
  name: string | null;
  is_group: 0 | 1;
  last_message_at: number | null; // Unix ms
  unread_count: number;
  created_at: number;
  updated_at: number;
}

export interface NormalizedContact {
  id: string;                // número limpo, sem JID suffix
  name: string | null;
  push_name: string | null;
  display_name: string | null;
  is_business: 0 | 1;
  avatar_url: string | null;
  about: string | null;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Tipos da resposta da API (contratos com o CRM Manus)
// ---------------------------------------------------------------------------

export type ApiMessageType = 'text' | 'image' | 'document' | 'audio' | 'video' | 'sticker';

export interface ApiContact {
  phone: string;             // E.164, ex: "+5511999998888"
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
  from: string;              // JID do remetente ou "me"
  direction: 'inbound' | 'outbound';
  type: ApiMessageType;
  text: string | null;
  timestamp: string;         // ISO 8601 UTC
  has_media: boolean;
}

export interface ApiMessageFull extends ApiMessage {
  media_url: string | null;
  media_mime: string | null;
  quoted_message_id: string | null;
  is_forwarded: boolean;
}

export interface ConversationSummary {
  conversation_id: string;
  type: 'individual' | 'group';
  contact: ApiContact;
  last_message_at: string;   // ISO 8601 UTC
  message_count: number;
  unread_count: number;
  sample_messages: ApiMessage[];
}

export interface ConversationFull {
  conversation_id: string;
  type: 'individual' | 'group';
  contact: ApiContactFull;
  created_at: string;        // ISO 8601 UTC
  last_message_at: string;   // ISO 8601 UTC
  message_count: number;
  messages: ApiMessageFull[];
}

export interface PaginatedSummaryResponse {
  data: ConversationSummary[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    has_next: boolean;
    next_cursor: string | null;
  };
}

export interface IncrementalSyncItem {
  conversation_id: string;
  last_message_at: string;   // ISO 8601 UTC
}

export interface IncrementalSyncResponse {
  data: IncrementalSyncItem[];
  sync_token: string | null;
}
```

- [ ] **Step 2: Atualizar `src/shared/events.ts` — adicionar campos novos**

Localizar o tipo `MessageReceivedEvent` e acrescentar os campos de mídia:

```typescript
export interface MessageReceivedEvent {
  id: string;
  chatId: string;
  senderJid: string | null;   // NOVO: JID do remetente em grupos; null se from_me
  fromMe: boolean;
  timestamp: number;
  text: string | null;
  messageType: string;
  hasMedia: boolean;           // NOVO
  mediaUrl: string | null;     // NOVO
  mediaMime: string | null;    // NOVO
  isForwarded: boolean;        // NOVO
  quotedMessageId: string | null; // NOVO
  rawPayload: string;
  type: string;                // Baileys upsert type: "notify" | "append"
}
```

Localizar o tipo `ContactUpdatedEvent` e acrescentar:

```typescript
export interface ContactUpdatedEvent {
  id: string;
  name: string | null;
  pushName: string | null;     // NOVO: contact.notify
  displayName: string | null;
  isBusiness: boolean;
  avatarUrl: string | null;    // NOVO
  about: string | null;        // NOVO: contact.status
}
```

- [ ] **Step 3: Typecheck após mudanças**

```bash
cd /Users/shelfspy/zap-classificator && npm run typecheck 2>&1 | head -40
```

Esperado: erros em listener.ts e normalizer.ts (ainda não atualizados) — OK neste momento.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/shared/events.ts
git commit -m "feat: update shared types and event contracts for collector API"
```

---

## Task 3: Atualizar listener Baileys

**Files:**
- Modify: `src/whatsapp/listener.ts`

- [ ] **Step 1: Reescrever `src/whatsapp/listener.ts` completo**

```typescript
import type { WASocket, proto } from '@whiskeysockets/baileys'
import { bus } from '../shared/events.js'
import type {
  MessageReceivedEvent,
  ChatUpdatedEvent,
  ContactUpdatedEvent,
} from '../shared/events.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(message: proto.IMessage | null | undefined): string | null {
  if (!message) return null
  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    null
  )
}

const MESSAGE_TYPE_PRIORITY: ReadonlyArray<keyof proto.IMessage> = [
  'conversation',
  'extendedTextMessage',
  'imageMessage',
  'videoMessage',
  'documentMessage',
  'audioMessage',
  'stickerMessage',
  'reactionMessage',
  'buttonsMessage',
  'templateMessage',
  'listMessage',
]

function getMessageType(message: proto.IMessage | null | undefined): string {
  if (!message) return 'unknown'
  const prioritized = MESSAGE_TYPE_PRIORITY.find((k) => message[k] != null)
  if (prioritized) return prioritized
  return Object.keys(message).find((k) => message[k as keyof proto.IMessage] != null) ?? 'unknown'
}

function hasMedia(msgType: string): boolean {
  return ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage'].includes(msgType)
}

function getMediaUrl(message: proto.IMessage | null | undefined, msgType: string): string | null {
  if (!message) return null
  switch (msgType) {
    case 'imageMessage': return message.imageMessage?.url ?? null
    case 'videoMessage': return message.videoMessage?.url ?? null
    case 'documentMessage': return message.documentMessage?.url ?? null
    case 'audioMessage': return message.audioMessage?.url ?? null
    default: return null
  }
}

function getMediaMime(message: proto.IMessage | null | undefined, msgType: string): string | null {
  if (!message) return null
  switch (msgType) {
    case 'imageMessage': return message.imageMessage?.mimetype ?? null
    case 'videoMessage': return message.videoMessage?.mimetype ?? null
    case 'documentMessage': return message.documentMessage?.mimetype ?? null
    case 'audioMessage': return message.audioMessage?.mimetype ?? null
    default: return null
  }
}

function getContextInfo(message: proto.IMessage | null | undefined): proto.IContextInfo | null | undefined {
  if (!message) return null
  return (
    message.extendedTextMessage?.contextInfo ??
    message.imageMessage?.contextInfo ??
    message.videoMessage?.contextInfo ??
    message.documentMessage?.contextInfo ??
    null
  )
}

/** Strips JID suffix and device suffix from a JID string */
function cleanJid(jid: string): string {
  return jid.replace(/:\d+$/, '').replace(/@.*$/, '')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function registerListeners(sock: WASocket): void {
  // ── messages.upsert ──────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const msg of messages) {
      const { id, remoteJid, fromMe, participant } = msg.key
      if (!id || !remoteJid) continue

      const tsRaw = msg.messageTimestamp
      const tsMs =
        tsRaw == null
          ? Date.now()
          : (typeof tsRaw === 'number' ? tsRaw : Number(tsRaw)) * 1000

      const msgType = getMessageType(msg.message)
      const contextInfo = getContextInfo(msg.message)

      // Em grupos, participant é o remetente; em individual, é null quando from_me
      const senderJid = fromMe
        ? null
        : (participant ?? remoteJid)

      const event: MessageReceivedEvent = {
        id,
        chatId: remoteJid,
        senderJid,
        fromMe: fromMe ?? false,
        timestamp: tsMs,
        text: extractText(msg.message),
        messageType: msgType,
        hasMedia: hasMedia(msgType),
        mediaUrl: getMediaUrl(msg.message, msgType),
        mediaMime: getMediaMime(msg.message, msgType),
        isForwarded: Boolean(contextInfo?.isForwarded),
        quotedMessageId: contextInfo?.stanzaId ?? null,
        rawPayload: JSON.stringify(msg),
        type,
      }

      bus.emit('message:received', event)
      console.log(`[listener] message:received  chat=${event.chatId}  type=${event.messageType}  fromMe=${event.fromMe}`)
    }
  })

  // ── chats.upsert ─────────────────────────────────────────────────────────
  sock.ev.on('chats.upsert', (chats) => {
    for (const chat of chats) {
      const tsRaw = chat.conversationTimestamp
      const lastMessageTime =
        tsRaw == null
          ? null
          : (typeof tsRaw === 'number' ? tsRaw : Number(tsRaw)) * 1000

      const event: ChatUpdatedEvent = {
        id: chat.id,
        name: chat.name ?? null,
        unreadCount: chat.unreadCount ?? 0,
        lastMessageTime,
      }

      bus.emit('chat:updated', event)
      console.log(`[listener] chat:updated  id=${event.id}  name=${event.name ?? '(sem nome)'}`)
    }
  })

  // ── chats.update ─────────────────────────────────────────────────────────
  sock.ev.on('chats.update', (chats) => {
    for (const chat of chats) {
      if (!chat.id) continue

      const tsRaw = chat.conversationTimestamp
      const lastMessageTime =
        tsRaw == null
          ? null
          : (typeof tsRaw === 'number' ? tsRaw : Number(tsRaw)) * 1000

      const event: ChatUpdatedEvent = {
        id: chat.id,
        name: chat.name ?? null,
        unreadCount: chat.unreadCount ?? 0,
        lastMessageTime,
      }

      bus.emit('chat:updated', event)
      console.log(`[listener] chat:updated (update)  id=${event.id}`)
    }
  })

  // ── contacts.upsert ──────────────────────────────────────────────────────
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) {
      const c = contact as unknown as Record<string, unknown>
      const event: ContactUpdatedEvent = {
        id: cleanJid(contact.id),
        name: contact.name ?? null,
        pushName: contact.notify ?? null,
        displayName:
          (c['verifiedName'] as string | undefined) ?? null,
        isBusiness: Boolean(c['isBusiness']),
        avatarUrl: null,    // não buscar proativamente — risco de ban
        about: (c['status'] as string | undefined) ?? null,
      }

      bus.emit('contact:updated', event)
      console.log(`[listener] contact:updated  id=${event.id}  name=${event.name ?? '(sem nome)'}`)
    }
  })
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/shelfspy/zap-classificator && npm run typecheck 2>&1 | grep "listener\|normalizer\|events" | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/whatsapp/listener.ts
git commit -m "feat: capture media info, push_name, about, sender_jid in listener"
```

---

## Task 4: Atualizar normalizer

**Files:**
- Modify: `src/ingestao/normalizer.ts`

- [ ] **Step 1: Reescrever `src/ingestao/normalizer.ts` completo**

```typescript
import type {
  MessageReceivedEvent,
  ChatUpdatedEvent,
  ContactUpdatedEvent,
} from '../shared/events.js';
import type {
  NormalizedMessage,
  NormalizedChat,
  NormalizedContact,
} from '../shared/types.js';

export type { NormalizedMessage, NormalizedChat, NormalizedContact };

function extractContactId(jid: string): string | null {
  if (jid.endsWith('@g.us')) return null;
  const atIndex = jid.indexOf('@');
  return atIndex === -1 ? jid : jid.slice(0, atIndex);
}

export function normalizeMessage(event: MessageReceivedEvent): NormalizedMessage {
  return {
    id: event.id,
    chat_id: event.chatId,
    sender_jid: event.senderJid,
    from_me: event.fromMe ? 1 : 0,
    timestamp: event.timestamp,
    text: event.text,
    message_type: event.messageType,
    has_media: event.hasMedia ? 1 : 0,
    media_url: event.mediaUrl,
    media_mime: event.mediaMime,
    is_forwarded: event.isForwarded ? 1 : 0,
    quoted_message_id: event.quotedMessageId,
    raw_payload: event.rawPayload,
    created_at: Date.now(),
  };
}

export function normalizeChat(event: ChatUpdatedEvent): NormalizedChat {
  const isGroup = event.id.endsWith('@g.us');
  const now = Date.now();
  return {
    id: event.id,
    contact_id: isGroup ? null : extractContactId(event.id),
    name: event.name,
    is_group: isGroup ? 1 : 0,
    last_message_at: event.lastMessageTime,
    unread_count: event.unreadCount,
    created_at: now,
    updated_at: now,
  };
}

export function normalizeContact(event: ContactUpdatedEvent): NormalizedContact {
  const now = Date.now();
  return {
    id: event.id,
    name: event.name,
    push_name: event.pushName,
    display_name: event.displayName,
    is_business: event.isBusiness ? 1 : 0,
    avatar_url: event.avatarUrl,
    about: event.about,
    created_at: now,
    updated_at: now,
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/shelfspy/zap-classificator && npm run typecheck 2>&1 | head -30
```

- [ ] **Step 3: Commit**

```bash
git add src/ingestao/normalizer.ts
git commit -m "feat: update normalizer to map new media and contact fields"
```

---

## Task 5: Atualizar repository

**Files:**
- Modify: `src/banco/repository.ts`

- [ ] **Step 1: Reescrever `src/banco/repository.ts` — remover classificação, manter upserts**

```typescript
import { sql, eq } from 'drizzle-orm';
import { contacts, conversations, messages } from './schema.js';
import type { Database } from './db.js';
import type { NormalizedContact, NormalizedChat, NormalizedMessage } from '../shared/types.js';

// ---------------------------------------------------------------------------
// upsertContact
// ---------------------------------------------------------------------------

export function upsertContact(db: Database, contact: NormalizedContact): void {
  db.insert(contacts)
    .values(contact)
    .onConflictDoUpdate({
      target: contacts.id,
      set: {
        name: contact.name,
        push_name: contact.push_name,
        display_name: contact.display_name,
        is_business: contact.is_business,
        avatar_url: contact.avatar_url,
        about: contact.about,
        updated_at: contact.updated_at,
      },
    })
    .run();
}

// ---------------------------------------------------------------------------
// upsertConversation
// ---------------------------------------------------------------------------

export function upsertConversation(db: Database, chat: NormalizedChat): void {
  db.insert(conversations)
    .values(chat)
    .onConflictDoUpdate({
      target: conversations.id,
      set: {
        contact_id: sql`CASE WHEN ${chat.contact_id} IS NOT NULL THEN ${chat.contact_id} ELSE ${conversations.contact_id} END`,
        last_message_at: chat.last_message_at,
        unread_count: chat.unread_count,
        name: chat.name,
        updated_at: chat.updated_at,
      },
    })
    .run();
}

// ---------------------------------------------------------------------------
// ensureContactStub — FK-guard antes de upsertConversation
// ---------------------------------------------------------------------------

export function ensureContactStub(db: Database, contactId: string): void {
  const now = Date.now();
  db.insert(contacts)
    .values({
      id: contactId,
      name: null,
      push_name: null,
      display_name: null,
      is_business: 0,
      avatar_url: null,
      about: null,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing()
    .run();
}

// ---------------------------------------------------------------------------
// upsertMessage — INSERT OR IGNORE (mensagem é imutável)
// ---------------------------------------------------------------------------

export function upsertMessage(db: Database, message: NormalizedMessage): void {
  db.insert(messages).values(message).onConflictDoNothing().run();
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/shelfspy/zap-classificator && npm run typecheck 2>&1 | head -30
```

Esperado: zero erros (ou apenas em api.ts que ainda não foi reescrito).

- [ ] **Step 3: Commit**

```bash
git add src/banco/repository.ts
git commit -m "feat: simplify repository — remove classification functions"
```

---

## Task 6: Reescrever API REST (contrato Manus)

**Files:**
- Modify: `src/dashboard/api.ts` (substituição total)

A API implementa exatamente o contrato do documento `contrato_tecnico_baileys_crm.docx`:
- `GET /conversations/summary` — triagem paginada (50/página, máx 100)
- `GET /conversations/updated` — sync incremental com sync_token
- `GET /conversations/:id/full` — histórico completo com cursor `before`
- `GET /auth/qr` — estado da conexão WhatsApp
- `GET /qr` — página HTML de scan do QR

**Nota crítica:** `/conversations/updated` deve ser registrado ANTES de `/conversations/:id` para que o Express não interprete "updated" como um `:id`.

- [ ] **Step 1: Reescrever `src/dashboard/api.ts` completo**

```typescript
import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'path';
import { desc, gte, lt, eq, sql, and } from 'drizzle-orm';
import { db } from '../banco/db.js';
import { conversations, contacts, messages } from '../banco/schema.js';
import { bus } from '../shared/events.js';
import type {
  ConversationSummary,
  ConversationFull,
  PaginatedSummaryResponse,
  IncrementalSyncResponse,
  ApiContact,
  ApiContactFull,
  ApiMessage,
  ApiMessageFull,
  ApiMessageType,
} from '../shared/types.js';

// ---------------------------------------------------------------------------
// QR state
// ---------------------------------------------------------------------------

let currentQr: string | null = null;
let whatsappStatus: 'pending' | 'connected' = 'pending';

bus.on('whatsapp:qr', ({ qr }) => { currentQr = qr; whatsappStatus = 'pending'; });
bus.on('whatsapp:connected', () => { currentQr = null; whatsappStatus = 'connected'; });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function parseIntParam(raw: unknown, def: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : def;
}

function toE164(rawPhone: string): string {
  return rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;
}

const MSG_TYPE_MAP: Record<string, ApiMessageType> = {
  conversation: 'text',
  extendedTextMessage: 'text',
  imageMessage: 'image',
  videoMessage: 'video',
  documentMessage: 'document',
  audioMessage: 'audio',
  stickerMessage: 'sticker',
};

function mapMsgType(raw: string): ApiMessageType {
  return MSG_TYPE_MAP[raw] ?? 'text';
}

/** Builds "from" field: JID do remetente ou "me" */
function buildFrom(row: { from_me: number; sender_jid: string | null; chat_id: string }): string {
  if (row.from_me === 1) return 'me';
  return row.sender_jid ?? row.chat_id;
}

function buildApiContact(row: {
  id: string;
  name: string | null;
  push_name: string | null;
  is_business: number;
  avatar_url: string | null;
}): ApiContact {
  return {
    phone: toE164(row.id),
    name: row.name,
    push_name: row.push_name,
    is_business: row.is_business === 1,
    avatar_url: row.avatar_url,
  };
}

function buildApiContactFull(row: {
  id: string;
  name: string | null;
  push_name: string | null;
  is_business: number;
  avatar_url: string | null;
  about: string | null;
}): ApiContactFull {
  return { ...buildApiContact(row), about: row.about };
}

function buildApiMessage(row: {
  id: string;
  from_me: number;
  sender_jid: string | null;
  chat_id: string;
  message_type: string;
  text: string | null;
  timestamp: number;
  has_media: number;
}): ApiMessage {
  return {
    id: row.id,
    from: buildFrom(row),
    direction: row.from_me === 1 ? 'outbound' : 'inbound',
    type: mapMsgType(row.message_type),
    text: row.text,
    timestamp: new Date(row.timestamp).toISOString(),
    has_media: row.has_media === 1,
  };
}

function buildApiMessageFull(row: {
  id: string;
  from_me: number;
  sender_jid: string | null;
  chat_id: string;
  message_type: string;
  text: string | null;
  timestamp: number;
  has_media: number;
  media_url: string | null;
  media_mime: string | null;
  quoted_message_id: string | null;
  is_forwarded: number;
}): ApiMessageFull {
  return {
    ...buildApiMessage(row),
    media_url: row.media_url,
    media_mime: row.media_mime,
    quoted_message_id: row.quoted_message_id,
    is_forwarded: row.is_forwarded === 1,
  };
}

// Fallback contact para conversas sem contato associado (grupos ou contatos não sincronizados)
const UNKNOWN_CONTACT: ApiContactFull = {
  phone: '+0',
  name: null,
  push_name: null,
  is_business: false,
  avatar_url: null,
  about: null,
};

// ---------------------------------------------------------------------------
// createApp
// ---------------------------------------------------------------------------

export function createApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(import.meta.dirname, 'frontend')));

  // -------------------------------------------------------------------------
  // GET /conversations/summary
  // Triagem paginada — 10 mensagens mais recentes por conversa.
  // Query params: page, limit, since (alias: updated_after)
  // -------------------------------------------------------------------------
  app.get('/conversations/summary', (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(1, parseIntParam(req.query['page'], 1));
      const limit = clamp(parseIntParam(req.query['limit'], 50), 1, 100);
      const offset = (page - 1) * limit;

      const sinceRaw = req.query['since'] ?? req.query['updated_after'];
      const sinceMs = sinceRaw ? new Date(String(sinceRaw)).getTime() : null;

      const whereClause = sinceMs && Number.isFinite(sinceMs)
        ? gte(conversations.last_message_at, sinceMs)
        : undefined;

      // Total para paginação
      const totalRow = db
        .select({ count: sql<number>`count(*)` })
        .from(conversations)
        .where(whereClause)
        .get();
      const total = totalRow?.count ?? 0;

      // Conversas paginadas com join em contacts
      const rows = db
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
        .offset(offset)
        .all();

      const data: ConversationSummary[] = rows.map((row) => {
        // message_count via subquery
        const countRow = db
          .select({ count: sql<number>`count(*)` })
          .from(messages)
          .where(eq(messages.chat_id, row.id))
          .get();

        // 10 mensagens mais recentes
        const sampleRows = db
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
          .limit(10)
          .all();

        const contact: ApiContact = row.contact_id
          ? {
              phone: toE164(row.contact_id),
              name: row.contact_name,
              push_name: row.contact_push_name,
              is_business: (row.contact_is_business ?? 0) === 1,
              avatar_url: row.contact_avatar_url,
            }
          : UNKNOWN_CONTACT;

        return {
          conversation_id: row.id,
          type: row.is_group === 1 ? 'group' : 'individual',
          contact,
          last_message_at: row.last_message_at
            ? new Date(row.last_message_at).toISOString()
            : new Date(0).toISOString(),
          message_count: countRow?.count ?? 0,
          unread_count: row.unread_count ?? 0,
          sample_messages: sampleRows.map(buildApiMessage),
        };
      });

      const lastItem = rows[rows.length - 1];
      const nextCursor = lastItem?.last_message_at
        ? new Date(lastItem.last_message_at).toISOString()
        : null;

      const response: PaginatedSummaryResponse = {
        data,
        pagination: {
          page,
          limit,
          total,
          has_next: offset + rows.length < total,
          next_cursor: nextCursor,
        },
      };

      res.json(response);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /conversations/updated
  // Sync incremental — conversas atualizadas após "since".
  // IMPORTANTE: registrar ANTES de /conversations/:id para evitar conflito de rota.
  // -------------------------------------------------------------------------
  app.get('/conversations/updated', (req: Request, res: Response, next: NextFunction) => {
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

      const rows = db
        .select({
          id: conversations.id,
          last_message_at: conversations.last_message_at,
        })
        .from(conversations)
        .where(gte(conversations.last_message_at, sinceMs))
        .orderBy(conversations.last_message_at)
        .limit(limit)
        .all();

      const lastItem = rows[rows.length - 1];
      const syncToken = lastItem?.last_message_at
        ? new Date(lastItem.last_message_at).toISOString()
        : null;

      const response: IncrementalSyncResponse = {
        data: rows.map((r) => ({
          conversation_id: r.id,
          last_message_at: r.last_message_at
            ? new Date(r.last_message_at).toISOString()
            : new Date(0).toISOString(),
        })),
        sync_token: syncToken,
      };

      res.json(response);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /conversations/:id/full
  // Histórico completo com paginação por cursor "before".
  // -------------------------------------------------------------------------
  app.get('/conversations/:id/full', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const msgLimit = clamp(parseIntParam(req.query['limit'], 200), 1, 500);
      const beforeRaw = req.query['before'];
      const beforeMs = beforeRaw ? new Date(String(beforeRaw)).getTime() : null;

      const conv = db
        .select({
          id: conversations.id,
          is_group: conversations.is_group,
          last_message_at: conversations.last_message_at,
          created_at: conversations.created_at,
          unread_count: conversations.unread_count,
          contact_id: conversations.contact_id,
        })
        .from(conversations)
        .where(eq(conversations.id, id))
        .get();

      if (!conv) {
        res.status(404).json({ error: 'Conversa não encontrada' });
        return;
      }

      // Buscar contato completo (com about)
      const contactRow = conv.contact_id
        ? db.select().from(contacts).where(eq(contacts.id, conv.contact_id)).get()
        : null;

      const contact: ApiContactFull = contactRow
        ? buildApiContactFull(contactRow)
        : UNKNOWN_CONTACT;

      // Total de mensagens
      const countRow = db
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .where(eq(messages.chat_id, id))
        .get();

      // Mensagens com cursor before
      const msgWhere = beforeMs && Number.isFinite(beforeMs)
        ? and(eq(messages.chat_id, id), lt(messages.timestamp, beforeMs))
        : eq(messages.chat_id, id);

      const msgRows = db
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
        .limit(msgLimit)
        .all();

      const response: ConversationFull = {
        conversation_id: conv.id,
        type: conv.is_group === 1 ? 'group' : 'individual',
        contact,
        created_at: new Date(conv.created_at).toISOString(),
        last_message_at: conv.last_message_at
          ? new Date(conv.last_message_at).toISOString()
          : new Date(0).toISOString(),
        message_count: countRow?.count ?? 0,
        messages: msgRows.map(buildApiMessageFull),
      };

      res.json(response);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /auth/qr — estado da conexão para diagnóstico
  // -------------------------------------------------------------------------
  app.get('/auth/qr', (_req: Request, res: Response) => {
    res.json({ status: whatsappStatus, qr: currentQr });
  });

  // -------------------------------------------------------------------------
  // GET /qr — página HTML de scan (mantida para debug)
  // -------------------------------------------------------------------------
  app.get('/qr', (_req: Request, res: Response) => {
    res.sendFile(path.join(import.meta.dirname, 'frontend', 'qr.html'));
  });

  // -------------------------------------------------------------------------
  // Error handler
  // -------------------------------------------------------------------------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[api] Unhandled error:', err);
    const message = err instanceof Error ? err.message : 'Erro interno';
    res.status(500).json({ error: message });
  });

  return app;
}

export function startDashboard(port = Number(process.env['PORT']) || 3000): void {
  const app = createApp();
  app.listen(port, () => {
    console.log(`[api] REST API rodando em http://localhost:${port}`);
    console.log(`[api] Endpoints:`);
    console.log(`[api]   GET /conversations/summary?page=1&limit=50&since=ISO8601`);
    console.log(`[api]   GET /conversations/updated?since=ISO8601&limit=50`);
    console.log(`[api]   GET /conversations/:id/full?limit=200&before=ISO8601`);
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/shelfspy/zap-classificator && npm run typecheck 2>&1 | head -40
```

Esperado: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/api.ts
git commit -m "feat: implement Manus CRM REST API — summary, updated, full endpoints"
```

---

## Task 7: Limpar index.ts e remover módulos mortos

**Files:**
- Modify: `src/index.ts`
- Delete: `src/classificacao/`, `src/scheduler/`, `src/dashboard/frontend/app.js`

- [ ] **Step 1: Reescrever `src/index.ts`**

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
import { startDashboard } from './dashboard/api.js';

async function main(): Promise<void> {
  // 1. Garantir schema atualizado (idempotente)
  migrate(db, { migrationsFolder: './drizzle' });
  console.log('[index] Banco de dados inicializado');

  // 2. Persistir eventos do Baileys → normalizer → repository
  bus.on('message:received', (e) => {
    console.log('[bus] message:received', { id: e.id, chatId: e.chatId, type: e.messageType });
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
      upsertMessage(db, normalizeMessage(e));
    } catch (err) {
      console.error('[bus] message:received persist error', err);
    }
  });

  bus.on('chat:updated', (e) => {
    console.log('[bus] chat:updated', { id: e.id, unreadCount: e.unreadCount });
    try {
      const normalized = normalizeChat(e);
      if (normalized.contact_id !== null) {
        ensureContactStub(db, normalized.contact_id);
      }
      upsertConversation(db, normalized);
    } catch (err) {
      console.error('[bus] chat:updated persist error', err);
    }
  });

  bus.on('contact:updated', (e) => {
    console.log('[bus] contact:updated', { id: e.id, name: e.name });
    try {
      upsertContact(db, normalizeContact(e));
    } catch (err) {
      console.error('[bus] contact:updated persist error', err);
    }
  });

  // 3. Iniciar API REST
  startDashboard();

  // 4. Conectar ao WhatsApp
  console.log('[index] Iniciando conexão WhatsApp…');
  await createConnection();
}

main().catch((err) => {
  console.error('[index] Erro fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Remover módulos não utilizados**

```bash
rm -rf /Users/shelfspy/zap-classificator/src/classificacao
rm -rf /Users/shelfspy/zap-classificator/src/scheduler
rm -f /Users/shelfspy/zap-classificator/src/dashboard/frontend/app.js
```

- [ ] **Step 3: Typecheck final**

```bash
cd /Users/shelfspy/zap-classificator && npm run typecheck 2>&1
```

Esperado: zero erros TypeScript.

- [ ] **Step 4: Lint**

```bash
cd /Users/shelfspy/zap-classificator && npm run lint 2>&1
```

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git rm -r src/classificacao src/scheduler
git rm src/dashboard/frontend/app.js
git commit -m "feat: remove classificacao/scheduler, simplify index to collector-only"
```

---

## Task 8: Atualizar CLAUDE.md com novo estado do projeto

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Atualizar seção "Estado atual" no CLAUDE.md**

Localizar a seção `## Estado atual` e substituir pelo seguinte:

```markdown
## Estado atual (atualizado em 2026-04-07)

### Versão em andamento: **Collector API para CRM IR Audit (Manus IA)**

#### Responsabilidade do sistema
- Coletar dados WhatsApp via Baileys (somente leitura)
- Normalizar e persistir no SQLite
- Expor API REST para consumo pelo CRM Manus

#### Classificação: feita 100% pelo Manus — não implementada aqui

#### Endpoints implementados:
- `GET /conversations/summary?page=&limit=&since=` — triagem paginada (50/req)
- `GET /conversations/updated?since=&limit=` — sync incremental com sync_token
- `GET /conversations/:id/full?limit=&before=` — histórico completo com cursor

#### Módulos removidos:
- `src/classificacao/` — removido (Manus classifica)
- `src/scheduler/` — removido (Manus puxa via polling a cada 2min)
- `src/dashboard/frontend/app.js` — removido (Manus tem dashboard próprio)
```

- [ ] **Step 2: Commit final**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md — collector API for Manus CRM"
```

---

## Self-Review

### Cobertura do contrato técnico

| Requisito do contrato | Implementado | Onde |
|---|---|---|
| `GET /conversations/summary` com page/limit/since | ✓ | Task 6 |
| `GET /conversations/updated` com since + sync_token | ✓ | Task 6 |
| `GET /conversations/:id/full` com limit/before cursor | ✓ | Task 6 |
| 10 sample_messages mais recentes na triagem | ✓ | Task 6 |
| Campo `direction: inbound/outbound` | ✓ | Task 6 (`buildApiMessage`) |
| Campo `from` como JID ou "me" | ✓ | Task 6 (`buildFrom`) |
| Telefone em E.164 (`+5511...`) | ✓ | Task 6 (`toE164`) |
| Timestamps em ISO 8601 UTC | ✓ | Task 6 (`toISOString()`) |
| `has_media`, `media_mime` para triagem de PDFs | ✓ | Tasks 3–6 |
| `is_forwarded`, `quoted_message_id` no full | ✓ | Tasks 3–6 |
| `is_business`, `push_name`, `about` no contato | ✓ | Tasks 2–6 |
| Paginação com `pagination.total`, `has_next` | ✓ | Task 6 |
| `sender_jid` para mensagens de grupo | ✓ | Tasks 3–5 |
| Idempotência (INSERT OR IGNORE em messages) | ✓ | Task 5 |

### Verificação de placeholders

Nenhum "TBD" ou "TODO" encontrado no plano.

### Consistência de tipos

- `NormalizedMessage.has_media` → `0 | 1` (schema) ✓
- `ApiMessage.has_media` → `boolean` (API) ✓ (conversão em `buildApiMessage`)
- `buildApiMessageFull` estende `buildApiMessage` via spread ✓
- `toE164` usado em todos os pontos onde `phone` é exposto ✓
- `IncrementalSyncResponse.sync_token` é `string | null` ✓

### Risco identificado

**Performance do summary endpoint:** Para cada conversa na página (até 50), o endpoint faz 2 queries adicionais (COUNT e 10 mensagens). Isso resulta em até 101 queries por request. Para o volume esperado (sync a cada 2 min, 50 conversas/req) é aceitável no SQLite local. Se houver degradação, a solução é adicionar `message_count` como coluna desnormalizada em `conversations` — mas YAGNI por enquanto.
