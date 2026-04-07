// src/pusher/client.ts
// Cliente HTTP para POST em lote para a Render API.
// Sem dependências externas — usa fetch nativo do Node 18+.

const RENDER_API_URL = process.env['RENDER_API_URL'] ?? '';
const RENDER_API_KEY = process.env['RENDER_API_KEY'] ?? '';

if (!RENDER_API_URL || !RENDER_API_KEY) {
  console.warn('[pusher/client] RENDER_API_URL ou RENDER_API_KEY não definidos — pusher desabilitado');
}

export type IngestEntityType = 'contact' | 'conversation' | 'message';

// Mapeamento de tipo de entidade para endpoint do Render
const ENDPOINT: Record<IngestEntityType, string> = {
  contact: '/ingest/contacts',
  conversation: '/ingest/conversations',
  message: '/ingest/messages',
};

export interface PushResult {
  ok: boolean;
  error?: string;
}

/**
 * Envia um lote de payloads para o endpoint correspondente no Render.
 * Retorna { ok: true } se o servidor retornar 2xx, { ok: false, error } caso contrário.
 */
export async function pushBatch(
  entityType: IngestEntityType,
  payloads: unknown[],
): Promise<PushResult> {
  if (!RENDER_API_URL || !RENDER_API_KEY) {
    return { ok: false, error: 'RENDER_API_URL/KEY não configurados' };
  }
  if (payloads.length === 0) return { ok: true };

  const url = `${RENDER_API_URL}${ENDPOINT[entityType]}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': RENDER_API_KEY,
      },
      body: JSON.stringify({ data: payloads }),
      signal: AbortSignal.timeout(30_000), // 30s timeout
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, error: `HTTP ${response.status}: ${body.slice(0, 200)}` };
    }

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
