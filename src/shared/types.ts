// ---------------------------------------------------------------------------
// DTOs internos — usados entre ingestao/ e banco/
// ---------------------------------------------------------------------------

export interface NormalizedMessage {
  id: string;
  chat_id: string;
  sender_jid: string | null;
  from_me: 0 | 1;
  timestamp: number;         // Unix ms
  text: string | null;
  message_type: string;      // raw Baileys key
  has_media: 0 | 1;
  media_url: string | null;
  media_mime: string | null;
  is_forwarded: 0 | 1;
  quoted_message_id: string | null;
  raw_payload: string;       // JSON bruto do objeto Baileys
  created_at: number;        // Unix ms
}

export interface NormalizedChat {
  id: string;                // full JID
  contact_id: string | null; // null para grupos
  name: string | null;
  is_group: 0 | 1;
  last_message_at: number | null; // Unix ms
  unread_count: number;
  created_at: number;
  updated_at: number;
}

export interface NormalizedContact {
  id: string;                // número limpo, sem JID suffix
  name: string | null;
  push_name: string | null;
  display_name: string | null;
  is_business: 0 | 1;
  avatar_url: string | null;
  about: string | null;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Tipos da resposta da API (contratos com o CRM Manus)
// ---------------------------------------------------------------------------

export type ApiMessageType = 'text' | 'image' | 'document' | 'audio' | 'video' | 'sticker';

export interface ApiContact {
  phone: string;             // E.164, ex: "+5511999998888"
  name: string | null;
  push_name: string | null;
  is_business: boolean;
  avatar_url: string | null;
}

export interface ApiContactFull extends ApiContact {
  about: string | null;
}

export interface ApiMessage {
  id: string;
  from: string;              // JID do remetente ou "me"
  direction: 'inbound' | 'outbound';
  type: ApiMessageType;
  text: string | null;
  timestamp: string;         // ISO 8601 UTC
  has_media: boolean;
}

export interface ApiMessageFull extends ApiMessage {
  media_url: string | null;
  media_mime: string | null;
  quoted_message_id: string | null;
  is_forwarded: boolean;
}

export interface ConversationSummary {
  conversation_id: string;
  type: 'individual' | 'group';
  contact: ApiContact;
  last_message_at: string;   // ISO 8601 UTC
  message_count: number;
  unread_count: number;
  sample_messages: ApiMessage[];
}

export interface ConversationFull {
  conversation_id: string;
  type: 'individual' | 'group';
  contact: ApiContactFull;
  created_at: string;        // ISO 8601 UTC
  last_message_at: string;   // ISO 8601 UTC
  message_count: number;
  messages: ApiMessageFull[];
}

export interface PaginatedSummaryResponse {
  data: ConversationSummary[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    has_next: boolean;
    next_cursor: string | null;
  };
}

export interface IncrementalSyncItem {
  conversation_id: string;
  last_message_at: string;   // ISO 8601 UTC
}

export interface IncrementalSyncResponse {
  data: IncrementalSyncItem[];
  sync_token: string | null;
}
