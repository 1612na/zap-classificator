// ---------------------------------------------------------------------------
// scheduler/index.ts — cron jobs para sync incremental e classificação batch.
//
// Job 1 (*/30 * * * *): runIncrementalSync — enfileira conversas pendentes.
// Job 2 (0 * * * *):   batch classification — reclassifica conversas ativas
//                        nas últimas 2 horas.
//
// Ambos os jobs são protegidos por runWithLock para evitar execuções
// concorrentes do mesmo job.
// ---------------------------------------------------------------------------

import cron from 'node-cron';
import type { Database } from '../banco/db.js';
import { conversations, syncRuns } from '../banco/schema.js';
import { classifyConversation } from '../classificacao/engine.js';
import { runWithLock } from './lock.js';
import { runIncrementalSync } from './sync.js';
import { sql } from 'drizzle-orm';

// Two hours in milliseconds — window for the batch classification job.
const BATCH_WINDOW_MS = 2 * 60 * 60 * 1000;

type ScheduledTask = ReturnType<typeof cron.schedule>;

let jobs: ScheduledTask[] = [];

export function startScheduler(db: Database): void {
  // ------------------------------------------------------------------
  // Job 1 — Incremental sync (every 30 minutes)
  // Finds conversations that are unclassified, stale, or failed LLM,
  // then calls classifyConversation for each.
  // ------------------------------------------------------------------
  const syncJob = cron.schedule('*/30 * * * *', () => {
    void runWithLock('incremental-sync', () => runIncrementalSync(db));
  });

  // ------------------------------------------------------------------
  // Job 2 — Batch classification (every hour)
  // Classifies all conversations with messages in the last 2 hours.
  // ------------------------------------------------------------------
  const batchJob = cron.schedule('0 * * * *', () => {
    void runWithLock('batch-classification', async () => {
      const startedAt = Date.now();
      const windowStart = startedAt - BATCH_WINDOW_MS;

      const insertResult = db
        .insert(syncRuns)
        .values({
          run_type: 'batch',
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
        const recent = db
          .select({ id: conversations.id })
          .from(conversations)
          .where(sql`${conversations.last_message_at} >= ${windowStart}`)
          .all();

        console.log(
          `[batch] Run #${runId}: ${recent.length} conversations with messages in last 2h`,
        );

        for (const row of recent) {
          try {
            await classifyConversation(db, row.id);
            processed++;
          } catch (err) {
            failed++;
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`${row.id}: ${msg}`);
            console.error(`[batch] Failed to classify chatId=${row.id}:`, err);
          }
        }

        const finalStatus = failed > 0 ? 'error' : 'success';
        const errorSummary =
          failed > 0 ? `${failed} conversation(s) failed: ${errors.join('; ')}` : null;

        if (runId !== undefined) {
          db.update(syncRuns)
            .set({
              finished_at: Date.now(),
              status: finalStatus,
              conversations_processed: processed,
              error: errorSummary,
            })
            .where(sql`${syncRuns.id} = ${runId}`)
            .run();
        }

        console.log(
          `[batch] Run #${runId} ${finalStatus}: processed=${processed} failed=${failed}`,
        );
      } catch (err) {
        console.error('[batch] Fatal error in batch-classification job:', err);

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
      }
    });
  });

  jobs = [syncJob, batchJob];

  console.log('[scheduler] Started: incremental-sync (*/30 * * * *), batch-classification (0 * * * *)');
}

/**
 * Stops all cron jobs — call during graceful shutdown.
 */
export function stopScheduler(): void {
  for (const job of jobs) {
    job.stop();
  }
  jobs = [];
  console.log('[scheduler] All jobs stopped');
}
