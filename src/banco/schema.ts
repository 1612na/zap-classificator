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
