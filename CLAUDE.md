# zap-classificator — Contexto do Projeto para Agentes

## O que é este sistema

Sistema local Node.js/TypeScript de **leitura, sincronização, organização e classificação de conversas WhatsApp** via Baileys. Não envia mensagens — apenas lê, processa e classifica.

Spec completa: `whatsapp-baileys-architecture.pdf`

---

## Stack técnica

| Camada | Tecnologia |
|--------|-----------|
| WhatsApp | `@whiskeysockets/baileys` (WebSocket, somente-leitura) |
| Banco | `better-sqlite3` + `drizzle-orm` |
| Scheduler | `node-cron` |
| Classificação | Regex local → LLM API (fallback) |
| Dashboard | Express (API) + React ou Svelte (frontend) |
| Linguagem | TypeScript (ESM) |
| Runtime | Node.js 20+ |

---

## Estrutura de módulos (hierarquia estrita)

```
src/
├── shared/         # contratos: EventEmitter bus, types, interfaces
│   └── events.ts   # MessageReceivedEvent, ChatUpdatedEvent (schema fixo)
├── whatsapp/       # ÚNICO ponto que conhece Baileys
│   ├── auth.ts     # useMultiFileAuthState → ./data/auth/
│   └── listener.ts # traduz eventos Baileys → eventos de domínio
├── ingestão/       # normaliza e valida dados brutos
│   └── normalizer.ts
├── banco/          # repositório puro — sem lógica de negócio
│   ├── schema.ts   # definição drizzle
│   └── repository.ts
├── classificação/  # motor híbrido regras + LLM
│   ├── rules.ts    # regex com confidence threshold 0.75
│   ├── llm.ts      # chamada LLM com response_format: json_object
│   └── engine.ts   # orquestra: regras → LLM → salva
├── scheduler/      # orquestra ciclos automáticos
│   ├── index.ts    # node-cron jobs
│   ├── debounce.ts # 5min debounce por chatId
│   ├── sync.ts     # runIncrementalSync
│   └── lock.ts     # runWithLock (evita jobs concorrentes)
└── dashboard/      # consome banco via repositório
    ├── api.ts      # Express REST
    └── frontend/   # React/Svelte
```

**Regra inviolável de dependência** (módulo só pode importar os abaixo dele):
```
dashboard → banco
scheduler → classificação, banco
classificação → banco
ingestão → banco
whatsapp → (nenhum módulo interno)
banco → (nenhum módulo interno)
shared → (nenhum módulo interno)
```
Nenhum módulo importa Baileys diretamente exceto `whatsapp/`.

---

## Schema SQLite (tabelas críticas)

- `contacts` — id (número limpo), name, display_name
- `conversations` — id (JID completo), contact_id, last_message_at, unread_count
- `messages` — id (WhatsApp ID), chat_id, timestamp (Unix ms), text, message_type, raw_payload
- `classifications` — conversation_id (UNIQUE), status, intent, sentiment, priority, classified_by, classified_at
- `classification_history` — audit trail imutável de todas as classificações
- `sync_runs` — log de execuções do scheduler (started_at, finished_at, status, error)

---

## Contratos de dados críticos

### ClassificationResult
```typescript
{
  status: 'lead_frio' | 'lead_quente' | 'cliente_ativo' | 'suporte' | 'encerrado' | 'indefinido'
  intent: 'compra' | 'suporte' | 'duvida' | 'reclamacao' | 'nenhum' | null
  sentiment: 'positivo' | 'neutro' | 'negativo'
  priority: 1 | 2 | 3
  summary: string          // max 100 chars
  next_action: string      // max 80 chars
  classified_by: 'rules' | 'llm' | 'manual'
  model_version?: string
  confidence: number       // 0-1
}
```

### Regras de idempotência
- `messages`: `INSERT OR IGNORE` (nunca duplica)
- `conversations`: `UPSERT` (atualiza last_message_at, unread_count)
- `classifications`: `UPSERT WHERE classified_by != 'manual'` (override manual não é sobrescrito)

---

## Riscos específicos que todos os agentes devem conhecer

1. **Baileys pode banir a conta** se: múltiplas reconexões rápidas, `syncFullHistory: true`, múltiplas instâncias para o mesmo número
2. **Lock de scheduler** é obrigatório: job de classificação pode durar mais que o intervalo do cron
3. **Debounce de 5 min** antes de classificar: uma única mensagem nova não dispara classificação imediata
4. **LLM só é chamada** quando regras retornam `confidence < 0.75` E conversa tem ≥ 3 mensagens E ≥ 50 chars de texto
5. **classified_by = 'manual'** nunca é sobrescrito pelo scheduler automático

---

## Sprints do projeto

### Sprint 1 — Fundação (Dias 1-3)
**Entregável**: conexão Baileys funcional + schema SQLite criado + EventBus configurado

Tarefas:
- Setup TypeScript/ESM + dependências
- `banco/schema.ts` com todas as 6 tabelas e índices
- `shared/events.ts` com contratos de eventos
- `whatsapp/auth.ts` com `useMultiFileAuthState` + backoff exponencial
- `whatsapp/listener.ts` registrando os 3 eventos: `messages.upsert`, `chats.upsert`, `contacts.upsert`

**Gate de aprovação**: QR scan funciona → `connection.open` dispara → DB criado → eventos loggados no console

---

### Sprint 2 — Pipeline de Ingestão (Dias 4-6)
**Entregável**: mensagens reais sendo persistidas no SQLite com deduplicação

Tarefas:
- `ingestão/normalizer.ts` tratando: conversation, extendedText, imageMessage, videoMessage, documentMessage
- `banco/repository.ts` com: `upsertMessage`, `upsertConversation`, `upsertContact`
- Integração listener → normalizer → repository
- Teste de idempotência: mesma mensagem processada 2x → 1 registro no banco

**Gate de aprovação**: 10 mensagens reais capturadas + queries de validação mostram sem duplicatas

---

### Sprint 3 — Motor de Classificação (Dias 7-10)
**Entregável**: conversas sendo classificadas automaticamente (regras + LLM)

Tarefas:
- `classificação/rules.ts` com ≥ 5 regras cobrindo os casos principais
- `classificação/llm.ts` com prompt JSON + `response_format: json_object`
- `classificação/engine.ts` orquestrando o pipeline híbrido
- `scheduler/debounce.ts` com 5min debounce por chatId
- `banco/repository.ts` + `saveClassification` + insert em `classification_history`

**Gate de aprovação**: 3 conversas com padrões conhecidos → classificadas por regras (sem chamar LLM). 1 conversa ambígua → LLM chamada → resultado salvo no histórico

---

### Sprint 4 — Scheduler + Dashboard (Dias 11-15)
**Entregável**: dashboard operacional com dados ao vivo e scheduler rodando

Tarefas:
- `scheduler/lock.ts` com `runWithLock`
- `scheduler/index.ts` com 2 jobs: sync (30min) + classificação em lote (1h)
- `scheduler/sync.ts` com query incremental (classificações desatualizadas)
- `dashboard/api.ts` com endpoints: GET /conversations, GET /conversations/:id, PATCH /:id/classify, GET /stats/summary, GET /sync-runs, POST /sync/trigger
- Frontend com filtros: status, prioridade, intenção, período, origem da classificação

**Gate de aprovação**: dashboard mostra conversas classificadas + override manual funciona + log de sync_runs registra execuções

---

## Comandos de desenvolvimento

```bash
npm run dev          # inicia sistema completo
npm run dev:baileys  # apenas conexão Baileys (sem dashboard)
npm run db:migrate   # roda migrações drizzle
npm run db:studio    # drizzle studio para inspecionar banco
npm test             # testes unitários (classificação/rules, normalizer)
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
```

---

## Dados persistidos

```
data/
├── auth/       # credenciais Baileys (useMultiFileAuthState)
├── db.sqlite   # banco principal
└── logs/       # sync_runs logs opcionais
```

**NUNCA commitar** `data/auth/` — contém credenciais WhatsApp.

---

## Estado atual (atualizado em 2026-04-07)

### Versão em andamento: **Collector API para CRM IR Audit (Manus IA)**

#### Responsabilidade do sistema
- Coletar dados WhatsApp via Baileys (somente leitura)
- Normalizar e persistir no SQLite
- Expor API REST para consumo pelo CRM Manus

#### Classificação: feita 100% pelo Manus — não implementada aqui

#### Endpoints implementados:
- `GET /conversations/summary?page=&limit=&since=` — triagem paginada (50/req)
- `GET /conversations/updated?since=&limit=` — sync incremental com sync_token
- `GET /conversations/:id/full?limit=&before=` — histórico completo com cursor

#### Módulos removidos:
- `src/classificacao/` — removido (Manus classifica)
- `src/scheduler/` — removido (Manus puxa via polling a cada 2min)
- `src/dashboard/frontend/app.js` — removido (Manus tem dashboard próprio)

---

## Protocolo de validação antes de cada entrega

1. `npm run typecheck` — zero erros TypeScript
2. `npm run lint` — zero warnings
3. Teste de idempotência manual: reprocessar mesmo evento → sem duplicatas no banco
4. Verificar endpoints REST via curl: `GET /conversations/summary`, `GET /conversations/updated?since=...`, `GET /conversations/:id/full`
