// ---------------------------------------------------------------------------
// classificacao/engine.ts — pipeline híbrido regras → LLM.
//
// Orquestra a classificação de uma conversa:
//   1. Busca as últimas 20 mensagens do banco.
//   2. Protege classificações manuais (classified_by = 'manual').
//   3. Tenta classificar por regras (confidence >= 0.75).
//   4. Se regras não forem suficientes, verifica critérios mínimos e chama LLM.
//   5. Salva o resultado via saveClassification (inclui classification_history).
// ---------------------------------------------------------------------------

import { eq, desc } from 'drizzle-orm';
import type { Database } from '../banco/db.js';
import { messages, classifications } from '../banco/schema.js';
import { saveClassification } from '../banco/repository.js';
import { classifyByRules } from './rules.js';
import type { MessageForClassification } from './rules.js';
import { classifyByLLM } from './llm.js';
import type { ClassificationResult } from '../shared/types.js';

// Minimum thresholds for LLM invocation
const LLM_MIN_MESSAGES = 3;
const LLM_MIN_CHARS = 50;
const MAX_MESSAGES_TO_FETCH = 20;

export async function classifyConversation(
  db: Database,
  chatId: string,
): Promise<void> {
  // Step 1 — Check if the conversation has a manual classification; if so, skip.
  const existingClassification = db
    .select({ classified_by: classifications.classified_by })
    .from(classifications)
    .where(eq(classifications.conversation_id, chatId))
    .get();

  if (existingClassification?.classified_by === 'manual') {
    console.log(`[engine] chatId=${chatId} has manual classification — skipping`);
    return;
  }

  // Step 2 — Fetch the last N messages for this conversation.
  // Query DESC to get the most recent ones, then reverse to restore
  // chronological order before passing to classifyByRules/classifyByLLM.
  const rows = db
    .select({
      text: messages.text,
      from_me: messages.from_me,
      timestamp: messages.timestamp,
    })
    .from(messages)
    .where(eq(messages.chat_id, chatId))
    .orderBy(desc(messages.timestamp))
    .limit(MAX_MESSAGES_TO_FETCH)
    .all()
    .reverse();

  if (rows.length === 0) {
    console.log(`[engine] chatId=${chatId} has no messages — skipping`);
    return;
  }

  const msgs: MessageForClassification[] = rows.map((r) => ({
    text: r.text,
    fromMe: r.from_me === 1,
    timestamp: r.timestamp,
  }));

  // Step 3 — Try local rules first.
  const rulesResult = classifyByRules(msgs);

  if (rulesResult !== null) {
    // Rules produced a confident enough result — persist and return.
    saveClassification(db, chatId, rulesResult);
    console.log(
      `[engine] chatId=${chatId} classified by rules: status=${rulesResult.status} confidence=${rulesResult.confidence}`,
    );
    return;
  }

  // Step 4 — Rules returned null (confidence < 0.75). Check LLM eligibility.
  const totalChars = msgs.reduce((sum, m) => sum + (m.text?.length ?? 0), 0);
  const meetsLLMCriteria = msgs.length >= LLM_MIN_MESSAGES && totalChars >= LLM_MIN_CHARS;

  if (!meetsLLMCriteria) {
    // Not enough content to send to LLM — save as indefinido.
    // classified_by: 'rules' is correct here: the rules pipeline evaluated the
    // conversation and determined there is insufficient content. This is a
    // deterministic decision by the rules layer, not an LLM failure — so the
    // scheduler batch will not treat it as a retry candidate for LLM.
    const fallback: ClassificationResult = {
      status: 'indefinido',
      intent: null,
      sentiment: 'neutro',
      priority: 3,
      summary: 'Conteúdo insuficiente para classificação automática',
      next_action: 'Aguardar mais mensagens',
      classified_by: 'rules',
      confidence: 0,
    };
    saveClassification(db, chatId, fallback);
    console.log(
      `[engine] chatId=${chatId} below LLM threshold (msgs=${msgs.length}, chars=${totalChars}) — saved as indefinido`,
    );
    return;
  }

  // Step 5 — Call LLM.
  try {
    const llmResult = await classifyByLLM(chatId, msgs);
    saveClassification(db, chatId, llmResult);
    console.log(
      `[engine] chatId=${chatId} classified by LLM: status=${llmResult.status} confidence=${llmResult.confidence}`,
    );
  } catch (err) {
    // LLM failure must not crash the process. Log the error and save indefinido
    // so the scheduler can retry on the next cycle.
    // classified_by: 'llm' ensures the scheduler batch treats this as a retry
    // candidate — using 'rules' here would incorrectly suppress retries.
    console.error(`[engine] LLM classification failed for chatId=${chatId}:`, err);
    const errorFallback: ClassificationResult = {
      status: 'indefinido',
      intent: null,
      sentiment: 'neutro',
      priority: 3,
      summary: 'Falha na classificação por LLM',
      next_action: 'Retry automático pelo scheduler',
      classified_by: 'llm',
      confidence: 0,
    };
    saveClassification(db, chatId, errorFallback);
  }
}
