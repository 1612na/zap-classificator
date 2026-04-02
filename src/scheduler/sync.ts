// ---------------------------------------------------------------------------
// scheduler/sync.ts — sincronização incremental de conversas não classificadas
// ou com classificação desatualizada.
//
// Critérios de reclassificação:
//  1. Conversas sem nenhuma linha em `classifications`.
//  2. Conversas classificadas com classified_by='llm' e status='indefinido'
//     (falha de LLM anterior — retry).
//  3. Conversas cujo last_message_at é posterior ao classified_at
//     (mensagens novas desde a última classificação).
// ---------------------------------------------------------------------------

import { isNull, eq, sql, and } from 'drizzle-orm';
import type { Database } from '../banco/db.js';
import { conversations, classifications, syncRuns } from '../banco/schema.js';
import { classifyConversation } from '../classificacao/engine.js';

export async function runIncrementalSync(db: Database): Promise<void> {
  const startedAt = Date.now();

  // Insert sync_run record and capture the auto-incremented id.
  const insertResult = db
    .insert(syncRuns)
    .values({
      run_type: 'incremental',
      started_at: startedAt,
      status: 'running',
    })
    .returning({ id: syncRuns.id })
    .get();

  const runId = insertResult?.id;

  let processed = 0;
  let failed = 0;
  const errors: string[] = [];

  try {
    // --- Criterion 1: never classified ---
    const unclassified = db
      .select({ id: conversations.id })
      .from(conversations)
      .leftJoin(classifications, sql`${conversations.id} = ${classifications.conversation_id}`)
      .where(isNull(classifications.id))
      .all();

    // --- Criterion 2: LLM retry candidates ---
    const llmRetry = db
      .select({ id: conversations.id })
      .from(conversations)
      .innerJoin(classifications, sql`${conversations.id} = ${classifications.conversation_id}`)
      .where(
        and(
          eq(classifications.classified_by, 'llm'),
          eq(classifications.status, 'indefinido'),
        ),
      )
      .all();

    // --- Criterion 3: stale — new messages since last classification ---
    const stale = db
      .select({ id: conversations.id })
      .from(conversations)
      .innerJoin(classifications, sql`${conversations.id} = ${classifications.conversation_id}`)
      .where(sql`${conversations.last_message_at} > ${classifications.classified_at}`)
      .all();

    // Deduplicate by chatId (a conversation may appear in multiple criteria).
    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const row of [...unclassified, ...llmRetry, ...stale]) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        candidates.push(row.id);
      }
    }

    console.log(
      `[sync] Run #${runId}: ${unclassified.length} unclassified, ` +
      `${llmRetry.length} llm-retry, ${stale.length} stale → ` +
      `${candidates.length} unique candidates`,
    );

    // Classify each candidate; continue on partial failures.
    for (const chatId of candidates) {
      try {
        await classifyConversation(db, chatId);
        processed++;
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${chatId}: ${msg}`);
        console.error(`[sync] Failed to classify chatId=${chatId}:`, err);
      }
    }

    const finishedAt = Date.now();
    const finalStatus = failed > 0 ? 'error' : 'success';
    const errorSummary =
      failed > 0 ? `${failed} conversation(s) failed: ${errors.join('; ')}` : null;

    if (runId !== undefined) {
      db.update(syncRuns)
        .set({
          finished_at: finishedAt,
          status: finalStatus,
          conversations_processed: processed,
          error: errorSummary,
        })
        .where(sql`${syncRuns.id} = ${runId}`)
        .run();
    }

    console.log(
      `[sync] Run #${runId} ${finalStatus}: processed=${processed} failed=${failed}`,
    );
  } catch (err) {
    // Catastrophic failure (e.g. DB query error before the loop started).
    console.error('[sync] Fatal error in runIncrementalSync:', err);

    if (runId !== undefined) {
      db.update(syncRuns)
        .set({
          finished_at: Date.now(),
          status: 'error',
          conversations_processed: processed,
          error: err instanceof Error ? err.message : String(err),
        })
        .where(sql`${syncRuns.id} = ${runId}`)
        .run();
    }

    throw err;
  }
}
