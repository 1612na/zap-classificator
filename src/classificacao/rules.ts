// ---------------------------------------------------------------------------
// classificacao/rules.ts — motor de regras local baseado em regex.
//
// Retorna ClassificationResult quando confidence >= 0.75.
// Retorna null quando nenhuma regra dispara com confiança suficiente
// (sinal para o engine chamar o LLM).
// ---------------------------------------------------------------------------

export type { ClassificationResult } from '../shared/types.js';
import type { ClassificationResult } from '../shared/types.js';

export interface MessageForClassification {
  text: string | null;
  fromMe: boolean;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function joinText(messages: MessageForClassification[]): string {
  return messages
    .map((m) => m.text ?? '')
    .join(' ')
    .trim();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

interface RuleMatch {
  status: ClassificationResult['status'];
  intent: ClassificationResult['intent'];
  sentiment: ClassificationResult['sentiment'];
  priority: ClassificationResult['priority'];
  summary: string;
  next_action: string;
  confidence: number;
}

// Rule 1 — lead_quente: interesse de compra explícito
const COMPRA_RE =
  /\b(quero\s+comprar|quero\s+pedir|vou\s+comprar|quanto\s+custa|qual\s+o\s+pre[cç]o|tem\s+dispon[ií]vel|tem\s+estoque|valor\s+do|pre[cç]o\s+do|me\s+passa\s+o\s+valor|me\s+manda\s+o\s+pre[cç]o|aceita\s+pix|forma[s]?\s+de\s+pagamento|parcel|parcelas|formas?\s+de\s+pagar)\b/i;

// Rule 2 — suporte: problemas e defeitos
const SUPORTE_RE =
  /\b(n[aã]o\s+funciona|com\s+defeito|problema|problema\s+com|deu\s+erro|deu\s+pau|parou\s+de\s+funcionar|quebrou|defeituoso|est[aá]\s+com\s+problema|n[aã]o\s+est[aá]\s+funcionando|travou|bugou|n[aã]o\s+abre|n[aã]o\s+liga|n[aã]o\s+carrega|tela\s+pret[ao]|err[ao]\s+ao|falhou)\b/i;

// Rule 3 — encerrado: mensagens de encerramento / agradecimento
const ENCERRADO_RE =
  /\b(obrigad[ao]|muito\s+obrigad[ao]|valeu|resolvido|j[aá]\s+resolveu|problema\s+resolvido|tudo\s+certo|tudo\s+ok|pode\s+fechar|at[eé]\s+mais|at[eé]\s+logo|tchau|foi\s+resolvido|consegui\s+resolver|ok\s+obrigad[ao])\b/i;

// Rule 4 — lead_frio: apenas saudação sem intenção adicional
const SAUDACAO_ONLY_RE =
  /^[\s]*((oi|ol[aá]|bom\s+dia|boa\s+tarde|boa\s+noite|e\s+a[ií]|tudo\s+bem|tudo\s+bom|ola)[?,!.\s]*)+[\s]*$/i;

// Rule 5 — reclamacao: insatisfação ou frustração explícita
const RECLAMACAO_RE =
  /\b(absurdo|rid[ií]culo|horr[ií]vel|p[eé]ssimo|p[eé]ssima|horrendo|uma\s+vergonha|vergonhoso|um\s+lixo|uma\s+merda|decepcionado|decepcionante|nunca\s+mais\s+compro|nunca\s+mais\s+compra|vou\s+reclamar|vou\s+processar|inaceit[aá]vel|inadmiss[ií]vel|fraude|me\s+enganaram|fui\s+enganado)\b/i;

// Rule 6 — cliente_ativo: menção a compra anterior ou relacionamento estabelecido
const CLIENTE_ATIVO_RE =
  /\b(j[aá]\s+comprei|comprei\s+antes|meu\s+pedido|n[uú]mero\s+do\s+pedido|meu\s+produto|j[aá]\s+sou\s+cliente|cliente\s+desde|segunda\s+compra|terceira\s+compra|sempre\s+compro|compro\s+sempre|compro\s+direto|volte[i]?\s+para\s+comprar|quero\s+comprar\s+de\s+novo|quero\s+pedir\s+de\s+novo)\b/i;

// ---------------------------------------------------------------------------
// Core classification logic
// ---------------------------------------------------------------------------

export function classifyByRules(
  messages: MessageForClassification[],
): ClassificationResult | null {
  if (messages.length === 0) return null;

  const fullText = joinText(messages);
  if (fullText.length === 0) return null;

  // Collect all candidate matches, then pick the highest-confidence one.
  // Using an array avoids TypeScript's control-flow narrowing trap that
  // would turn `best` into `never` inside chained `if (!best || ...)` blocks.
  const candidates: RuleMatch[] = [];

  // Rule 1 — lead_quente / compra
  if (COMPRA_RE.test(fullText)) {
    candidates.push({
      status: 'lead_quente',
      intent: 'compra',
      sentiment: 'neutro',
      priority: 1,
      summary: truncate('Interesse em compra detectado na conversa', 100),
      next_action: truncate('Entrar em contato para apresentar proposta', 80),
      confidence: 0.85,
    });
  }

  // Rule 2 — suporte / problema
  if (SUPORTE_RE.test(fullText)) {
    candidates.push({
      status: 'suporte',
      intent: 'suporte',
      sentiment: 'neutro',
      priority: 2,
      summary: truncate('Cliente relatou problema ou defeito com produto/serviço', 100),
      next_action: truncate('Acionar equipe de suporte técnico', 80),
      confidence: 0.82,
    });
  }

  // Rule 5 — reclamacao (avaliada antes de encerrado para não ser mascarada)
  if (RECLAMACAO_RE.test(fullText)) {
    candidates.push({
      status: 'suporte',
      intent: 'reclamacao',
      sentiment: 'negativo',
      priority: 1,
      summary: truncate('Cliente expressou insatisfação ou reclamação grave', 100),
      next_action: truncate('Escalar para responsável e entrar em contato urgente', 80),
      confidence: 0.88,
    });
  }

  // Rule 6 — cliente_ativo: menção a relacionamento anterior
  if (CLIENTE_ATIVO_RE.test(fullText)) {
    candidates.push({
      status: 'cliente_ativo',
      intent: 'compra',
      sentiment: 'neutro',
      priority: 2,
      summary: truncate('Cliente recorrente com histórico de compras identificado', 100),
      next_action: truncate('Verificar histórico e oferecer atendimento personalizado', 80),
      confidence: 0.80,
    });
  }

  // Rule 3 — encerrado
  if (ENCERRADO_RE.test(fullText)) {
    candidates.push({
      status: 'encerrado',
      intent: 'nenhum',
      sentiment: 'positivo',
      priority: 3,
      summary: truncate('Conversa encerrada com agradecimento ou confirmação de resolução', 100),
      next_action: truncate('Arquivar conversa e registrar como encerrada', 80),
      confidence: 0.78,
    });
  }

  // Rule 4 — lead_frio: apenas saudação (texto completo = só saudação)
  if (SAUDACAO_ONLY_RE.test(fullText)) {
    candidates.push({
      status: 'lead_frio',
      intent: 'nenhum',
      sentiment: 'neutro',
      priority: 3,
      summary: truncate('Contato inicial com apenas saudação, sem intenção identificada', 100),
      next_action: truncate('Aguardar retorno ou enviar mensagem de boas-vindas', 80),
      confidence: 0.75,
    });
  }

  const best = candidates.reduce<RuleMatch | null>(
    (acc, cur) => (acc === null || cur.confidence > acc.confidence ? cur : acc),
    null,
  );

  if (!best || best.confidence < 0.75) return null;

  return {
    status: best.status,
    intent: best.intent,
    sentiment: best.sentiment,
    priority: best.priority,
    summary: best.summary,
    next_action: best.next_action,
    classified_by: 'rules',
    confidence: best.confidence,
  };
}
