import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// Event payload contracts (fixed schema — do not change without updating all
// producers and consumers)
// ---------------------------------------------------------------------------

export interface MessageReceivedEvent {
  id: string
  chatId: string
  senderJid: string | null   // JID do remetente em grupos; null se from_me
  fromMe: boolean
  timestamp: number          // Unix ms
  text: string | null
  messageType: string
  hasMedia: boolean
  mediaUrl: string | null
  mediaMime: string | null
  isForwarded: boolean
  quotedMessageId: string | null
  rawPayload: string
  type: string               // Baileys upsert type: "notify" | "append"
}

export interface ChatUpdatedEvent {
  id: string            // full JID
  name: string | null
  unreadCount: number
  lastMessageTime: number | null
}

export interface ContactUpdatedEvent {
  id: string
  name: string | null
  pushName: string | null     // contact.notify
  displayName: string | null
  isBusiness: boolean
  avatarUrl: string | null
  about: string | null        // contact.status
}

// ---------------------------------------------------------------------------
// Typed event map — maps event names to their payload types so that every
// emit() and on() call is fully type-checked without casting to `any`.
// ---------------------------------------------------------------------------

export interface WhatsAppQrEvent {
  qr: string  // raw QR string from Baileys — pass to any QR renderer
}

export interface BusEventMap {
  'message:received': [MessageReceivedEvent]
  'chat:updated': [ChatUpdatedEvent]
  'contact:updated': [ContactUpdatedEvent]
  'whatsapp:qr': [WhatsAppQrEvent]
  'whatsapp:connected': []
}

// ---------------------------------------------------------------------------
// TypedEventEmitter — thin subclass that narrows EventEmitter's generic
// overloads to our concrete event map.
// ---------------------------------------------------------------------------

export class TypedEventEmitter extends EventEmitter {
  emit<K extends keyof BusEventMap>(
    event: K,
    ...args: BusEventMap[K]
  ): boolean {
    return super.emit(event as string, ...args)
  }

  on<K extends keyof BusEventMap>(
    event: K,
    listener: (...args: BusEventMap[K]) => void,
  ): this {
    return super.on(event as string, listener as (...a: unknown[]) => void)
  }

  once<K extends keyof BusEventMap>(
    event: K,
    listener: (...args: BusEventMap[K]) => void,
  ): this {
    return super.once(event as string, listener as (...a: unknown[]) => void)
  }

  off<K extends keyof BusEventMap>(
    event: K,
    listener: (...args: BusEventMap[K]) => void,
  ): this {
    return super.off(event as string, listener as (...a: unknown[]) => void)
  }
}

// ---------------------------------------------------------------------------
// Singleton bus — import this from any module to publish or subscribe.
// Never create additional instances; all inter-module communication must
// flow through this single instance.
// ---------------------------------------------------------------------------

export const bus = new TypedEventEmitter()
