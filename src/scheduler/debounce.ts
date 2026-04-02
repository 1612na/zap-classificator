// ---------------------------------------------------------------------------
// scheduler/debounce.ts — per-chatId debounce de 5 minutos.
//
// Garante que uma nova mensagem não dispara classificação imediata.
// Cada chamada a schedule() para o mesmo chatId reinicia o timer.
// ---------------------------------------------------------------------------

const DEFAULT_DELAY_MS = 5 * 60 * 1000; // 5 minutos

export class DebounceScheduler {
  private readonly delay: number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(delayMs: number = DEFAULT_DELAY_MS) {
    this.delay = delayMs;
  }

  /**
   * Agenda a execução de `fn` após o delay configurado.
   * Se já houver um timer pendente para `chatId`, ele é cancelado e reiniciado
   * (debounce clássico).
   */
  schedule(chatId: string, fn: () => Promise<void>): void {
    this.cancel(chatId);

    const handle = setTimeout(() => {
      this.timers.delete(chatId);
      fn().catch((err: unknown) => {
        // Erros na função agendada não devem derrubar o processo;
        // o engine de classificação tem sua própria tratativa de erros.
        console.error(`[DebounceScheduler] Error executing scheduled fn for chatId=${chatId}:`, err);
      });
    }, this.delay);

    this.timers.set(chatId, handle);
  }

  /**
   * Cancela o timer pendente de um chatId específico.
   * Idempotente: não lança erro se não houver timer pendente.
   */
  cancel(chatId: string): void {
    const existing = this.timers.get(chatId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.timers.delete(chatId);
    }
  }

  /**
   * Cancela todos os timers pendentes — deve ser chamado no shutdown do processo.
   */
  cancelAll(): void {
    for (const [chatId] of this.timers) {
      this.cancel(chatId);
    }
  }

  /**
   * Retorna o número de chatIds com timer pendente.
   */
  pendingCount(): number {
    return this.timers.size;
  }
}
