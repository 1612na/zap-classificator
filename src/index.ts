import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db } from './banco/db.js'
import {
  upsertContact,
  upsertConversation,
  upsertMessage,
  ensureContactStub,
} from './banco/repository.js'
import { normalizeContact, normalizeChat, normalizeMessage } from './ingestao/normalizer.js'
import { bus } from './shared/events.js'
import { createConnection } from './whatsapp/auth.js'
import { startScheduler } from './scheduler/index.js'
import { startDashboard } from './dashboard/api.js'

async function main(): Promise<void> {
  // 1. Ensure DB schema is up to date (idempotent — safe to run on every start)
  migrate(db, { migrationsFolder: './drizzle' })
  console.log('[index] Banco de dados inicializado')

  // 2. Persist domain events to SQLite via normalizer → repository pipeline
  bus.on('message:received', (e) => {
    console.log('[bus] message:received', {
      id: e.id,
      chatId: e.chatId,
      type: e.type,
      messageType: e.messageType,
    })
    try {
      // Guarantee the conversation row exists before inserting the message
      // (messages.chat_id → conversations.id FK).  If chat:updated has not
      // fired yet, this creates a minimal stub that will be enriched later.
      const now = Date.now()
      const isGroup = e.chatId.endsWith('@g.us')
      upsertConversation(db, {
        id: e.chatId,
        contact_id: null,   // populated when chat:updated arrives
        name: null,
        is_group: isGroup ? 1 : 0,
        last_message_at: e.timestamp,
        unread_count: 0,
        created_at: now,
        updated_at: now,
      })
      upsertMessage(db, normalizeMessage(e))
    } catch (err) {
      console.error('[bus] message:received persist error', err)
    }
  })

  bus.on('chat:updated', (e) => {
    console.log('[bus] chat:updated', { id: e.id, unreadCount: e.unreadCount })
    try {
      const normalized = normalizeChat(e)
      // If the conversation links to a contact, guarantee that contact exists
      // before the FK constraint is evaluated (conversations.contact_id →
      // contacts.id).  A stub row is sufficient; upsertContact fills it later.
      if (normalized.contact_id !== null) {
        ensureContactStub(db, normalized.contact_id)
      }
      upsertConversation(db, normalized)
    } catch (err) {
      console.error('[bus] chat:updated persist error', err)
    }
  })

  bus.on('contact:updated', (e) => {
    console.log('[bus] contact:updated', { id: e.id, name: e.name })
    try {
      upsertContact(db, normalizeContact(e))
    } catch (err) {
      console.error('[bus] contact:updated persist error', err)
    }
  })

  // 3. Start scheduler (runs independently of WhatsApp connection state)
  startScheduler(db)

  // 4. Start dashboard API
  startDashboard()

  // 5. Start WhatsApp connection (handles QR, auth, reconnect)
  console.log('[index] Iniciando conexão WhatsApp…')
  await createConnection()
}

main().catch((err) => {
  console.error('[index] Erro fatal:', err)
  process.exit(1)
})
