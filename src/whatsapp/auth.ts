import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import path from 'path'
import qrcode from 'qrcode-terminal'
import { bus } from '../shared/events.js'
import { registerListeners } from './listener.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTH_DIR = path.resolve('./data/auth')
const BACKOFF_BASE = 1000   // 1 s
const BACKOFF_MAX = 30_000  // 30 s cap

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the backoff delay in ms for a given attempt number (1-based).
 *   attempt 1 → 1 s
 *   attempt 2 → 2 s
 *   attempt 3 → 4 s
 *   attempt N → min(1s * 2^(N-1), 30s)
 */
function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_BASE * Math.pow(2, attempt - 1), BACKOFF_MAX)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Creates a Baileys WebSocket connection with exponential-backoff reconnect.
 *
 * @param attempt - 1-based reconnection attempt counter; callers should omit
 *                  this (defaults to 1) — the function increments it
 *                  internally on reconnect.
 */
export async function createConnection(attempt = 1): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.macOS('Chrome'),
    // syncFullHistory: ativar apenas para carga inicial do histórico.
    // Em produção manter false para evitar ban. Controlar via env SYNC_FULL_HISTORY=true.
    syncFullHistory: process.env['SYNC_FULL_HISTORY'] === 'true',
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  })

  // Persist credential updates (key ratchet, session refresh, etc.)
  // Wrap in a void-returning lambda so no-misused-promises is satisfied:
  // saveCreds() returns Promise<void> but the event handler expects void.
  sock.ev.on('creds.update', () => { void saveCreds() })

  // Register domain event listeners (messages, chats, contacts)
  registerListeners(sock)

  // Wrap async logic in a named inner function so the event handler itself
  // is synchronous (void-returning), satisfying no-misused-promises.
  async function handleConnectionUpdate(
    update: Parameters<Parameters<typeof sock.ev.on<'connection.update'>>[1]>[0],
  ): Promise<void> {
    const { connection, qr, lastDisconnect } = update

    if (qr) {
      console.log('Escaneie o QR code para autenticar (ou acesse http://localhost:3000/qr)')
      qrcode.generate(qr, { small: true })
      bus.emit('whatsapp:qr', { qr })
    }

    if (connection === 'open') {
      console.log('WhatsApp conectado com sucesso')
      bus.emit('whatsapp:connected')
    }

    if (connection === 'close') {
      // Determine the HTTP status code from the Boom error, if available.
      const error = lastDisconnect?.error
      const statusCode =
        error instanceof Boom
          ? error.output.statusCode
          : undefined

      if (statusCode === DisconnectReason.loggedOut) {
        console.error(
          'Sessão encerrada (loggedOut). Remova data/auth/ e reinicie para re-autenticar.',
        )
        // Do NOT reconnect — account logged out requires a new QR scan.
        return
      }

      // DisconnectReason.connectionReplaced = 440: another device took over this session.
      // Reconnecting in a loop here would worsen the situation and risk a ban.
      if (statusCode === DisconnectReason.connectionReplaced) {
        console.warn(
          'Sessão substituída por outro dispositivo (replaced/440). ' +
          'Não será feita reconexão automática — reinicie manualmente se necessário.',
        )
        return
      }

      // Close the current WebSocket before opening a new connection to avoid
      // multiple simultaneous connections to the same number (ban risk).
      await sock.ws?.close()

      const delay = backoffDelay(attempt)
      console.warn(
        `Conexão encerrada (código: ${statusCode ?? 'desconhecido'}). ` +
        `Reconectando em ${delay / 1000}s (tentativa ${attempt})…`,
      )
      await sleep(delay)
      // Pass attempt + 1 so backoff grows on successive failures.
      // When connection eventually opens, the next reconnect resets to 1.
      await createConnection(attempt + 1)
    }
  }

  sock.ev.on('connection.update', (update) => { void handleConnectionUpdate(update) })
}
