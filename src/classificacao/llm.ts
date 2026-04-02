// ---------------------------------------------------------------------------
// classificacao/llm.ts
//
// Classifies a WhatsApp conversation by calling the Anthropic Messages API
// directly via fetch (no SDK dependency).
// ---------------------------------------------------------------------------

import type { ClassificationResult } from '../shared/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ClassificationResult }

export interface MessageForLLM {
  text: string | null
  fromMe: boolean
  timestamp: number // Unix ms
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL = 'claude-haiku-4-5-20251001'
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_API_VERSION = '2023-06-01'

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Você é um analisador de conversas de CRM via WhatsApp.
Sua tarefa é classificar conversas de clientes/leads com base no histórico de mensagens fornecido.

Retorne APENAS JSON válido, sem markdown, sem explicações, sem blocos de código.

O JSON deve conter exatamente estes campos:

- status: um de: "lead_frio", "lead_quente", "cliente_ativo", "suporte", "encerrado", "indefinido"
  - lead_frio: contato inicial sem interesse claro ou sem resposta
  - lead_quente: interesse demonstrado, aguardando conversão
  - cliente_ativo: já comprou ou está em processo ativo de compra
  - suporte: conversa de suporte ou pós-venda
  - encerrado: conversa concluída ou sem continuidade
  - indefinido: não é possível classificar com as informações disponíveis

- intent: um de: "compra", "suporte", "duvida", "reclamacao", "nenhum" ou null
  - compra: intenção de adquirir produto/serviço
  - suporte: pedido de ajuda técnica ou operacional
  - duvida: perguntas gerais sem intenção clara
  - reclamacao: insatisfação ou reclamação explícita
  - nenhum: sem intenção identificável
  - null: não foi possível determinar

- sentiment: um de: "positivo", "neutro", "negativo"

- priority: um de: 1, 2, 3
  - 1 = alta (lead quente, reclamação urgente, suporte crítico)
  - 2 = média (interesse moderado, dúvidas relevantes)
  - 3 = baixa (lead frio, encerrado, sem ação necessária)

- summary: resumo da conversa em no máximo 100 caracteres

- next_action: próxima ação recomendada em no máximo 80 caracteres

- confidence: número entre 0.0 e 1.0 indicando certeza na classificação

Exemplo de resposta válida:
{"status":"lead_quente","intent":"compra","sentiment":"positivo","priority":1,"summary":"Cliente interessado em plano empresarial, pediu proposta.","next_action":"Enviar proposta personalizada em até 24h","confidence":0.92}`.trim()

function buildUserPrompt(chatId: string, messages: MessageForLLM[]): string {
  const lines: string[] = [
    `Conversa ID: ${chatId}`,
    `Total de mensagens: ${messages.length}`,
    '',
    'Histórico:',
  ]

  for (const msg of messages) {
    const direction = msg.fromMe ? '[EU]' : '[CLIENTE]'
    const date = new Date(msg.timestamp).toISOString().replace('T', ' ').slice(0, 16)
    const text = msg.text ?? '(mídia sem texto)'
    lines.push(`${date} ${direction} ${text}`)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_STATUS = new Set([
  'lead_frio', 'lead_quente', 'cliente_ativo', 'suporte', 'encerrado', 'indefinido',
])

const VALID_INTENT = new Set([
  'compra', 'suporte', 'duvida', 'reclamacao', 'nenhum',
])

const VALID_SENTIMENT = new Set(['positivo', 'neutro', 'negativo'])

const VALID_PRIORITY = new Set([1, 2, 3])

function validateStatus(v: unknown): ClassificationResult['status'] {
  return typeof v === 'string' && VALID_STATUS.has(v)
    ? (v as ClassificationResult['status'])
    : 'indefinido'
}

function validateIntent(v: unknown): ClassificationResult['intent'] {
  if (v === null) return null
  return typeof v === 'string' && VALID_INTENT.has(v)
    ? (v as ClassificationResult['intent'])
    : 'nenhum'
}

function validateSentiment(v: unknown): ClassificationResult['sentiment'] {
  return typeof v === 'string' && VALID_SENTIMENT.has(v)
    ? (v as ClassificationResult['sentiment'])
    : 'neutro'
}

function validatePriority(v: unknown): ClassificationResult['priority'] {
  return typeof v === 'number' && VALID_PRIORITY.has(v)
    ? (v as ClassificationResult['priority'])
    : 2
}

function validateConfidence(v: unknown): number {
  if (typeof v === 'number' && v >= 0 && v <= 1) return v
  return 0.5
}

function truncate(value: unknown, maxLen: number): string {
  const str = typeof value === 'string' ? value : ''
  return str.slice(0, maxLen)
}

// ---------------------------------------------------------------------------
// Anthropic API response shape (only the fields we need)
// ---------------------------------------------------------------------------

interface AnthropicContent {
  type: string
  text?: string
}

interface AnthropicResponse {
  content: AnthropicContent[]
  error?: { type: string; message: string }
}

// ---------------------------------------------------------------------------
// classifyByLLM
// ---------------------------------------------------------------------------

export async function classifyByLLM(
  chatId: string,
  messages: MessageForLLM[],
): Promise<ClassificationResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY não está definida. ' +
      'Configure a variável de ambiente antes de usar a classificação por LLM.',
    )
  }

  const requestBody = {
    model: MODEL,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: buildUserPrompt(chatId, messages),
      },
    ],
    response_format: { type: 'json_object' },
  }

  let response: Response
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (cause) {
    throw new Error(
      `Falha na chamada HTTP para a API Anthropic: ${String(cause)}`,
      { cause },
    )
  }

  let body: AnthropicResponse
  try {
    body = (await response.json()) as AnthropicResponse
  } catch (cause) {
    throw new Error(
      `Resposta da API Anthropic não é JSON válido (status HTTP ${response.status})`,
      { cause },
    )
  }

  if (!response.ok) {
    const errMsg = body.error?.message ?? `status HTTP ${response.status}`
    throw new Error(`Erro da API Anthropic: ${errMsg}`)
  }

  // Extract text content from the first content block
  const textBlock = body.content.find((b) => b.type === 'text')
  if (!textBlock || typeof textBlock.text !== 'string') {
    throw new Error(
      'A API Anthropic retornou resposta sem bloco de texto. ' +
      `Blocos recebidos: ${JSON.stringify(body.content)}`,
    )
  }

  let parsed: Record<string, unknown>
  try {
    // Strip markdown code fences defensively — the model may wrap JSON in
    // ```json ... ``` even when instructed not to, especially without
    // response_format enforcement on older API versions.
    const cleaned = textBlock.text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim()
    parsed = JSON.parse(cleaned) as Record<string, unknown>
  } catch (cause) {
    throw new Error(
      `O modelo retornou conteúdo que não é JSON válido: ${textBlock.text.slice(0, 200)}`,
      { cause },
    )
  }

  return {
    status: validateStatus(parsed['status']),
    intent: validateIntent(parsed['intent']),
    sentiment: validateSentiment(parsed['sentiment']),
    priority: validatePriority(parsed['priority']),
    summary: truncate(parsed['summary'], 100),
    next_action: truncate(parsed['next_action'], 80),
    classified_by: 'llm',
    model_version: MODEL,
    confidence: validateConfidence(parsed['confidence']),
  }
}
