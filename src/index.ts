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
