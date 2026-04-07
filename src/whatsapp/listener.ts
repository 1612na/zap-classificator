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
  const prioritized = MESSAGE_TYPE_PRIORITY.find((k) => message[k] != null)
  if (prioritized) return prioritized
  return Object.keys(message).find((k) => message[k as keyof proto.IMessage] != null) ?? 'unknown'
}

function hasMedia(msgType: string): boolean {
  return ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage'].includes(msgType)
}

function getMediaUrl(message: proto.IMessage | null | undefined, msgType: string): string | null {
  if (!message) return null
  switch (msgType) {
    case 'imageMessage': return message.imageMessage?.url ?? null
    case 'videoMessage': return message.videoMessage?.url ?? null
    case 'documentMessage': return message.documentMessage?.url ?? null
    case 'audioMessage': return message.audioMessage?.url ?? null
    default: return null
  }
}

function getMediaMime(message: proto.IMessage | null | undefined, msgType: string): string | null {
  if (!message) return null
  switch (msgType) {
    case 'imageMessage': return message.imageMessage?.mimetype ?? null
    case 'videoMessage': return message.videoMessage?.mimetype ?? null
    case 'documentMessage': return message.documentMessage?.mimetype ?? null
    case 'audioMessage': return message.audioMessage?.mimetype ?? null
    default: return null
  }
}

function getContextInfo(message: proto.IMessage | null | undefined): proto.IContextInfo | null | undefined {
  if (!message) return null
  return (
    message.extendedTextMessage?.contextInfo ??
    message.imageMessage?.contextInfo ??
    message.videoMessage?.contextInfo ??
    message.documentMessage?.contextInfo ??
    null
  )
}

/** Strips JID suffix and device suffix from a JID string */
function cleanJid(jid: string): string {
  return jid.replace(/:\d+$/, '').replace(/@.*$/, '')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function registerListeners(sock: WASocket): void {
  // ── messages.upsert ──────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const msg of messages) {
      const { id, remoteJid, fromMe, participant } = msg.key
      if (!id || !remoteJid) continue
      if (remoteJid.endsWith('@g.us')) continue   // ignora grupos

      const tsRaw = msg.messageTimestamp
      const tsMs =
        tsRaw == null
          ? Date.now()
          : (typeof tsRaw === 'number' ? tsRaw : Number(tsRaw)) * 1000

      const msgType = getMessageType(msg.message)
      const contextInfo = getContextInfo(msg.message)

      // Em grupos, participant é o remetente; em individual, é null quando from_me
      const senderJid = fromMe
        ? null
        : (participant ?? remoteJid)

      const event: MessageReceivedEvent = {
        id,
        chatId: remoteJid,
        senderJid,
        fromMe: fromMe ?? false,
        timestamp: tsMs,
        text: extractText(msg.message),
        messageType: msgType,
        hasMedia: hasMedia(msgType),
        mediaUrl: getMediaUrl(msg.message, msgType),
        mediaMime: getMediaMime(msg.message, msgType),
        isForwarded: Boolean(contextInfo?.isForwarded),
        quotedMessageId: contextInfo?.stanzaId ?? null,
        rawPayload: JSON.stringify(msg),
        type,
      }

      bus.emit('message:received', event)
      console.log(`[listener] message:received  chat=${event.chatId}  type=${event.messageType}  fromMe=${event.fromMe}`)
    }
  })

  // ── chats.upsert ─────────────────────────────────────────────────────────
  sock.ev.on('chats.upsert', (chats) => {
    for (const chat of chats) {
      if (chat.id.endsWith('@g.us')) continue   // ignora grupos
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
      console.log(`[listener] chat:updated  id=${event.id}  name=${event.name ?? '(sem nome)'}`)
    }
  })

  // ── chats.update ─────────────────────────────────────────────────────────
  sock.ev.on('chats.update', (chats) => {
    for (const chat of chats) {
      if (!chat.id) continue
      if (chat.id.endsWith('@g.us')) continue   // ignora grupos

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
      console.log(`[listener] chat:updated (update)  id=${event.id}`)
    }
  })

  // ── contacts.upsert ──────────────────────────────────────────────────────
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) {
      const c = contact as unknown as Record<string, unknown>
      const event: ContactUpdatedEvent = {
        id: cleanJid(contact.id),
        name: contact.name ?? null,
        pushName: contact.notify ?? null,
        displayName:
          (c['verifiedName'] as string | undefined) ?? null,
        isBusiness: Boolean(c['isBusiness']),
        avatarUrl: null,    // não buscar proativamente — risco de ban
        about: (c['status'] as string | undefined) ?? null,
      }

      bus.emit('contact:updated', event)
      console.log(`[listener] contact:updated  id=${event.id}  name=${event.name ?? '(sem nome)'}`)
    }
  })
}
