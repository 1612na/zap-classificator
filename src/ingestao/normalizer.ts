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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the numeric part before "@" from a JID.
 * Returns null for group JIDs (ending in @g.us) because they have no single
 * contact owner.
 *
 * Examples:
 *   "5511999999999@s.whatsapp.net" → "5511999999999"
 *   "5511999999999@g.us"          → null
 */
function extractContactId(jid: string): string | null {
  if (jid.endsWith('@g.us')) return null;
  const atIndex = jid.indexOf('@');
  return atIndex === -1 ? jid : jid.slice(0, atIndex);
}

// ---------------------------------------------------------------------------
// Pure normalizer functions
// ---------------------------------------------------------------------------

export function normalizeMessage(event: MessageReceivedEvent): NormalizedMessage {
  return {
    id: event.id,
    chat_id: event.chatId,
    from_me: event.fromMe ? 1 : 0,
    timestamp: event.timestamp,
    text: event.text,
    message_type: event.messageType,
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
    display_name: event.displayName,
    is_business: event.isBusiness ? 1 : 0,
    created_at: now,
    updated_at: now,
  };
}
