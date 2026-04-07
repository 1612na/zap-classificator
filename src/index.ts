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
