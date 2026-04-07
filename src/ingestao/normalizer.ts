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
