# zap-classificator — Coletor Local WhatsApp

Coleta conversas do WhatsApp via Baileys, persiste em SQLite local e envia os dados para a [zap-api](https://github.com/1612na/zap-api) no Render. O Manus CRM consome os dados diretamente da zap-api.

> **Somente leitura** — o sistema nunca envia mensagens.

```
[WhatsApp] ──Baileys──▶ [Este coletor] ──POST a cada 30s──▶ [zap-api no Render]
                              │                                       │
                           SQLite                              PostgreSQL
                         (buffer local)                               │
                                                              [Manus CRM]
```

---

## Pré-requisitos

- **Node.js 20+** — verificar com `node --version`
- **Conta WhatsApp** no celular para escanear o QR
- **zap-api** no Render já deployada — você precisará da URL e da API Key

**Instalar Node.js:**
```bash
# via Homebrew (Mac)
brew install node

# ou via nvm
nvm install 20 && nvm use 20
```

---

## Instalação do zero

### 1. Clonar e instalar dependências

```bash
git clone https://github.com/1612na/zap-classificator.git
cd zap-classificator
npm install
```

---

### 2. Configurar variáveis de ambiente

```bash
cp .env.example .env
```

Abrir o `.env` e preencher:

```env
# URL da zap-api no Render (sem barra no final)
RENDER_API_URL=https://zap-api-uyyw.onrender.com

# Mesma chave configurada em COLLECTOR_API_KEY na zap-api
RENDER_API_KEY=sua-chave-secreta-aqui

# Porta local para diagnóstico (padrão: 3000)
PORT=3000
```

> **Como obter a `RENDER_API_KEY`:** acesse o Render Dashboard → **zap-api** →
> **Environment** → copie o valor de `COLLECTOR_API_KEY`.
> Se ainda não existe, gere com `openssl rand -hex 32` e salve nos dois lugares.

---

### 3. Criar o banco de dados local

```bash
npm run db:migrate
```

Cria `data/db.sqlite` com o schema completo. Seguro rodar mais de uma vez.

---

### 4. Iniciar o coletor

```bash
npm run dev
```

Na primeira execução um QR code aparece no terminal:

```
[index] Banco de dados inicializado
[local-api] Diagnóstico em http://localhost:3000/health
[local-api] QR scan em http://localhost:3000/qr
[index] Iniciando conexão WhatsApp…
Escaneie o QR code para autenticar (ou acesse http://localhost:3000/qr)
```

**Para autenticar:**
1. Abrir o WhatsApp no celular
2. Ir em **Configurações → Dispositivos conectados → Conectar dispositivo**
3. Escanear o QR code no terminal ou em `http://localhost:3000/qr`

Após conectar:
```
WhatsApp conectado com sucesso
[pusher] Worker iniciado — ciclo a cada 30s
```

Os dados começam a fluir para o Render automaticamente.

---

## Como funciona após conectar

| Evento Baileys | Ação do coletor |
|---|---|
| Nova mensagem | Salva no SQLite + enfileira no `push_queue` |
| Chat atualizado | Atualiza conversa no SQLite + enfileira |
| Contato atualizado | Atualiza contato no SQLite + enfileira |
| A cada 30 segundos | Worker drena a fila e envia lote para a zap-api |

O SQLite funciona como **buffer de resiliência**: se a zap-api estiver indisponível, os eventos ficam enfileirados e são reenviados automaticamente com backoff exponencial (até 10 tentativas, de 30s até 30min de intervalo).

---

## Diagnóstico local

O coletor expõe apenas três endpoints em `http://localhost:3000`:

```bash
# Verificar status da conexão WhatsApp
curl http://localhost:3000/health
# {"ok":true,"whatsapp":"connected","ts":"2026-04-07T10:00:00.000Z"}

# Estado do QR para automação
curl http://localhost:3000/auth/qr
# {"status":"connected","qr":null}

# Página HTML para escanear QR no browser
open http://localhost:3000/qr
```

> Os endpoints de consulta de dados (`/conversations/summary`, `/conversations/updated`,
> `/conversations/:id/full`) ficam na **zap-api** no Render — não neste coletor.

---

## Comandos

```bash
npm run dev           # inicia coletor (WhatsApp + pusher + diagnóstico)
npm run db:migrate    # cria/atualiza banco SQLite local
npm run db:studio     # abre Drizzle Studio para inspecionar o banco no browser
npm run db:generate   # gera nova migration após alterar src/banco/schema.ts
npm run typecheck     # verifica erros TypeScript
npm run lint          # ESLint
```

---

## Arquivos gerados localmente

```
data/
├── auth/       # ⚠️  sessão WhatsApp autenticada — NUNCA commitar, fazer backup
├── db.sqlite   # banco SQLite (buffer + histórico local)
└── logs/       # logs opcionais
```

> `data/auth/` já está no `.gitignore`. **Faça backup manual** desta pasta —
> se for deletada, um novo QR scan será necessário.

---

## Schema SQLite (tabelas locais)

| Tabela | Descrição |
|---|---|
| `contacts` | Contatos com nome, push_name, is_business, avatar_url, about |
| `conversations` | Chats (JID completo como PK), last_message_at, unread_count |
| `messages` | Mensagens com mídia, sender_jid, is_forwarded, quoted_message_id |
| `sync_runs` | Log de execuções para diagnóstico |
| `push_queue` | Fila de envio para o Render com status e controle de retry |

---

## Re-autenticar

Se a sessão expirar ou aparecer erro "loggedOut":

```bash
rm -rf data/auth/
npm run dev
```

---

## Solução de problemas

**QR code não aparece no terminal**
```bash
rm -rf data/auth/ && npm run dev
```

**"Sessão substituída por outro dispositivo" (erro 440)**
O WhatsApp detectou outra instância ativa. Encerrar tudo, aguardar 1 minuto e reconectar.

**Dados não chegam no Render**
1. Confirmar que `.env` tem `RENDER_API_URL` e `RENDER_API_KEY` corretos
2. Confirmar que `COLLECTOR_API_KEY` no Render é igual a `RENDER_API_KEY` no `.env`
3. Verificar logs — o pusher mostra `✓ N message(s) enviados` ou o erro HTTP específico

**Banco desatualizado após atualizar o projeto**
```bash
npm run db:migrate
```

**Porta 3000 já em uso**
```bash
PORT=3001 npm run dev
```

---

## Branches

| Branch | Descrição |
|---|---|
| `main` | Versão atual — coletor com pusher para Render |
| `zap-collector-local-api` | Versão anterior — coletor com API local completa (sem Render) |
| `zap-classificator-full` | Versão original — coletor + classificador + dashboard próprio |
