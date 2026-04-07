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
  is_business: number | null;
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
  is_business: number | null;
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
  has_media: number | null;
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
  has_media: number | null;
  media_url: string | null;
  media_mime: string | null;
  quoted_message_id: string | null;
  is_forwarded: number | null;
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
      // +1ms evita que o Manus receba o mesmo item na próxima chamada (gte inclui o limite)
      const syncToken = lastItem?.last_message_at
        ? new Date(lastItem.last_message_at + 1).toISOString()
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
