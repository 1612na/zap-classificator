// ---------------------------------------------------------------------------
// scheduler/lock.ts — job lock para evitar execuções concorrentes.
//
// Cada job do node-cron deve passar por runWithLock(jobName, fn).
// Se uma execução já estiver em andamento para o mesmo jobName, a nova
// invocação é descartada silenciosamente.
// ---------------------------------------------------------------------------

const activeLocks = new Set<string>();

/**
 * Executa `fn` garantindo exclusividade por `jobName`.
 * Se o lock já estiver ativo, retorna sem fazer nada.
 */
export async function runWithLock(jobName: string, fn: () => Promise<void>): Promise<void> {
  if (activeLocks.has(jobName)) {
    console.warn(`[lock] "${jobName}" is already running — skipping concurrent invocation`);
    return;
  }

  activeLocks.add(jobName);
  const startedAt = Date.now();
  console.log(`[lock] "${jobName}" started`);
  try {
    await fn();
  } finally {
    const durationMs = Date.now() - startedAt;
    activeLocks.delete(jobName);
    console.log(`[lock] "${jobName}" finished in ${durationMs}ms`);
  }
}

/**
 * Retorna true se o lock para `jobName` está ativo.
 */
export function isLocked(jobName: string): boolean {
  return activeLocks.has(jobName);
}
