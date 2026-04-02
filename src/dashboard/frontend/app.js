// ---------------------------------------------------------------------------
// app.js — React dashboard para zap-classificator.
// Carregado via Babel standalone (type="text/babel") do index.html.
// Sem bundler, sem TypeScript — React 18 via CDN.
// ---------------------------------------------------------------------------

const { useState, useEffect, useCallback, useRef } = React;

// ---------------------------------------------------------------------------
// Constantes e utilitários
// ---------------------------------------------------------------------------

const STATUS_OPTIONS = [
  'lead_quente',
  'lead_frio',
  'cliente_ativo',
  'suporte',
  'encerrado',
  'indefinido',
];

const INTENT_OPTIONS = ['compra', 'suporte', 'duvida', 'reclamacao', 'nenhum'];

const SENTIMENT_OPTIONS = ['positivo', 'neutro', 'negativo'];

const PRIORITY_OPTIONS = [1, 2, 3];

const STATUS_COLORS = {
  lead_quente:   '#d4edda',
  lead_frio:     '#e2e3e5',
  cliente_ativo: '#cce5ff',
  suporte:       '#f8d7da',
  encerrado:     '#f8f9fa',
  indefinido:    '#fff3cd',
};

function fmtTs(ts) {
  if (!ts) return '—';
  const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function displayName(conv) {
  return conv.name || conv.contact_id || conv.id;
}

async function apiFetch(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.error || body.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return body;
}

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------

function StatusBadge({ status }) {
  if (!status) return React.createElement('span', { className: 'text-muted' }, '—');
  return React.createElement(
    'span',
    { className: `badge badge-${status}` },
    status.replace('_', ' ')
  );
}

// ---------------------------------------------------------------------------
// PriorityDot
// ---------------------------------------------------------------------------

function PriorityDot({ priority }) {
  if (!priority) return React.createElement('span', { className: 'text-muted' }, '—');
  return React.createElement(
    'span',
    null,
    React.createElement('span', { className: `priority-dot p${priority}` }),
    `P${priority}`
  );
}

// ---------------------------------------------------------------------------
// Header — stats + botão de sync
// ---------------------------------------------------------------------------

function Header({ stats, onSyncClick, syncLoading, syncMessage }) {
  const byStatus = stats ? stats.by_status : {};
  const total = stats ? stats.total_conversations : '…';

  const chips = [
    { label: 'Total', value: total },
    ...STATUS_OPTIONS.map(s => ({ label: s.replace('_', ' '), value: byStatus[s] || 0 })),
    { label: 'sem class.', value: stats ? stats.unclassified : '…' },
  ];

  return React.createElement(
    'header',
    { className: 'header' },
    React.createElement('h1', null, 'zap-classificator'),
    React.createElement(
      'div',
      { className: 'stats-bar' },
      chips.map(c =>
        React.createElement(
          'span',
          { key: c.label, className: 'stat-chip' },
          React.createElement('strong', null, c.value),
          ' ',
          c.label
        )
      )
    ),
    React.createElement(
      'div',
      { className: 'header-actions' },
      syncMessage &&
        React.createElement('span', { className: 'sync-status' }, syncMessage),
      React.createElement(
        'a',
        {
          className: 'btn btn-secondary btn-sm',
          href: '/qr',
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        'QR Code'
      ),
      React.createElement(
        'button',
        {
          className: 'btn btn-primary btn-sm',
          onClick: onSyncClick,
          disabled: syncLoading,
        },
        syncLoading ? 'Sincronizando…' : 'Sincronizar agora'
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Sidebar — painel de filtros
// ---------------------------------------------------------------------------

function Sidebar({ filters, onChange }) {
  function set(key, value) {
    onChange({ ...filters, [key]: value });
  }

  return React.createElement(
    'aside',
    { className: 'sidebar' },
    React.createElement('h2', null, 'Filtros'),

    React.createElement(
      'div',
      { className: 'filter-group' },
      React.createElement('label', null, 'Status'),
      React.createElement(
        'select',
        { value: filters.status, onChange: e => set('status', e.target.value) },
        React.createElement('option', { value: '' }, 'Todos'),
        STATUS_OPTIONS.map(s =>
          React.createElement('option', { key: s, value: s }, s.replace('_', ' '))
        )
      )
    ),

    React.createElement(
      'div',
      { className: 'filter-group' },
      React.createElement('label', null, 'Prioridade'),
      React.createElement(
        'select',
        { value: filters.priority, onChange: e => set('priority', e.target.value) },
        React.createElement('option', { value: '' }, 'Todos'),
        PRIORITY_OPTIONS.map(p =>
          React.createElement('option', { key: p, value: p }, `P${p}`)
        )
      )
    ),

    React.createElement(
      'div',
      { className: 'filter-group' },
      React.createElement('label', null, 'Intenção'),
      React.createElement(
        'select',
        { value: filters.intent, onChange: e => set('intent', e.target.value) },
        React.createElement('option', { value: '' }, 'Todos'),
        INTENT_OPTIONS.map(i =>
          React.createElement('option', { key: i, value: i }, i)
        )
      )
    ),

    React.createElement(
      'div',
      { className: 'filter-group' },
      React.createElement('label', null, 'Classificado por'),
      React.createElement(
        'select',
        { value: filters.classified_by, onChange: e => set('classified_by', e.target.value) },
        React.createElement('option', { value: '' }, 'Todos'),
        ['rules', 'llm', 'manual'].map(v =>
          React.createElement('option', { key: v, value: v }, v)
        )
      )
    ),

    React.createElement(
      'div',
      { className: 'filter-group' },
      React.createElement('label', null, 'Desde'),
      React.createElement('input', {
        type: 'date',
        value: filters.since_date,
        onChange: e => set('since_date', e.target.value),
      })
    ),

    React.createElement(
      'button',
      {
        className: 'btn btn-secondary btn-sm',
        style: { marginTop: 4 },
        onClick: () =>
          onChange({ status: '', priority: '', intent: '', classified_by: '', since_date: '' }),
      },
      'Limpar filtros'
    )
  );
}

// ---------------------------------------------------------------------------
// ConversationTable
// ---------------------------------------------------------------------------

function ConversationTable({ rows, onSelect, loading, error }) {
  if (error) {
    return React.createElement('div', { className: 'error-banner' }, error);
  }
  if (loading) {
    return React.createElement('div', { className: 'loading' }, 'Carregando…');
  }
  if (!rows || rows.length === 0) {
    return React.createElement('div', { className: 'empty' }, 'Nenhuma conversa encontrada.');
  }

  const cols = [
    'Nome / ID',
    'Última mensagem',
    'Status',
    'Prioridade',
    'Intenção',
    'Sentimento',
    'Classificado por',
    '',
  ];

  return React.createElement(
    'div',
    { className: 'table-wrap' },
    React.createElement(
      'table',
      null,
      React.createElement(
        'thead',
        null,
        React.createElement(
          'tr',
          null,
          cols.map(c => React.createElement('th', { key: c }, c))
        )
      ),
      React.createElement(
        'tbody',
        null,
        rows.map(row => {
          const cl = row.classification;
          const bg = cl && cl.status ? STATUS_COLORS[cl.status] || 'transparent' : 'transparent';
          return React.createElement(
            'tr',
            { key: row.id, style: { background: bg } },
            React.createElement('td', null, displayName(row)),
            React.createElement('td', null, fmtTs(row.last_message_at)),
            React.createElement('td', null, React.createElement(StatusBadge, { status: cl && cl.status })),
            React.createElement('td', null, React.createElement(PriorityDot, { priority: cl && cl.priority })),
            React.createElement('td', null, (cl && cl.intent) || React.createElement('span', { className: 'text-muted' }, '—')),
            React.createElement('td', null, (cl && cl.sentiment) || React.createElement('span', { className: 'text-muted' }, '—')),
            React.createElement('td', null, (cl && cl.classified_by) || React.createElement('span', { className: 'text-muted' }, '—')),
            React.createElement(
              'td',
              null,
              React.createElement(
                'button',
                { className: 'btn btn-secondary btn-sm', onClick: () => onSelect(row.id) },
                'Ver'
              )
            )
          );
        })
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function Pagination({ offset, limit, count, onChange }) {
  const page = Math.floor(offset / limit) + 1;
  const hasPrev = offset > 0;
  const hasNext = count === limit; // heuristic: full page → may have more

  return React.createElement(
    'div',
    { className: 'pagination' },
    React.createElement(
      'button',
      {
        className: 'btn btn-secondary btn-sm',
        disabled: !hasPrev,
        onClick: () => onChange(Math.max(0, offset - limit)),
      },
      '← Anterior'
    ),
    React.createElement('span', null, `Página ${page}`),
    React.createElement(
      'button',
      {
        className: 'btn btn-secondary btn-sm',
        disabled: !hasNext,
        onClick: () => onChange(offset + limit),
      },
      'Próxima →'
    )
  );
}

// ---------------------------------------------------------------------------
// MessageBubble
// ---------------------------------------------------------------------------

function MessageBubble({ msg }) {
  const cls = msg.from_me ? 'msg-bubble from-me' : 'msg-bubble from-them';
  return React.createElement(
    'div',
    { className: cls },
    React.createElement('div', null, msg.text || React.createElement('em', null, `[${msg.message_type}]`)),
    React.createElement('div', { className: 'msg-meta' }, fmtTs(msg.timestamp))
  );
}

// ---------------------------------------------------------------------------
// ClassificationForm — override manual
// ---------------------------------------------------------------------------

function ClassificationForm({ conversationId, current, onSaved }) {
  const [form, setForm] = useState({
    status: current ? current.status : 'indefinido',
    intent: current ? (current.intent || '') : '',
    sentiment: current ? current.sentiment : 'neutro',
    priority: current ? String(current.priority) : '3',
    summary: current ? (current.summary || '') : '',
    next_action: current ? (current.next_action || '') : '',
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveOk, setSaveOk] = useState(false);

  function set(key, value) {
    setForm(f => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    try {
      const payload = {
        status: form.status,
        intent: form.intent || null,
        sentiment: form.sentiment,
        priority: Number(form.priority),
        summary: form.summary,
        next_action: form.next_action,
      };
      const updated = await apiFetch(`/conversations/${conversationId}/classify`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setSaveOk(true);
      onSaved(updated);
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return React.createElement(
    'form',
    { onSubmit: handleSubmit },
    saveError && React.createElement('div', { className: 'error-banner' }, saveError),
    saveOk && React.createElement(
      'div',
      { style: { background: '#d4edda', color: '#155724', padding: '8px 12px', borderRadius: 4, marginBottom: 8, fontSize: 13 } },
      'Classificação salva com sucesso.'
    ),
    React.createElement(
      'div',
      { className: 'form-grid' },

      React.createElement(
        'div',
        { className: 'form-group' },
        React.createElement('label', null, 'Status'),
        React.createElement(
          'select',
          { value: form.status, onChange: e => set('status', e.target.value) },
          STATUS_OPTIONS.map(s =>
            React.createElement('option', { key: s, value: s }, s.replace('_', ' '))
          )
        )
      ),

      React.createElement(
        'div',
        { className: 'form-group' },
        React.createElement('label', null, 'Prioridade'),
        React.createElement(
          'select',
          { value: form.priority, onChange: e => set('priority', e.target.value) },
          PRIORITY_OPTIONS.map(p =>
            React.createElement('option', { key: p, value: p }, `P${p}`)
          )
        )
      ),

      React.createElement(
        'div',
        { className: 'form-group' },
        React.createElement('label', null, 'Intenção'),
        React.createElement(
          'select',
          { value: form.intent, onChange: e => set('intent', e.target.value) },
          React.createElement('option', { value: '' }, '—'),
          INTENT_OPTIONS.map(i =>
            React.createElement('option', { key: i, value: i }, i)
          )
        )
      ),

      React.createElement(
        'div',
        { className: 'form-group' },
        React.createElement('label', null, 'Sentimento'),
        React.createElement(
          'select',
          { value: form.sentiment, onChange: e => set('sentiment', e.target.value) },
          SENTIMENT_OPTIONS.map(s =>
            React.createElement('option', { key: s, value: s }, s)
          )
        )
      ),

      React.createElement(
        'div',
        { className: 'form-group full' },
        React.createElement('label', null, 'Resumo (max 100 chars)'),
        React.createElement('textarea', {
          value: form.summary,
          maxLength: 100,
          onChange: e => set('summary', e.target.value),
        })
      ),

      React.createElement(
        'div',
        { className: 'form-group full' },
        React.createElement('label', null, 'Próxima ação (max 80 chars)'),
        React.createElement('textarea', {
          value: form.next_action,
          maxLength: 80,
          onChange: e => set('next_action', e.target.value),
        })
      )
    ),
    React.createElement(
      'div',
      { style: { marginTop: 12 } },
      React.createElement(
        'button',
        { type: 'submit', className: 'btn btn-success', disabled: saving },
        saving ? 'Salvando…' : 'Salvar override manual'
      )
    )
  );
}

// ---------------------------------------------------------------------------
// HistoryList — colapsável
// ---------------------------------------------------------------------------

function HistoryList({ items }) {
  const [open, setOpen] = useState(false);
  if (!items || items.length === 0) {
    return React.createElement('p', { className: 'text-muted', style: { fontSize: 12 } }, 'Sem histórico.');
  }
  return React.createElement(
    'div',
    null,
    React.createElement(
      'button',
      {
        type: 'button',
        className: 'btn btn-secondary btn-sm',
        onClick: () => setOpen(o => !o),
        style: { marginBottom: 8 },
      },
      open ? 'Ocultar histórico' : `Mostrar histórico (${items.length})`
    ),
    open &&
      items.map((h, i) =>
        React.createElement(
          'div',
          { key: i, className: 'history-item' },
          React.createElement(
            'div',
            { className: 'history-meta' },
            `${fmtTs(h.classified_at)} — por ${h.classified_by}`
          ),
          React.createElement('div', null, `Status: ${h.status} | Prioridade: P${h.priority} | Intenção: ${h.intent || '—'} | Sentimento: ${h.sentiment}`),
          h.summary &&
            React.createElement('div', { style: { marginTop: 4, color: '#555' } }, h.summary)
        )
      )
  );
}

// ---------------------------------------------------------------------------
// ConversationDrawer — modal/drawer de detalhe
// ---------------------------------------------------------------------------

function ConversationDrawer({ conversationId, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch(`/conversations/${conversationId}`);
      setDetail(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  function handleSaved(updated) {
    setDetail(d => ({ ...d, classification: updated }));
  }

  // Close on Escape
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = detail ? displayName(detail) : conversationId;
  const messages = detail ? [...(detail.messages || [])].reverse() : [];
  const history = detail ? (detail.classification_history || []) : [];

  return React.createElement(
    'div',
    { className: 'overlay', onClick: e => { if (e.target === e.currentTarget) onClose(); } },
    React.createElement(
      'div',
      { className: 'drawer' },
      React.createElement(
        'div',
        { className: 'drawer-header' },
        React.createElement('h2', null, title),
        React.createElement('button', { className: 'close-btn', onClick: onClose, 'aria-label': 'Fechar' }, '×')
      ),
      React.createElement(
        'div',
        { className: 'drawer-body' },
        error && React.createElement('div', { className: 'error-banner' }, error),
        loading && React.createElement('div', { className: 'loading' }, 'Carregando…'),

        !loading && detail && React.createElement(
          React.Fragment,
          null,

          // --- Mensagens ---
          React.createElement(
            'div',
            null,
            React.createElement('div', { className: 'section-title' }, `Mensagens recentes (${messages.length})`),
            messages.length === 0
              ? React.createElement('p', { className: 'text-muted', style: { fontSize: 12 } }, 'Sem mensagens.')
              : React.createElement(
                  'div',
                  { className: 'msg-list' },
                  messages.map((m, i) =>
                    React.createElement(MessageBubble, { key: m.id || i, msg: m })
                  )
                )
          ),

          // --- Classificação atual ---
          React.createElement(
            'div',
            null,
            React.createElement('div', { className: 'section-title' }, 'Classificação atual'),
            detail.classification
              ? React.createElement(
                  'div',
                  { style: { fontSize: 13, lineHeight: 1.7 } },
                  React.createElement('div', null,
                    React.createElement('strong', null, 'Status: '),
                    React.createElement(StatusBadge, { status: detail.classification.status })
                  ),
                  React.createElement('div', null,
                    React.createElement('strong', null, 'Prioridade: '),
                    React.createElement(PriorityDot, { priority: detail.classification.priority })
                  ),
                  React.createElement('div', null, React.createElement('strong', null, 'Intenção: '), detail.classification.intent || '—'),
                  React.createElement('div', null, React.createElement('strong', null, 'Sentimento: '), detail.classification.sentiment || '—'),
                  React.createElement('div', null, React.createElement('strong', null, 'Classificado por: '), detail.classification.classified_by || '—'),
                  React.createElement('div', null, React.createElement('strong', null, 'Data: '), fmtTs(detail.classification.classified_at)),
                  detail.classification.summary &&
                    React.createElement('div', null, React.createElement('strong', null, 'Resumo: '), detail.classification.summary),
                  detail.classification.next_action &&
                    React.createElement('div', null, React.createElement('strong', null, 'Próxima ação: '), detail.classification.next_action),
                  detail.classification.model_version &&
                    React.createElement('div', null, React.createElement('strong', null, 'Modelo: '), detail.classification.model_version)
                )
              : React.createElement('p', { className: 'text-muted', style: { fontSize: 13 } }, 'Ainda não classificada.')
          ),

          // --- Override manual ---
          React.createElement(
            'div',
            null,
            React.createElement('div', { className: 'section-title' }, 'Override manual'),
            React.createElement(ClassificationForm, {
              conversationId: detail.id,
              current: detail.classification,
              onSaved: handleSaved,
            })
          ),

          // --- Histórico ---
          React.createElement(
            'div',
            null,
            React.createElement('div', { className: 'section-title' }, 'Histórico de classificações'),
            React.createElement(HistoryList, { items: history })
          )
        )
      )
    )
  );
}

// ---------------------------------------------------------------------------
// App — raiz
// ---------------------------------------------------------------------------

function App() {
  const LIMIT = 50;

  const [stats, setStats] = useState(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');

  const [filters, setFilters] = useState({
    status: '',
    priority: '',
    intent: '',
    classified_by: '',
    since_date: '',
  });
  const [offset, setOffset] = useState(0);

  const [convs, setConvs] = useState([]);
  const [convsLoading, setConvsLoading] = useState(false);
  const [convsError, setConvsError] = useState(null);

  const [selectedId, setSelectedId] = useState(null);

  // Reset offset when filters change
  useEffect(() => {
    setOffset(0);
  }, [filters]);

  // Load stats on mount and every 60s
  const loadStats = useCallback(async () => {
    try {
      const data = await apiFetch('/stats/summary');
      setStats(data);
    } catch (err) {
      console.error('Stats error:', err);
    }
  }, []);

  useEffect(() => {
    loadStats();
    const interval = setInterval(loadStats, 60000);
    return () => clearInterval(interval);
  }, [loadStats]);

  // Load conversations when filters or offset change
  const loadConvs = useCallback(async () => {
    setConvsLoading(true);
    setConvsError(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(LIMIT));
      params.set('offset', String(offset));
      if (filters.status)        params.set('status', filters.status);
      if (filters.priority)      params.set('priority', filters.priority);
      if (filters.intent)        params.set('intent', filters.intent);
      if (filters.classified_by) params.set('classified_by', filters.classified_by);
      if (filters.since_date) {
        const ts = new Date(filters.since_date).getTime();
        if (Number.isFinite(ts)) params.set('since', String(ts));
      }
      const data = await apiFetch(`/conversations?${params.toString()}`);
      setConvs(data);
    } catch (err) {
      setConvsError(err.message);
    } finally {
      setConvsLoading(false);
    }
  }, [filters, offset]);

  useEffect(() => {
    loadConvs();
  }, [loadConvs]);

  // Sync trigger
  async function handleSync() {
    setSyncLoading(true);
    setSyncMessage('');
    try {
      const data = await apiFetch('/sync/trigger', { method: 'POST' });
      setSyncMessage(data.message || 'Sync iniciado');
      setTimeout(() => setSyncMessage(''), 5000);
    } catch (err) {
      if (err.status === 409) {
        setSyncMessage('Sync já em andamento');
      } else {
        setSyncMessage(`Erro: ${err.message}`);
      }
      setTimeout(() => setSyncMessage(''), 5000);
    } finally {
      setSyncLoading(false);
    }
  }

  return React.createElement(
    'div',
    { id: 'root' },
    React.createElement(Header, {
      stats,
      onSyncClick: handleSync,
      syncLoading,
      syncMessage,
    }),
    React.createElement(
      'div',
      { className: 'main' },
      React.createElement(Sidebar, { filters, onChange: setFilters }),
      React.createElement(
        'main',
        { className: 'content' },
        React.createElement(ConversationTable, {
          rows: convs,
          onSelect: setSelectedId,
          loading: convsLoading,
          error: convsError,
        }),
        React.createElement(Pagination, {
          offset,
          limit: LIMIT,
          count: convs.length,
          onChange: setOffset,
        })
      )
    ),
    selectedId &&
      React.createElement(ConversationDrawer, {
        conversationId: selectedId,
        onClose: () => setSelectedId(null),
      })
  );
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const container = document.getElementById('root');
const reactRoot = ReactDOM.createRoot(container);
reactRoot.render(React.createElement(App));
