import type { WASocket, proto } from '@whiskeysockets/baileys'
import { bus } from '../shared/events.js'
import type {
  MessageReceivedEvent,
  ChatUpdatedEvent,
  ContactUpdatedEvent,
} from '../shared/events.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(message: proto.IMessage | null | undefined): string | null {
  if (!message) return null
  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    null
  )
}

const MESSAGE_TYPE_PRIORITY: ReadonlyArray<keyof proto.IMessage> = [
  'conversation',
  'extendedTextMessage',
  'imageMessage',
  'videoMessage',
  'documentMessage',
  'audioMessage',
  'stickerMessage',
  'reactionMessage',
  'buttonsMessage',
  'templateMessage',
  'listMessage',
]

function getMessageType(message: proto.IMessage | null | undefined): string {
  if (!message) return 'unknown'
  const prioritized = MESSAGE_TYPE_PRIORITY.find(
    (k) => message[k] != null,
  )
  if (prioritized) return prioritized
  // Fallback: any non-null key not in the priority list
  return (
    Object.keys(message).find(
      (k) => message[k as keyof proto.IMessage] != null,
    ) ?? 'unknown'
  )
}

/** Strips JID suffix (@s.whatsapp.net, @g.us) and device suffix (:0) */
function cleanJid(jid: string): string {
  return jid.replace(/:\d+$/, '').replace(/@.*$/, '')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Registers the three core Baileys event handlers on the given socket and
 * re-emits them as typed domain events via the singleton EventBus.
 *
 * Must be called once per socket instance (i.e. inside createConnection).
 */
export function registerListeners(sock: WASocket): void {
  // ── messages.upsert ──────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const msg of messages) {
      const { id, remoteJid, fromMe } = msg.key
      if (!id || !remoteJid) continue

      // Baileys delivers messageTimestamp as number | Long | null
      const tsRaw = msg.messageTimestamp
      const tsMs =
        tsRaw == null
          ? Date.now()
          : (typeof tsRaw === 'number' ? tsRaw : Number(tsRaw)) * 1000

      const event: MessageReceivedEvent = {
        id,
        chatId: remoteJid,
        fromMe: fromMe ?? false,
        timestamp: tsMs,
        text: extractText(msg.message),
        messageType: getMessageType(msg.message),
        rawPayload: JSON.stringify(msg),
        type,
      }

      bus.emit('message:received', event)
      console.log(
        `[listener] message:received  chat=${event.chatId}  type=${event.messageType}  fromMe=${event.fromMe}`,
      )
    }
  })

  // ── chats.upsert ─────────────────────────────────────────────────────────
  sock.ev.on('chats.upsert', (chats) => {
    for (const chat of chats) {
      const tsRaw = chat.conversationTimestamp
      const lastMessageTime =
        tsRaw == null
          ? null
          : (typeof tsRaw === 'number' ? tsRaw : Number(tsRaw)) * 1000

      const event: ChatUpdatedEvent = {
        id: chat.id,
        name: chat.name ?? null,
        unreadCount: chat.unreadCount ?? 0,
        lastMessageTime,
      }

      bus.emit('chat:updated', event)
      console.log(
        `[listener] chat:updated  id=${event.id}  name=${event.name ?? '(sem nome)'}`,
      )
    }
  })

  // ── chats.update ─────────────────────────────────────────────────────────
  // Fires for existing chats when new messages arrive or metadata changes.
  // Fields are all Partial<Chat>, so each one may be absent.
  sock.ev.on('chats.update', (chats) => {
    for (const chat of chats) {
      if (!chat.id) continue

      const tsRaw = chat.conversationTimestamp
      const lastMessageTime =
        tsRaw == null
          ? null
          : (typeof tsRaw === 'number' ? tsRaw : Number(tsRaw)) * 1000

      const event: ChatUpdatedEvent = {
        id: chat.id,
        name: chat.name ?? null,
        unreadCount: chat.unreadCount ?? 0,
        lastMessageTime,
      }

      bus.emit('chat:updated', event)
      console.log(
        `[listener] chat:updated (update)  id=${event.id}  name=${event.name ?? '(sem nome)'}`,
      )
    }
  })

  // ── contacts.upsert ──────────────────────────────────────────────────────
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) {
      const c = contact as unknown as Record<string, unknown>
      const event: ContactUpdatedEvent = {
        id: cleanJid(contact.id),
        name: contact.name ?? null,
        displayName:
          contact.notify ?? (c['verifiedName'] as string | undefined) ?? null,
        isBusiness: Boolean(c['isBusiness']),
      }

      bus.emit('contact:updated', event)
      console.log(
        `[listener] contact:updated  id=${event.id}  name=${event.name ?? '(sem nome)'}`,
      )
    }
  })
}
