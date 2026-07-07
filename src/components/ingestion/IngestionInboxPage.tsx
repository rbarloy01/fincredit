import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Session } from '../../services/auth';
import {
  AlertCircle,
  Check,
  ExternalLink,
  FileSearch,
  FolderSync,
  Loader2,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';

type ClientOption = {
  id: string;
  name: string;
};

type DocumentRow = {
  id: string;
  client_id: string | null;
  drive_path: string | null;
  source_uri: string | null;
  file_name: string;
  mime_type: string | null;
  document_type: string;
  period: string | null;
  extraction_status: string;
  confidence_score: number | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string | null;
};

type ReviewItem = {
  id: string;
  client_id: string | null;
  document_id: string | null;
  item_type: 'financial_line_item' | 'qualitative_excerpt' | string;
  raw_value: Record<string, any>;
  suggested_value: Record<string, any>;
  status: string;
  confidence_score: number | null;
  created_at: string;
};

type ApiState = {
  sync?: any;
  process?: any;
};

interface Props {
  session: Session;
}

const statusStyles: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  processing: 'bg-blue-50 text-blue-700 border-blue-200',
  done: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  error: 'bg-rose-50 text-rose-700 border-rose-200',
  ready: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-slate-100 text-slate-600 border-slate-200',
};

async function authHeaders() {
  const { data: { session } } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
  };
}

async function postJson(path: string, body: Record<string, any>) {
  const response = await fetch(path, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `Error ${response.status}`);
  return json;
}

function fmtDate(value?: string | null) {
  if (!value) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function fmtNumber(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  return new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 }).format(n);
}

function confidence(value?: number | null) {
  if (value === null || value === undefined) return 'N/D';
  return `${Math.round(Number(value) * 100)}%`;
}

function certaintyLevel(item: ReviewItem): 'high' | 'medium' | 'low' {
  const explicit = item.suggested_value?.certaintyLevel;
  if (explicit === 'high' || explicit === 'medium' || explicit === 'low') return explicit;
  const score = Number(item.confidence_score || 0);
  if (score >= 0.82) return 'high';
  if (score >= 0.58) return 'medium';
  return 'low';
}

function certaintyLabel(level: 'high' | 'medium' | 'low') {
  if (level === 'high') return 'Alta certeza';
  if (level === 'medium') return 'Certeza media';
  return 'Baja certeza';
}

function certaintyClass(level: 'high' | 'medium' | 'low') {
  if (level === 'high') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (level === 'medium') return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-rose-200 bg-rose-50 text-rose-700';
}

function certaintySignals(item: ReviewItem) {
  const suggested = item.suggested_value || {};
  const raw = item.raw_value || {};
  return {
    signals: Array.isArray(suggested.certaintySignals) ? suggested.certaintySignals : Array.isArray(raw.certaintySignals) ? raw.certaintySignals : [],
    warnings: Array.isArray(suggested.certaintyWarnings) ? suggested.certaintyWarnings : Array.isArray(raw.certaintyWarnings) ? raw.certaintyWarnings : [],
  };
}

function badgeClass(status: string) {
  return statusStyles[status] || 'bg-slate-50 text-slate-600 border-slate-200';
}

function itemTitle(item: ReviewItem) {
  const suggested = item.suggested_value || {};
  const raw = item.raw_value || {};
  if (item.item_type === 'financial_line_item') {
    return suggested.accountName || raw.accountName || 'Rubro financiero';
  }
  return suggested.factor || raw.excerpt || 'Factor cualitativo';
}

function itemSubtitle(item: ReviewItem) {
  const suggested = item.suggested_value || {};
  const raw = item.raw_value || {};
  if (item.item_type === 'financial_line_item') {
    return [
      suggested.metric || 'extraAccounts',
      suggested.period || 'sin periodo',
      raw.sheetName || (raw.pageNumber ? `Pagina ${raw.pageNumber}` : ''),
    ].filter(Boolean).join(' | ');
  }
  return [
    suggested.category || 'Por clasificar',
    suggested.riskLevel || 'riesgo desconocido',
  ].join(' | ');
}

const ReviewPreview: React.FC<{
  item: ReviewItem;
  busy: boolean;
  onReview: (item: ReviewItem, action: 'approve' | 'reject') => void;
}> = ({ item, busy, onReview }) => {
  const suggested = item.suggested_value || {};
  const raw = item.raw_value || {};
  const isFinancial = item.item_type === 'financial_line_item';
  const level = certaintyLevel(item);
  const certainty = certaintySignals(item);

  return (
    <div className="border border-slate-200 rounded-lg bg-white p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-black uppercase tracking-widest text-slate-400">
              {isFinancial ? 'Financiero' : 'Cualitativo'}
            </span>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-black uppercase ${badgeClass(item.status)}`}>
              {item.status}
            </span>
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-black uppercase ${certaintyClass(level)}`}>
              <ShieldCheck className="h-3 w-3" />
              {certaintyLabel(level)} · {confidence(item.confidence_score)}
            </span>
          </div>
          <h4 className="mt-1 truncate text-sm font-black text-slate-900">{itemTitle(item)}</h4>
          <p className="mt-0.5 text-xs font-semibold text-slate-500">{itemSubtitle(item)}</p>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <button
            onClick={() => onReview(item, 'approve')}
            disabled={busy || item.status === 'approved'}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-black text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Aprobar
          </button>
          <button
            onClick={() => onReview(item, 'reject')}
            disabled={busy || item.status === 'rejected'}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" />
            Rechazar
          </button>
        </div>
      </div>

      {isFinancial ? (
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <PreviewCell label="Metrica sugerida" value={suggested.metric || 'extraAccounts'} />
          <PreviewCell label="Valor" value={fmtNumber(suggested.value ?? raw.value)} />
          <PreviewCell label="Periodo" value={suggested.period || 'Sin periodo'} />
          <PreviewCell label="Origen" value={raw.sheetName || (raw.pageNumber ? `Pagina ${raw.pageNumber}` : 'Documento')} />
        </div>
      ) : (
        <div className="mt-4 rounded-lg bg-slate-50 p-3">
          <p className="text-xs font-black uppercase tracking-widest text-slate-400">Extracto</p>
          <p className="mt-1 line-clamp-4 text-sm leading-6 text-slate-700">{suggested.assessment || raw.excerpt || 'Sin extracto'}</p>
        </div>
      )}

      {(certainty.signals.length > 0 || certainty.warnings.length > 0) && (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {certainty.signals.length > 0 && (
            <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-emerald-700">Evidencia</p>
              <ul className="mt-2 space-y-1 text-xs font-semibold leading-5 text-emerald-800">
                {certainty.signals.slice(0, 4).map((signal: string, index: number) => (
                  <li key={`${signal}-${index}`}>+ {signal}</li>
                ))}
              </ul>
            </div>
          )}
          {certainty.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-100 bg-amber-50 p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-amber-700">Por verificar</p>
              <ul className="mt-2 space-y-1 text-xs font-semibold leading-5 text-amber-800">
                {certainty.warnings.slice(0, 4).map((warning: string, index: number) => (
                  <li key={`${warning}-${index}`}>! {warning}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const PreviewCell: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="rounded-lg bg-slate-50 p-3">
    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
    <p className="mt-1 truncate text-sm font-black text-slate-800">{value}</p>
  </div>
);

const IngestionInboxPage: React.FC<Props> = ({ session }) => {
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'needs_review' | 'pending' | 'done' | 'error'>('needs_review');
  const [rootFolderId, setRootFolderId] = useState('');
  const [autoCreateClients, setAutoCreateClients] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiState, setApiState] = useState<ApiState>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const clientName = useMemo(() => {
    const map = new Map(clients.map(client => [client.id, client.name]));
    return (clientId?: string | null) => clientId ? map.get(clientId) || 'Cliente sin nombre' : 'Sin cliente asignado';
  }, [clients]);

  const reviewItemsByDocument = useMemo(() => {
    const map = new Map<string, ReviewItem[]>();
    reviewItems.forEach(item => {
      if (!item.document_id) return;
      const list = map.get(item.document_id) || [];
      list.push(item);
      map.set(item.document_id, list);
    });
    return map;
  }, [reviewItems]);

  const groups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return documents
      .filter(doc => {
        const items = reviewItemsByDocument.get(doc.id) || [];
        const pendingItems = items.filter(item => item.status === 'pending' || item.status === 'ready');
        if (statusFilter === 'needs_review' && pendingItems.length === 0) return false;
        if (statusFilter !== 'all' && statusFilter !== 'needs_review' && doc.extraction_status !== statusFilter) return false;
        if (!normalizedQuery) return true;
        return [
          doc.file_name,
          doc.drive_path || '',
          doc.document_type,
          clientName(doc.client_id),
          ...items.map(item => `${itemTitle(item)} ${itemSubtitle(item)}`),
        ].join(' ').toLowerCase().includes(normalizedQuery);
      })
      .reduce<Array<{ clientId: string | null; clientName: string; documents: DocumentRow[] }>>((acc, doc) => {
        const id = doc.client_id || null;
        const existing = acc.find(group => group.clientId === id);
        if (existing) existing.documents.push(doc);
        else acc.push({ clientId: id, clientName: clientName(id), documents: [doc] });
        return acc;
      }, [])
      .sort((a, b) => a.clientName.localeCompare(b.clientName, 'es'));
  }, [clientName, documents, query, reviewItemsByDocument, statusFilter]);

  const totals = useMemo(() => {
    const pendingDocs = documents.filter(doc => doc.extraction_status === 'pending' || doc.extraction_status === 'error').length;
    const pendingItems = reviewItems.filter(item => item.status === 'pending' || item.status === 'ready').length;
    return {
      documents: documents.length,
      pendingDocs,
      pendingItems,
      approved: reviewItems.filter(item => item.status === 'approved').length,
    };
  }, [documents, reviewItems]);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [clientResult, documentResult, itemResult] = await Promise.all([
        supabase.from('clients').select('id,name').order('name'),
        supabase
          .from('documents')
          .select('*')
          .order('updated_at', { ascending: false })
          .limit(250),
        supabase
          .from('extraction_review_items')
          .select('*')
          .in('status', ['pending', 'ready', 'approved', 'rejected'])
          .order('created_at', { ascending: false })
          .limit(1000),
      ]);
      if (clientResult.error) throw clientResult.error;
      if (documentResult.error) throw documentResult.error;
      if (itemResult.error) throw itemResult.error;
      setClients((clientResult.data || []) as ClientOption[]);
      setDocuments((documentResult.data || []) as DocumentRow[]);
      setReviewItems((itemResult.data || []) as ReviewItem[]);
    } catch (err: any) {
      setError(err.message || 'No se pudo cargar la bandeja de ingestion.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const runSync = async () => {
    setApiState(prev => ({ ...prev, sync: { loading: true } }));
    setMessage(null);
    setError(null);
    try {
      const json = await postJson('/api/drive/sync', {
        ...(rootFolderId.trim() ? { rootFolderId: rootFolderId.trim() } : {}),
        autoCreateClients,
      });
      setApiState(prev => ({ ...prev, sync: json }));
      const created = Array.isArray(json.createdClients) ? json.createdClients.length : 0;
      setMessage(`Drive sincronizado: ${json.insertedOrUpdated || 0} documentos actualizados${created ? ` · ${created} acreditados creados` : ''}.`);
      await loadData();
    } catch (err: any) {
      setApiState(prev => ({ ...prev, sync: null }));
      setError(err.message || 'No se pudo sincronizar Drive.');
    }
  };

  const processDocuments = async (documentId?: string) => {
    setApiState(prev => ({ ...prev, process: { loading: true } }));
    setMessage(null);
    setError(null);
    try {
      const json = await postJson('/api/documents/process', documentId ? { documentId } : { limit: 5 });
      setApiState(prev => ({ ...prev, process: json }));
      setMessage(`Procesamiento terminado: ${json.processed || 0} documento(s).`);
      await loadData();
    } catch (err: any) {
      setApiState(prev => ({ ...prev, process: null }));
      setError(err.message || 'No se pudieron procesar documentos.');
      await loadData();
    }
  };

  const reviewItem = async (item: ReviewItem, action: 'approve' | 'reject') => {
    setBusyAction(`${action}:${item.id}`);
    setMessage(null);
    setError(null);
    try {
      await postJson('/api/review-items/approve', {
        reviewItemId: item.id,
        action,
      });
      setMessage(action === 'approve' ? 'Item aprobado y promovido.' : 'Item rechazado.');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'No se pudo actualizar el item.');
    } finally {
      setBusyAction(null);
    }
  };

  if (session.role !== 'manager') {
    return (
      <div className="p-8">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-amber-800">
          <h1 className="text-lg font-black">Acceso restringido</h1>
          <p className="mt-1 text-sm font-semibold">Solo managers pueden usar la bandeja de ingestion.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-slate-50 p-6 lg:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-indigo-600">Manager</p>
            <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-900">Bandeja de ingestion</h1>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-6 text-slate-500">
              Sincroniza Google Drive, procesa archivos pendientes y revisa extracciones antes de incorporarlas al monitoreo.
            </p>
          </div>
          <button
            onClick={loadData}
            disabled={loading}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-black text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
        </header>

        <section className="grid gap-3 md:grid-cols-4">
          <Metric label="Documentos" value={totals.documents} />
          <Metric label="Por procesar" value={totals.pendingDocs} />
          <Metric label="Por revisar" value={totals.pendingItems} emphasis />
          <Metric label="Aprobados" value={totals.approved} />
        </section>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-col gap-3 md:flex-row">
              <label className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                  placeholder="Buscar cliente, documento o item"
                />
              </label>
              <select
                value={statusFilter}
                onChange={event => setStatusFilter(event.target.value as any)}
                className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              >
                <option value="needs_review">Con items por revisar</option>
                <option value="all">Todos</option>
                <option value="pending">Documentos pendientes</option>
                <option value="done">Procesados</option>
                <option value="error">Con error</option>
              </select>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex gap-2">
              <input
                value={rootFolderId}
                onChange={event => setRootFolderId(event.target.value)}
                className="h-10 min-w-0 flex-1 rounded-lg border border-slate-200 px-3 text-sm font-semibold outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                placeholder="Google Drive folder ID opcional"
              />
              <button
                onClick={runSync}
                disabled={apiState.sync?.loading}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 text-sm font-black text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {apiState.sync?.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderSync className="h-4 w-4" />}
                Sync
              </button>
            </div>
            <label className="mt-3 flex items-center gap-2 text-xs font-bold text-slate-600">
              <input
                type="checkbox"
                checked={autoCreateClients}
                onChange={event => setAutoCreateClients(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              Crear acreditados faltantes desde carpetas
            </label>
            <button
              onClick={() => processDocuments()}
              disabled={apiState.process?.loading}
              className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-black text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {apiState.process?.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Procesar pendientes
            </button>
          </div>
        </section>

        {message && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800">
            {message}
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-800">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="flex min-h-[360px] items-center justify-center rounded-xl border border-slate-200 bg-white">
            <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
          </div>
        ) : groups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white py-16 text-center">
            <FileSearch className="mx-auto h-10 w-10 text-slate-300" />
            <h2 className="mt-4 text-lg font-black text-slate-900">No hay items en esta vista</h2>
            <p className="mt-1 text-sm font-medium text-slate-500">Sincroniza Drive o cambia el filtro para ver documentos ya procesados.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map(group => (
              <section key={group.clientId || 'unassigned'} className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-black uppercase tracking-widest text-slate-500">{group.clientName}</h2>
                  <span className="text-xs font-bold text-slate-400">{group.documents.length} documento(s)</span>
                </div>
                <div className="space-y-4">
                  {group.documents.map(doc => {
                    const items = reviewItemsByDocument.get(doc.id) || [];
                    const pendingCount = items.filter(item => item.status === 'pending' || item.status === 'ready').length;
                    return (
                      <article key={doc.id} className="rounded-xl border border-slate-200 bg-white">
                        <div className="border-b border-slate-100 p-4">
                          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className={`rounded-full border px-2 py-0.5 text-[11px] font-black uppercase ${badgeClass(doc.extraction_status)}`}>
                                  {doc.extraction_status}
                                </span>
                                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-black uppercase text-slate-500">
                                  {doc.document_type}
                                </span>
                                {pendingCount > 0 && (
                                  <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-black uppercase text-indigo-700">
                                    {pendingCount} por revisar
                                  </span>
                                )}
                              </div>
                              <h3 className="mt-2 truncate text-lg font-black text-slate-900">{doc.file_name}</h3>
                              <p className="mt-1 truncate text-xs font-semibold text-slate-500">{doc.drive_path || 'Raiz de Drive'} | {doc.period || 'Sin periodo'} | {fmtDate(doc.last_synced_at)}</p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {doc.source_uri && (
                                <a
                                  href={doc.source_uri}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-600 hover:bg-slate-50"
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                  Drive
                                </a>
                              )}
                              <button
                                onClick={() => processDocuments(doc.id)}
                                disabled={apiState.process?.loading || doc.extraction_status === 'processing'}
                                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-xs font-black text-white hover:bg-slate-800 disabled:opacity-50"
                              >
                                <Play className="h-3.5 w-3.5" />
                                Procesar
                              </button>
                            </div>
                          </div>
                        </div>
                        <div className="space-y-3 p-4">
                          {items.length === 0 ? (
                            <p className="rounded-lg bg-slate-50 p-4 text-sm font-semibold text-slate-500">
                              Todavia no hay sugerencias para este documento.
                            </p>
                          ) : (
                            items.map(item => (
                              <ReviewPreview
                                key={item.id}
                                item={item}
                                busy={busyAction === `approve:${item.id}` || busyAction === `reject:${item.id}`}
                                onReview={reviewItem}
                              />
                            ))
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const Metric: React.FC<{ label: string; value: number; emphasis?: boolean }> = ({ label, value, emphasis }) => (
  <div className={`rounded-xl border p-4 ${emphasis ? 'border-indigo-200 bg-indigo-50' : 'border-slate-200 bg-white'}`}>
    <p className={`text-xs font-black uppercase tracking-widest ${emphasis ? 'text-indigo-600' : 'text-slate-400'}`}>{label}</p>
    <p className={`mt-2 text-2xl font-black ${emphasis ? 'text-indigo-900' : 'text-slate-900'}`}>{value}</p>
  </div>
);

export default IngestionInboxPage;
