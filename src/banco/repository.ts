import { sql, eq } from 'drizzle-orm';
import { contacts, conversations, messages, classifications, classificationHistory } from './schema.js';
import type { Database } from './db.js';
import type {
  NormalizedContact,
  NormalizedChat,
  NormalizedMessage,
  ClassificationResult,
} from '../shared/types.js';

// ---------------------------------------------------------------------------
// upsertContact
// Updates name, display_name, is_business, updated_at on conflict.
// ---------------------------------------------------------------------------

export function upsertContact(db: Database, contact: NormalizedContact): void {
  db.insert(contacts)
    .values(contact)
    .onConflictDoUpdate({
      target: contacts.id,
      set: {
        name: contact.name,
        display_name: contact.display_name,
        is_business: contact.is_business,
        updated_at: contact.updated_at,
      },
    })
    .run();
}

// ---------------------------------------------------------------------------
// upsertConversation
// Updates last_message_at, unread_count, name, updated_at on conflict.
// created_at and is_group are never overwritten after the first insert.
// ---------------------------------------------------------------------------

export function upsertConversation(db: Database, chat: NormalizedChat): void {
  db.insert(conversations)
    .values(chat)
    .onConflictDoUpdate({
      target: conversations.id,
      set: {
        // Preserve a non-null contact_id already stored — a later event with
        // contact_id: null must not overwrite a previously resolved value.
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
// ensureContactStub
// Inserts a minimal contact row (id only, no name) when only the phone number
// is known — used as FK-guard before upsertConversation when contact:updated
// has not yet arrived.  Does nothing if the contact already exists.
// ---------------------------------------------------------------------------

export function ensureContactStub(db: Database, contactId: string): void {
  const now = Date.now();
  db.insert(contacts)
    .values({
      id: contactId,
      name: null,
      display_name: null,
      is_business: 0,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing()
    .run();
}

// ---------------------------------------------------------------------------
// upsertMessage
// INSERT OR IGNORE — a message is immutable once stored.
// ---------------------------------------------------------------------------

export function upsertMessage(db: Database, message: NormalizedMessage): void {
  db.insert(messages).values(message).onConflictDoNothing().run();
}

// ---------------------------------------------------------------------------
// saveClassification
// Persists a ClassificationResult for a conversation.
//
// Rules:
//  1. If an existing record has classified_by = 'manual', do NOT overwrite it.
//  2. Otherwise, UPSERT into classifications (insert or update on conflict).
//  3. Always insert into classification_history (immutable audit trail).
// ---------------------------------------------------------------------------

export function saveClassification(
  db: Database,
  conversationId: string,
  result: ClassificationResult,
): void {
  const classifiedAt = Date.now();

  // Guard: never overwrite a manual classification.
  const existing = db
    .select({ classified_by: classifications.classified_by })
    .from(classifications)
    .where(eq(classifications.conversation_id, conversationId))
    .get();

  if (existing?.classified_by === 'manual' && result.classified_by !== 'manual') {
    // Audit trail: record the attempted reclassification even though it was
    // blocked, so reviewers can see what the engine would have done.
    db.insert(classificationHistory)
      .values({
        conversation_id: conversationId,
        status: result.status,
        intent: result.intent,
        sentiment: result.sentiment,
        priority: result.priority,
        summary: 'Reclassificação bloqueada — classificação manual preservada',
        next_action: result.next_action,
        classified_by: result.classified_by,
        model_version: result.model_version ?? null,
        classified_at: classifiedAt,
      })
      .run();
    return;
  }

  // UPSERT into classifications — update all mutable fields on conflict.
  db.insert(classifications)
    .values({
      conversation_id: conversationId,
      status: result.status,
      intent: result.intent,
      sentiment: result.sentiment,
      priority: result.priority,
      summary: result.summary,
      next_action: result.next_action,
      classified_by: result.classified_by,
      model_version: result.model_version ?? null,
      classified_at: classifiedAt,
    })
    .onConflictDoUpdate({
      target: classifications.conversation_id,
      set: {
        status: result.status,
        intent: result.intent,
        sentiment: result.sentiment,
        priority: result.priority,
        summary: result.summary,
        next_action: result.next_action,
        classified_by: result.classified_by,
        model_version: result.model_version ?? null,
        classified_at: classifiedAt,
      },
    })
    .run();

  // Always insert into classification_history (immutable — no conflict logic).
  db.insert(classificationHistory)
    .values({
      conversation_id: conversationId,
      status: result.status,
      intent: result.intent,
      sentiment: result.sentiment,
      priority: result.priority,
      summary: result.summary,
      next_action: result.next_action,
      classified_by: result.classified_by,
      model_version: result.model_version ?? null,
      classified_at: classifiedAt,
    })
    .run();
}
