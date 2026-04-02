// ---------------------------------------------------------------------------
// Normalized DTOs — shared across ingestao/ and banco/.
// Field names and types mirror the drizzle schema exactly.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ClassificationResult — shared between classificacao/ and banco/ modules.
// Defined here to avoid a circular dependency (banco → classificacao).
// ---------------------------------------------------------------------------

export interface ClassificationResult {
  status: 'lead_frio' | 'lead_quente' | 'cliente_ativo' | 'suporte' | 'encerrado' | 'indefinido';
  intent: 'compra' | 'suporte' | 'duvida' | 'reclamacao' | 'nenhum' | null;
  sentiment: 'positivo' | 'neutro' | 'negativo';
  priority: 1 | 2 | 3;
  summary: string;       // max 100 chars
  next_action: string;   // max 80 chars
  classified_by: 'rules' | 'llm' | 'manual';
  model_version?: string;
  confidence: number;    // 0–1
}

export interface NormalizedMessage {
  id: string;
  chat_id: string;
  from_me: 0 | 1;
  timestamp: number; // Unix ms
  text: string | null;
  message_type: string;
  raw_payload: string; // JSON bruto
  created_at: number; // Unix ms
}

export interface NormalizedChat {
  id: string; // full JID
  contact_id: string | null; // null for groups
  name: string | null;
  is_group: 0 | 1;
  last_message_at: number | null; // Unix ms
  unread_count: number;
  created_at: number;
  updated_at: number;
}

export interface NormalizedContact {
  id: string; // clean phone number, no JID suffix
  name: string | null;
  display_name: string | null;
  is_business: 0 | 1;
  created_at: number;
  updated_at: number;
}
