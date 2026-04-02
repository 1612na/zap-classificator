import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// Event payload contracts (fixed schema — do not change without updating all
// producers and consumers)
// ---------------------------------------------------------------------------

export interface MessageReceivedEvent {
  id: string
  chatId: string        // full JID, e.g. "5511999999999@s.whatsapp.net"
  fromMe: boolean
  timestamp: number     // Unix ms
  text: string | null
  messageType: string   // "conversation", "imageMessage", etc.
  rawPayload: string    // JSON.stringify of the raw Baileys object
  type: 'notify' | 'append' // notify = new message, append = history
}

export interface ChatUpdatedEvent {
  id: string            // full JID
  name: string | null
  unreadCount: number
  lastMessageTime: number | null
}

export interface ContactUpdatedEvent {
  id: string            // clean phone number (no JID suffix)
  name: string | null
  displayName: string | null
  isBusiness: boolean
}

// ---------------------------------------------------------------------------
// Typed event map — maps event names to their payload types so that every
// emit() and on() call is fully type-checked without casting to `any`.
// ---------------------------------------------------------------------------

export interface BusEventMap {
  'message:received': [MessageReceivedEvent]
  'chat:updated': [ChatUpdatedEvent]
  'contact:updated': [ContactUpdatedEvent]
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
