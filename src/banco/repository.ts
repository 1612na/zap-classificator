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
