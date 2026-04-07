# zap-classificator

Coletor local de dados WhatsApp via Baileys que expõe uma API REST para consumo pelo CRM IR Audit (Manus IA).

> **Somente leitura** — o sistema nunca envia mensagens.

---

## O que faz

- Conecta ao WhatsApp via QR code e escuta mensagens em tempo real
- Persiste conversas, mensagens e contatos em SQLite local
- Expõe API REST para que o Manus faça triagem, sync incremental e leitura de histórico completo
- Toda classificação é responsabilidade do Manus — este sistema apenas coleta e serve dados

---

## Quickstart — Mac limpo

### 1. Pré-requisitos

**Node.js 20+**

```bash
# Verificar se já tem
node --version   # precisa ser >= 20

# Instalar via Homebrew (se não tiver)
brew install node

# Ou via nvm
nvm install 20 && nvm use 20
```

---

### 2. Clonar e instalar

```bash
git clone <url-do-repositorio>
cd zap-classificator
npm install
```

---

### 3. Variáveis de ambiente (opcional)

```bash
# Opcional — porta da API (padrão: 3000)
PORT=3000
```

Não é necessária nenhuma chave de API externa. O sistema é 100% local.

---

### 4. Criar o banco de dados

```bash
npm run db:migrate
```

Cria `data/db.sqlite` com o schema atual. Idempotente — pode ser rodado novamente sem problemas.

---

### 5. Iniciar

```bash
npm run dev
```

Na primeira execução, um QR code aparece no terminal:

```
[index] Banco de dados inicializado
[api] REST API rodando em http://localhost:3000
[index] Iniciando conexão WhatsApp…
Escaneie o QR code para autenticar
```

**Para autenticar:**
1. Abrir o WhatsApp no celular
2. Ir em **Configurações → Dispositivos conectados → Conectar dispositivo**
3. Escanear o QR code

---

## API REST

Base URL: `http://localhost:3000`

### `GET /conversations/summary`

Triagem paginada de conversas com 10 mensagens de amostra por conversa.

| Parâmetro | Tipo | Padrão | Descrição |
|-----------|------|--------|-----------|
| `page` | int | 1 | Página |
| `limit` | int | 50 | Itens por página (máx 100) |
| `since` | ISO 8601 | — | Filtrar conversas atualizadas após esta data |

```bash
curl "http://localhost:3000/conversations/summary?page=1&limit=50"
curl "http://localhost:3000/conversations/summary?since=2026-04-01T00:00:00Z"
```

---

### `GET /conversations/updated`

Sync incremental — retorna apenas conversas atualizadas após `since`.

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `since` | ISO 8601 | **sim** | Timestamp do último sync |
| `limit` | int | 50 | Máx 100 |

Retorna `sync_token` para usar como próximo `since`.

```bash
curl "http://localhost:3000/conversations/updated?since=2026-04-07T10:00:00Z"
```

---

### `GET /conversations/:id/full`

Histórico completo de uma conversa com paginação por cursor.

| Parâmetro | Tipo | Padrão | Descrição |
|-----------|------|--------|-----------|
| `limit` | int | 200 | Máx 500 mensagens |
| `before` | ISO 8601 | — | Cursor: mensagens anteriores a esta data |

```bash
curl "http://localhost:3000/conversations/5511999998888@s.whatsapp.net/full"
curl "http://localhost:3000/conversations/5511999998888@s.whatsapp.net/full?before=2026-04-07T12:00:00Z"
```

---

### `GET /auth/qr`

Estado da conexão WhatsApp.

```json
{ "status": "connected", "qr": null }
{ "status": "pending",   "qr": "2@abc123..." }
```

---

### `GET /qr`

Página HTML com QR code para autenticação via browser.

---

## Comandos disponíveis

```bash
npm run dev           # inicia o sistema (WhatsApp + API)
npm run db:migrate    # aplica migrations pendentes
npm run db:studio     # abre Drizzle Studio para inspecionar o banco
npm run db:generate   # gera nova migration após alterar src/banco/schema.ts
npm run typecheck     # verifica erros TypeScript
npm run lint          # ESLint
```

---

## Estrutura de dados

```
data/
├── auth/       # credenciais da sessão WhatsApp (gerado no primeiro login)
├── db.sqlite   # banco principal
└── logs/       # sync_runs logs opcionais
```

> **Nunca commitar `data/auth/`** — contém as credenciais da conta WhatsApp.

---

## Schema SQLite

| Tabela | Descrição |
|--------|-----------|
| `contacts` | Contatos com nome, push_name, is_business, about |
| `conversations` | Chats (JID completo como PK), com last_message_at e unread_count |
| `messages` | Mensagens com campos de mídia, from_me, sender_jid, is_forwarded |
| `sync_runs` | Log de execuções para diagnóstico |

---

## Re-autenticar

Se o QR code não aparecer ou a conexão falhar com "loggedOut":

```bash
rm -rf data/auth/
npm run dev   # novo QR code será gerado
```

---

## Solução de problemas

**QR code não aparece**
```bash
rm -rf data/auth/ && npm run dev
```

**"Sessão substituída por outro dispositivo"**
- Encerrar todas as instâncias e reconectar

**Banco desatualizado após atualização**
```bash
npm run db:migrate
```

**Porta 3000 já em uso**
```bash
PORT=3001 npm run dev
```
