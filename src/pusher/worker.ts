// src/pusher/worker.ts
// Cron job que drena a push_queue a cada 30s.
// Lê itens pendentes, agrupa por tipo, envia em lote para o Render,
// e atualiza status na fila conforme resultado.

import cron from 'node-cron';
import { dequeueBatch, markSent, markRetry, pendingCount } from './queue.js';
import { pushBatch } from './client.js';
import type { Database } from '../banco/db.js';
import type { EntityType } from './queue.js';

const BATCH_SIZE = 50;
let running = false;

async function drainQueue(db: Database): Promise<void> {
  if (running) {
    console.log('[pusher] Worker já em execução — pulando ciclo');
    return;
  }
  running = true;

  try {
    const items = dequeueBatch(db, BATCH_SIZE);
    if (items.length === 0) return;

    console.log(`[pusher] Processando ${items.length} itens da fila (${pendingCount(db)} pendentes total)`);

    // Agrupar por tipo — a ordem de processamento já foi garantida pelo dequeueBatch
    const byType = new Map<EntityType, Array<{ id: number; payload: unknown; attempts: number }>>();
    for (const item of items) {
      const type = item.entity_type;
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type)!.push({
        id: item.id,
        payload: JSON.parse(item.payload) as unknown,
        attempts: item.attempts,
      });
    }

    // Enviar cada grupo em lote — na ordem: contacts → conversations → messages
    for (const [type, entries] of byType) {
      const payloads = entries.map((e) => e.payload);
      const ids = entries.map((e) => e.id);

      const result = await pushBatch(type, payloads);

      if (result.ok) {
        markSent(db, ids);
        console.log(`[pusher] ✓ ${ids.length} ${type}(s) enviados`);
      } else {
        // Falha no lote inteiro — marcar cada item individualmente para retry
        for (const entry of entries) {
          markRetry(db, entry.id, entry.attempts, result.error ?? 'unknown');
        }
        console.error(`[pusher] ✗ Falha ao enviar ${type}(s): ${result.error}`);
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Inicia o worker de push. Executa a cada 30 segundos.
 * Retorna a task cron para permitir parar em testes.
 */
export function startPusherWorker(db: Database): cron.ScheduledTask {
  console.log('[pusher] Worker iniciado — ciclo a cada 30s');

  // Executar imediatamente no início (sem esperar 30s)
  void drainQueue(db).catch((err: unknown) => {
    console.error('[pusher] Erro no ciclo inicial:', err);
  });

  return cron.schedule('*/30 * * * * *', () => {
    void drainQueue(db).catch((err: unknown) => {
      console.error('[pusher] Erro no ciclo cron:', err);
    });
  });
}
