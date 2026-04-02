import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// contacts — número limpo sem @s.whatsapp.net como PK
export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  name: text('name'),
  display_name: text('display_name'),
  is_business: integer('is_business').default(0),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
});

// conversations — JID completo como PK
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    contact_id: text('contact_id').references(() => contacts.id),
    name: text('name'),
    is_group: integer('is_group').default(0),
    last_message_at: integer('last_message_at'),
    unread_count: integer('unread_count').default(0),
    is_archived: integer('is_archived').default(0),
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
    chat_id: text('chat_id')
      .notNull()
      .references(() => conversations.id),
    from_me: integer('from_me').notNull(),
    timestamp: integer('timestamp').notNull(), // Unix ms
    text: text('text'), // null para mídia sem legenda
    message_type: text('message_type').notNull(),
    raw_payload: text('raw_payload').notNull(), // JSON bruto do objeto Baileys
    created_at: integer('created_at').notNull(),
  },
  (table) => [
    index('messages_chat_id_idx').on(table.chat_id),
    index('messages_timestamp_idx').on(table.timestamp),
  ],
);

// classifications — uma por conversa (UNIQUE em conversation_id)
export const classifications = sqliteTable(
  'classifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    conversation_id: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    status: text('status').notNull(),
    intent: text('intent'),
    sentiment: text('sentiment'),
    priority: integer('priority').default(3),
    summary: text('summary'),
    next_action: text('next_action'),
    classified_by: text('classified_by').notNull(),
    model_version: text('model_version'),
    classified_at: integer('classified_at').notNull(),
  },
  (table) => [
    uniqueIndex('classifications_conversation_id_unique').on(table.conversation_id),
    index('classifications_status_idx').on(table.status),
  ],
);

// classification_history — audit trail imutável de todas as classificações
export const classificationHistory = sqliteTable(
  'classification_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    conversation_id: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    status: text('status').notNull(),
    intent: text('intent'),
    sentiment: text('sentiment'),
    priority: integer('priority').default(3),
    summary: text('summary'),
    next_action: text('next_action'),
    classified_by: text('classified_by').notNull(),
    model_version: text('model_version'),
    classified_at: integer('classified_at').notNull(),
  },
  (table) => [index('classification_history_conversation_id_idx').on(table.conversation_id)],
);

// sync_runs — log de execuções do scheduler
export const syncRuns = sqliteTable('sync_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  run_type: text('run_type').notNull(),
  started_at: integer('started_at').notNull(),
  finished_at: integer('finished_at'),
  conversations_processed: integer('conversations_processed').default(0),
  messages_ingested: integer('messages_ingested').default(0),
  classifications_updated: integer('classifications_updated').default(0),
  error: text('error'),
  status: text('status').default('running'),
});
