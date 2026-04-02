# zap-classificator

Sistema local de leitura, sincronização e classificação de conversas WhatsApp via Baileys.

> **Somente leitura** — o sistema nunca envia mensagens.

---

## O que faz

- Conecta ao WhatsApp via QR code e escuta mensagens em tempo real
- Persiste conversas, mensagens e contatos em SQLite local
- Classifica conversas automaticamente (regras + LLM) em categorias como `lead_quente`, `suporte`, `cliente_ativo`, etc.
- Executa ciclos automáticos de sincronização e classificação via cron
- Expõe dashboard web para visualização e override manual de classificações

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
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
nvm use 20
```

**Git**

```bash
xcode-select --install   # instala git junto com as command line tools
```

---

### 2. Clonar e instalar

```bash
git clone <url-do-repositorio>
cd zap-classificator
npm install
```

---

### 3. Configurar variáveis de ambiente

Criar o arquivo `.env` na raiz do projeto:

```bash
cp .env.example .env   # se existir
# ou criar manualmente:
touch .env
```

Editar `.env` com:

```env
# Obrigatório para classificação LLM (https://console.anthropic.com)
ANTHROPIC_API_KEY=sk-ant-...

# Opcional — porta do dashboard (padrão: 3000)
PORT=3000
```

> A chave Anthropic só é necessária quando a classificação por regras não é suficiente (confidence < 0.75 + conversa com ≥ 3 mensagens e ≥ 50 chars). O sistema funciona sem ela, mas conversas ambíguas ficam marcadas como `indefinido`.

---

### 4. Criar o banco de dados

```bash
npm run db:migrate
```

Isso cria o arquivo `data/db.sqlite` com todas as tabelas e índices. Pode ser rodado novamente sem problemas (idempotente).

---

### 5. Iniciar o sistema

```bash
npm run dev
```

Na primeira execução, um QR code aparece no terminal:

```
Escaneie o QR code para autenticar
█████████████████
█ ▄▄▄▄▄ █▀ █ ...
...
```

**Para autenticar:**
1. Abrir o WhatsApp no celular
2. Ir em **Configurações → Dispositivos conectados → Conectar dispositivo**
3. Escanear o QR code

Após o scan:

```
WhatsApp conectado com sucesso
[index] Banco de dados inicializado
[dashboard] API rodando em http://localhost:3000
```

---

### 6. Acessar o dashboard

Abrir no navegador: **http://localhost:3000**

O dashboard exibe:
- Resumo de conversas por status
- Lista filtrável por status, prioridade, intenção e origem da classificação
- Detalhe de cada conversa com mensagens e histórico de classificações
- Botão para override manual de classificação
- Botão para disparar sincronização manual

---

## Comandos disponíveis

```bash
npm run dev           # inicia o sistema completo (WhatsApp + scheduler + dashboard)
npm run dev:baileys   # apenas conexão WhatsApp (sem dashboard)
npm run db:migrate    # aplica migrations pendentes
npm run db:studio     # abre Drizzle Studio para inspecionar o banco visualmente
npm run db:generate   # gera nova migration após alterar src/banco/schema.ts
npm run typecheck     # verifica erros TypeScript (sem compilar)
npm run lint          # ESLint
npm test              # testes unitários
```

---

## Estrutura de dados

```
data/
├── auth/       # credenciais da sessão WhatsApp (gerado no primeiro login)
├── db.sqlite   # banco principal
└── logs/       # logs opcionais de sync_runs
```

> **Nunca commitar `data/auth/`** — contém as credenciais da conta WhatsApp.

---

## Re-autenticar (trocar de conta ou sessão expirada)

Se o QR code não aparecer ou a conexão falhar com "loggedOut":

```bash
rm -rf data/auth/
npm run dev   # novo QR code será gerado
```

---

## Entender as classificações

| Status | Significado |
|--------|-------------|
| `lead_quente` | Interesse em compra detectado |
| `lead_frio` | Contato inicial sem intenção clara |
| `cliente_ativo` | Histórico de compras identificado |
| `suporte` | Problema ou dúvida técnica |
| `encerrado` | Conversa finalizada |
| `indefinido` | Não foi possível classificar |

**Prioridades:** 1 (alta) → 2 (média) → 3 (baixa)

**Origem da classificação:**
- `rules` — classificado por regex local (instantâneo, sem custo)
- `llm` — classificado pela API Anthropic (para conversas ambíguas)
- `manual` — override feito pelo operador no dashboard (nunca sobrescrito automaticamente)

---

## Scheduler automático

| Job | Frequência | O que faz |
|-----|-----------|-----------|
| Sync incremental | A cada 30 min | Reclassifica conversas novas ou com erros anteriores |
| Batch completo | A cada 1 hora | Reclassifica conversas ativas das últimas 2 horas |

O histórico de execuções fica visível no dashboard em **Sync Runs**.

---

## Solução de problemas

**QR code não aparece**
- Verificar se `data/auth/` está vazio ou não existe
- Rodar `rm -rf data/auth/ && npm run dev`

**"Sessão substituída por outro dispositivo"**
- Outro dispositivo ou instância do sistema assumiu a sessão
- Encerrar todas as instâncias e reconectar manualmente

**Classificações sempre `indefinido`**
- Verificar se `ANTHROPIC_API_KEY` está configurada no `.env`
- Conversas com menos de 3 mensagens ou menos de 50 caracteres são classificadas como `indefinido` por design

**Banco corrompido ou schema desatualizado**
```bash
npm run db:migrate   # aplica migrations pendentes
```

**Porta 3000 já em uso**
```bash
PORT=3001 npm run dev
```
