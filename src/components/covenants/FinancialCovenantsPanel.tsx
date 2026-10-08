import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useClientMonitored } from '../clients/MonitoringContext';
import { db, Covenant_DB, CovenantAnnotation, FinancialStatement_DB, Transaction } from '../../db/index';
import { Session } from '../../services/auth';
import { Plus, ChevronDown, ChevronRight, MessageCircle, Send, TrendingUp, CheckCircle, AlertTriangle, XCircle, X, Trash2, Download, FileText, Star, Clipboard, BarChart3, ArrowDownRight, ArrowUpRight, RefreshCw, Pin } from 'lucide-react';
import type { DefinedConcept } from '../../lib/export';
import { loadExportModule } from '../../lib/exportLoader';
import { accountOptions, buildCovenantAnalystInsight, buildCovenantInsightPrompt, evaluateCovenantAuto, evaluateCovenantForStatement, evaluateFormula, formulaLabel, getMetric, isPercentCovenant, prioritizedLatestCovenantPerformance, rawAccountKey, resolveCovenantThreshold, standardRatioFormula, standardRatios, suggestedCovenants } from '../../lib/financialMetrics';
import { GlobalCovenantTemplate, loadOrgConsolidationRules, loadOrgGlobalCovenantTemplates } from '../../lib/accountConsolidation';
import { matchesFacilityFilter } from '../../lib/facilityHistory';
import { normalizeFinancialNumberString, parseNullableFinancialNumber } from '../../lib/numberParsing';
import CovenantBuilder, { type CovenantBuilderSave } from './CovenantBuilder';
import { thresholdToStore } from '../../lib/covenantBuilder';
import { parseFormulaText } from '../../lib/formulaText';
import { buildFavoriteInsights, buildFavoritesPrompt, explainFormula, favoritesDefaultKey, favoritesSettingKey, indicatorKey, summarizeFavorites, toggleFavorite, type FavoriteInsight } from '../../lib/indicatorInsights';

const FavButton: React.FC<{ active: boolean; onClick: () => void; size?: string }> = ({ active, onClick, size = 'w-4 h-4' }) => (
  <button
    type="button"
    onClick={e => { e.stopPropagation(); onClick(); }}
    title={active ? 'Quitar de mis favoritos' : 'Marcar como favorito: aparece primero en el storyline'}
    aria-pressed={active}
    className={`flex-shrink-0 rounded-lg p-1.5 transition-colors ${active ? 'bg-indigo-100 text-indigo-700' : 'text-slate-300 hover:bg-slate-100 hover:text-indigo-600'}`}
  >
    <Pin className={`${size} ${active ? 'fill-current' : ''}`} />
  </button>
);

const Sparkline: React.FC<{ series: Array<{ period: string; value: number | null }>; className?: string }> = ({ series, className = 'text-indigo-600' }) => {
  const pts = series.map((p, i) => ({ i, v: p.value })).filter((p): p is { i: number; v: number } => p.v !== null);
  if (pts.length < 2) return <span className="text-[10px] font-bold text-slate-300">sin serie</span>;
  const min = Math.min(...pts.map(p => p.v)); const max = Math.max(...pts.map(p => p.v)); const span = max - min || 1;
  const w = 84; const h = 26; const step = series.length > 1 ? w / (series.length - 1) : w;
  const path = pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'}${(p.i * step).toFixed(1)},${(h - 3 - ((p.v - min) / span) * (h - 6)).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={className} aria-label="Tendencia de los últimos cortes">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last.i * step} cy={h - 3 - ((last.v - min) / span) * (h - 6)} r="2.6" fill="currentColor" />
    </svg>
  );
};

const SEVERITY_STYLE: Record<FavoriteInsight['severity'], { label: string; chip: string; spark: string }> = {
  critico: { label: 'Crítico', chip: 'bg-rose-50 text-rose-700 border-rose-200', spark: 'text-rose-600' },
  atencion: { label: 'Atención', chip: 'bg-amber-50 text-amber-800 border-amber-200', spark: 'text-amber-600' },
  sin_dato: { label: 'Sin dato', chip: 'bg-slate-100 text-slate-600 border-slate-200', spark: 'text-slate-400' },
  ok: { label: 'En rango', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', spark: 'text-emerald-600' },
};

const nanoid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

interface Props {
  clientId: string;
  clientName?: string;
  transactions?: Transaction[];
  session: Session;
  statements: FinancialStatement_DB[];
  onCovenantsChange: (covenants: Covenant_DB[]) => void;
}

const StatusBadge: React.FC<{ status: 'cumple' | 'alerta' | 'incumple' }> = ({ status }) => {
  const monitored = useClientMonitored();
  if (!monitored) {
    return <span className="flex items-center gap-1 text-xs font-black px-2.5 py-1 rounded-full border bg-slate-100 text-slate-500 border-slate-200">SIN MONITOREO</span>;
  }
  const map = {
    cumple: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    alerta: 'bg-amber-100 text-amber-800 border-amber-200',
    incumple: 'bg-rose-100 text-rose-800 border-rose-200',
  };
  const icons = {
    cumple: <CheckCircle className="w-3 h-3" />,
    alerta: <AlertTriangle className="w-3 h-3" />,
    incumple: <XCircle className="w-3 h-3" />,
  };
  return (
    <span className={`flex items-center gap-1 text-xs font-black px-2.5 py-1 rounded-full border ${map[status]}`}>
      {icons[status]}{status.toUpperCase()}
    </span>
  );
};

interface FormData {
  name: string;
  formula: string;
  threshold: string;
  operator: 'gt' | 'lt' | 'gte' | 'lte' | 'none';
  description: string;
  numerator: string;
  denominator: string;
  expressionTokens: string[];
  selectedRef: string;
  numberValue: string;
  chatPrompt: string;
  chatResult: string;
  transactionId: string;
}

const EMPTY: FormData = { name: '', formula: '', threshold: '', operator: 'lte', description: '', numerator: '', denominator: '', expressionTokens: [], selectedRef: '', numberValue: '', chatPrompt: '', chatResult: '', transactionId: '' };

const inputClass = 'bg-slate-50 border border-slate-200 text-slate-900 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-all w-full';
const formulaBarClass = 'min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 shadow-inner';
const formulaToolButtonClass = 'h-9 min-w-9 rounded-md border border-slate-300 bg-white px-3 text-xs font-black text-slate-700 hover:bg-slate-50';
const clean = (v: string) => v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const LOCAL_NOTES_KEY = 'finmonitor_pending_covenant_notes';
const hiddenStandardKey = (clientId: string) => `finmonitor_hidden_standard_covs_${clientId}`;
const contractCovenantsKey = (clientId: string) => `finmonitor_contract_covs_${clientId}`;
type CovenantMeasurementFrequency = 'mensual' | 'trimestral' | 'semestral' | 'anual';
type CovenantDisplayMode = 'auto' | 'number' | 'percent';
interface CovenantMeasurementConfig {
  frequency: CovenantMeasurementFrequency;
  startPeriod: string;
  displayMode?: CovenantDisplayMode;
  decimals?: number;
}
type CovenantMeasurementConfigMap = Record<string, CovenantMeasurementConfig>;
const covenantMeasurementKey = (clientId: string) => `finmonitor_covenant_measurement_${clientId}`;
const frequencyLabels: Record<CovenantMeasurementFrequency, string> = {
  mensual: 'Mensual',
  trimestral: 'Trimestral',
  semestral: 'Semestral',
  anual: 'Anual',
};

const operatorLabel = (operator: Covenant_DB['operator']) => (
  operator === 'gte' ? '>=' :
  operator === 'gt' ? '>' :
  operator === 'lte' ? '<=' :
  operator === 'lt' ? '<' :
  'N/A'
);

const formatCovenantValue = (value: number | null, cov: Covenant_DB, config?: Partial<CovenantMeasurementConfig>) => {
  if (value === null || !Number.isFinite(value)) return '0';
  const mode = config?.displayMode || 'auto';
  const shouldShowPercent = mode === 'percent' || (mode === 'auto' && isPercentCovenant(cov) && Math.abs(value) <= 3);
  const fallbackDecimals = shouldShowPercent ? 1 : 2;
  const decimals = Math.max(0, Math.min(6, Number.isFinite(config?.decimals) ? Number(config?.decimals) : fallbackDecimals));
  const displayValue = shouldShowPercent ? value * 100 : value;
  const formatted = displayValue.toLocaleString('es-MX', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return shouldShowPercent ? `${formatted}%` : formatted;
};

const requirementLabel = (cov: Covenant_DB, config?: Partial<CovenantMeasurementConfig>) => {
  if (cov.operator === 'none' || !cov.threshold) return 'Sin umbral';
  const threshold = resolveCovenantThreshold(cov);
  return `${operatorLabel(cov.operator)} ${threshold === null ? cov.threshold : formatCovenantValue(threshold, cov, config)}`;
};

const distanceToLimit = (value: number | null, cov: Covenant_DB) => {
  const threshold = resolveCovenantThreshold(cov);
  if (value === null || threshold === null || cov.operator === 'none') return null;
  if (cov.operator === 'lte' || cov.operator === 'lt') return threshold - value;
  if (cov.operator === 'gte' || cov.operator === 'gt') return value - threshold;
  return null;
};

const riskToneFromDistance = (distance: number | null, status: 'cumple' | 'alerta' | 'incumple') => {
  if (status === 'incumple') return 'Breach';
  if (distance === null) return 'Sin límite';
  if (status === 'alerta' || distance <= 0) return 'Presión alta';
  return 'Con holgura';
};

const deltaDirectionLabel = (delta: number | null) => {
  if (delta === null) return 'Sin comparativo';
  if (Math.abs(delta) < 0.000001) return 'Sin cambio';
  return delta > 0 ? 'Subió' : 'Bajó';
};

const periodStatusClass = (status: 'cumple' | 'alerta' | 'incumple') => {
  if (status === 'incumple') return 'bg-rose-600 text-white border-rose-700';
  if (status === 'alerta') return 'bg-amber-400 text-amber-950 border-amber-500';
  return 'bg-emerald-600 text-white border-emerald-700';
};

function loadLocalNotes(): Record<string, CovenantAnnotation[]> {
  try { return JSON.parse(localStorage.getItem(LOCAL_NOTES_KEY) || '{}'); } catch { return {}; }
}

function saveLocalNote(covenantId: string, note: CovenantAnnotation) {
  const all = loadLocalNotes();
  all[covenantId] = [...(all[covenantId] || []), note];
  localStorage.setItem(LOCAL_NOTES_KEY, JSON.stringify(all));
}

const FinancialCovenantsPanel: React.FC<Props> = ({ clientId, clientName = '', transactions = [], session, statements, onCovenantsChange }) => {
  const monitored = useClientMonitored();
  const [covenants, setCovenants] = useState<Covenant_DB[]>([]);
  const [annotations, setAnnotations] = useState<Record<string, CovenantAnnotation[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormData>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [noteText, setNoteText] = useState<Record<string, string>>({});
  const [sendingNote, setSendingNote] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'excel' | 'pdf' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string>('');
  const [formulaDrafts, setFormulaDrafts] = useState<Record<string, string[]>>({});
  const [limitDrafts, setLimitDrafts] = useState<Record<string, { operator: Covenant_DB['operator']; threshold: string }>>({});
  const [chatDrafts, setChatDrafts] = useState<Record<string, { prompt: string; result: string }>>({});
  const [promptCopied, setPromptCopied] = useState(false);
  const [concepts, setConcepts] = useState<DefinedConcept[]>([]);
  const [globalTemplates, setGlobalTemplates] = useState<GlobalCovenantTemplate[]>([]);
  const [contractCovenants, setContractCovenants] = useState<string[]>([]);
  const [hiddenStandard, setHiddenStandard] = useState<string[]>([]);
  const [measurementConfig, setMeasurementConfig] = useState<CovenantMeasurementConfigMap>({});
  const [facilityFilter, setFacilityFilter] = useState<'all' | 'general' | string>('all');
  const [favorites, setFavorites] = useState<string[]>([]);
  const [fmap, setFmap] = useState({ open: false, query: '', onlyFav: false, onlyIssues: false });
  const notesEndRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const orderedStatements = useMemo(
    () => [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate)),
    [statements],
  );
  const statementsFingerprint = useMemo(
    () => orderedStatements
      .map(stmt => `${stmt.id}:${stmt.period}:${stmt.periodDate}:${stmt.rawLineItems.length}:${stmt.rawLineItems.map(item => `${item.name}:${item.value}:${item.statementType || ''}`).join('|')}`)
      .join('||'),
    [orderedStatements],
  );


  // Favorites belong to the analyst: stored per user, with the last choice as default for clients where none was set yet.
  useEffect(() => {
    let active = true;
    (async () => {
      const stored = await db.getClientSetting<string[] | null>(clientId, favoritesSettingKey(session.userId), null);
      let favs: string[] | null = Array.isArray(stored) ? stored : null;
      if (!favs) {
        try { const d = JSON.parse(localStorage.getItem(favoritesDefaultKey(session.userId)) || 'null'); if (Array.isArray(d)) favs = d; } catch { /* no default yet */ }
      }
      if (!favs) {
        // Another device, or the choice made in the onboarding tour: the analyst's default is saved with the organization.
        const org = await db.getOrgSetting<string[] | null>(session.userId, favoritesDefaultKey(session.userId), null).catch(() => null);
        if (Array.isArray(org)) favs = org;
      }
      if (active) setFavorites(favs || []);
    })().catch(() => undefined);
    return () => { active = false; };
  }, [clientId, session.userId]);

  const toggleFav = (cov: Covenant_DB) => {
    const next = toggleFavorite(favorites, indicatorKey(cov));
    setFavorites(next);
    void db.setClientSetting(clientId, favoritesSettingKey(session.userId), next);
    try { localStorage.setItem(favoritesDefaultKey(session.userId), JSON.stringify(next)); } catch { /* storage blocked */ }
    void db.setOrgSetting(session.userId, favoritesDefaultKey(session.userId), next);
  };
  const isFav = (cov: Covenant_DB) => favorites.includes(indicatorKey(cov));

  const loadData = async () => {
    await loadOrgConsolidationRules(session.userId);
    const hidden = await db.getClientSetting<string[]>(clientId, hiddenStandardKey(clientId), []);
    setHiddenStandard(hidden);
    let all = await db.getCovenants(clientId);
    let financial = all.filter(c => c.type === 'financial');
    const latest = orderedStatements.at(-1);
    if (latest) {
      const missingStandard = standardRatios(latest)
        .filter(r => !['revenue', 'ebitda'].includes(r.key))
        .filter(r => !hidden.includes(standardRatioFormula(r.key)))
        .filter(r => !financial.some(c => c.formula === standardRatioFormula(r.key) || clean(c.name) === clean(r.label)));
      for (const ratio of missingStandard) {
        await db.createCovenant({
          clientId,
          name: ratio.label,
          type: 'financial',
          formula: standardRatioFormula(ratio.key),
          threshold: '',
          operator: 'none',
          description: ratio.formula,
          isCustom: false,
        });
      }
      if (missingStandard.length > 0) {
        all = await db.getCovenants(clientId);
        financial = all.filter(c => c.type === 'financial');
      }
    }
    setCovenants(financial);
    onCovenantsChange(all);
    const annMap: Record<string, CovenantAnnotation[]> = {};
    const localNotes = loadLocalNotes();
    for (const cov of financial) {
      const remote = await db.getAnnotations(cov.id);
      annMap[cov.id] = [...remote, ...(localNotes[cov.id] || [])];
    }
    setAnnotations(annMap);
  };

  const flashNotice = (message: string) => {
    setActionNotice(message);
    window.setTimeout(() => setActionNotice(''), 2200);
  };

  const refreshData = async () => {
    setRefreshing(true);
    try {
      await loadData();
      flashNotice('Datos recalculados');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => { loadData(); }, [clientId, statementsFingerprint]);
  useEffect(() => {
    db.getClientSetting<DefinedConcept[]>(clientId, `finmonitor_defined_concepts_${clientId}`, []).then(setConcepts);
  }, [clientId]);
  useEffect(() => {
    db.getClientSetting<string[]>(clientId, contractCovenantsKey(clientId), []).then(setContractCovenants);
  }, [clientId]);
  useEffect(() => {
    db.getClientSetting<CovenantMeasurementConfigMap>(clientId, covenantMeasurementKey(clientId), {}).then(setMeasurementConfig);
  }, [clientId]);
  useEffect(() => {
    let cancelled = false;
    loadOrgGlobalCovenantTemplates(session.userId).then(templates => {
      if (!cancelled) setGlobalTemplates(templates);
    });
    return () => { cancelled = true; };
  }, [session.userId, clientId, statementsFingerprint]);

  useEffect(() => {
    if (expanded && notesEndRef.current) notesEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [expanded, annotations]);

  const handleBuilderSave = async (payload: CovenantBuilderSave) => {
    setSaving(true);
    try {
      const created = await db.createCovenant({
        clientId, transactionId: payload.transactionId || undefined, name: payload.name.trim(), type: 'financial', formula: payload.formula,
        threshold: payload.kind === 'none' ? '' : thresholdToStore(payload.limit, payload.unit), operator: payload.kind,
        description: (payload.description || '').trim(), isCustom: true,
      });
      // the unit the analyst picked decides how the covenant is displayed, instead of being guessed from its name
      const nextConfig = { ...measurementConfig, [created.id]: { frequency: 'mensual' as const, startPeriod: '', displayMode: (payload.unit === 'percent' ? 'percent' : 'number') as CovenantDisplayMode } };
      setMeasurementConfig(nextConfig);
      await db.setClientSetting(clientId, covenantMeasurementKey(clientId), nextConfig);
      if (payload.isContract) persistContractCovenants([...contractCovenants, ...contractKeysFor(created)]);
      setForm(EMPTY);
      setShowForm(false);
      await loadData();
      flashNotice(`Covenant «${created.name}» creado`);
    } catch (err: any) { alert(err.message); }
    finally { setSaving(false); }
  };

  const setManualStatus = async (cov: Covenant_DB, status: 'cumple' | 'alerta' | 'incumple' | 'auto') => {
    if (!monitored && status !== 'auto' && status !== 'cumple') { alert('Cliente sin monitoreo: no se puede marcar incumplimiento ni alerta.'); return; }
    setSavingAction(`${cov.id}:status`);
    try {
      const real = await materialize(cov as Covenant_DB & { virtual?: boolean });
      const complianceStatus = status === 'auto' ? '' : `manual:${status}`;
      await db.updateCovenant(real.id, { complianceStatus });
      setCovenants(prev => {
        const exists = prev.some(item => item.id === real.id);
        return exists
          ? prev.map(item => item.id === real.id ? { ...item, complianceStatus } : item)
          : [...prev, { ...real, complianceStatus }];
      });
      flashNotice(status === 'auto' ? 'Modo automatico activado' : `Modo manual: ${status}`);
      await loadData();
    } finally {
      setSavingAction(null);
    }
  };

  const latestPeriod = orderedStatements.at(-1)?.period || '';
  const latestStatement = orderedStatements.at(-1);
  const transactionName = (transactionId?: string) => transactions.find(tx => tx.id === transactionId)?.name || '';

  const toggleExpanded = (cov: Covenant_DB) => {
    const next = expanded === cov.id ? null : cov.id;
    setExpanded(next);
    if (next && !formulaDrafts[cov.id]?.length) {
      setFormulaDrafts(prev => ({
        ...prev,
        [cov.id]: tokensFromFormula(cov.formulaByPeriod?.[latestPeriod] || cov.formula),
      }));
    }
  };

  const tokensFromFormula = (formula?: string): string[] => {
    if (!formula) return [];
    if (formula.startsWith('expr:')) {
      try { return JSON.parse(formula.slice('expr:'.length)) as string[]; } catch { return []; }
    }
    if (formula.startsWith('ratio:')) {
      const [num, den] = formula.slice('ratio:'.length).split('/');
      return num && den ? [`ref:${num}`, '/', `ref:${den}`] : [];
    }
    return [];
  };

  const refsFromFormula = (formula?: string): string[] => {
    if (!formula) return [];
    if (formula.startsWith('expr:')) {
      try {
        return Array.from(new Set((JSON.parse(formula.slice('expr:'.length)) as string[])
          .filter(token => token.startsWith('ref:'))
          .map(token => token.slice(4))));
      } catch {
        return [];
      }
    }
    if (formula.startsWith('ratio:')) {
      const [num, den] = formula.slice('ratio:'.length).split('/');
      return [num, den].filter(Boolean);
    }
    const low = formula.toLowerCase();
    if (low.includes('deuda') && low.includes('ebitda')) return ['totalDebt', 'ebitda'];
    if (low.includes('dscr') || (low.includes('ebitda') && low.includes('interes'))) return ['ebitda', 'interestExpense'];
    if (low.includes('corriente')) return ['currentAssets', 'currentLiabilities'];
    if (low.includes('liquidez inmediata')) return ['cash', 'availableInvestments', 'currentLiabilities'];
    if (low.includes('roa')) return ['netIncome', 'totalAssets'];
    if (low.includes('roe')) return ['netIncome', 'equity'];
    if (low.includes('apalanc')) return ['banksFundsShortTerm', 'banksFundsLongTerm', 'totalAssets'];
    if (low.includes('capital')) return ['totalDebt', 'equity'];
    return [];
  };

  const tokenLabel = (token: string) => {
    if (token.startsWith('ref:')) return labelMap[token.slice(4)] || token.slice(4);
    if (token.startsWith('num:')) return token.slice(4);
    return token;
  };

  const saveFormula = async (cov: Covenant_DB, scope: 'global' | 'period') => {
    const tokens = formulaDrafts[cov.id] || [];
    if (tokens.length === 0) return;
    setSavingAction(`${cov.id}:formula:${scope}`);
    try {
      const real = await materialize(cov as Covenant_DB & { virtual?: boolean });
      const formula = `expr:${JSON.stringify(tokens)}`;
      const updates: Partial<Covenant_DB> = scope === 'global'
        ? { formula }
        : latestPeriod
          ? { formulaByPeriod: { ...(real.formulaByPeriod || {}), [latestPeriod]: formula } }
          : {};
      if (Object.keys(updates).length === 0) return;
      await db.updateCovenant(real.id, updates);
      setCovenants(prev => {
        const exists = prev.some(item => item.id === real.id);
        return exists
          ? prev.map(item => item.id === real.id ? { ...item, ...updates } : item)
          : [...prev, { ...real, ...updates }];
      });
      flashNotice(scope === 'global' ? 'Formula global guardada' : `Formula guardada para ${latestPeriod}`);
      await loadData();
    } finally {
      setSavingAction(null);
    }
  };

  const clearPeriodFormula = async (cov: Covenant_DB) => {
    if (!latestPeriod) return;
    setSavingAction(`${cov.id}:clear-period`);
    const next = { ...(cov.formulaByPeriod || {}) };
    delete next[latestPeriod];
    try {
      await db.updateCovenant(cov.id, { formulaByPeriod: next });
      setCovenants(prev => {
        return prev.map(item => item.id === cov.id ? { ...item, formulaByPeriod: next } : item);
      });
      flashNotice(`Override de ${latestPeriod} removido`);
      await loadData();
    } finally {
      setSavingAction(null);
    }
  };

  const saveTransactionLink = async (cov: Covenant_DB, transactionId: string) => {
    await db.updateCovenant(cov.id, { transactionId: transactionId || null } as Partial<Covenant_DB>);
    await loadData();
  };

  const {
    options, standardVirtuals, allDisplayCovenants, displayCovenants, covenantRows,
    breachedCount, warningCount, calculatedCount, latestPerformance, analystInsight,
    latestInsightPrompt, deteriorationCount, bettermentCount, noDataPerformanceCount,
    covenantById, storylineRows, suggestions, globalSuggestions, mappedOptions, labelMap,
    performanceById,
  } = useMemo(() => {
    const options = accountOptions(orderedStatements);
    const standardVirtuals = latestStatement
      ? standardRatios(latestStatement)
        .filter(r => !['revenue', 'ebitda'].includes(r.key))
        .filter(r => !hiddenStandard.includes(standardRatioFormula(r.key)))
        .map(r => {
          const formula = standardRatioFormula(r.key);
          const existing = covenants.find(c => c.formula === formula || clean(c.name) === clean(r.label));
          return existing || ({
            id: `virtual:${r.key}`,
            clientId,
            name: r.label,
            type: 'financial',
            formula,
            threshold: '',
            operator: 'none',
            description: r.formula,
            complianceStatus: '',
            formulaByPeriod: {},
            isCustom: false,
            createdAt: '',
            virtual: true,
          } as Covenant_DB & { virtual: true });
        })
      : [];
    const allDisplayCovenants = [
      ...standardVirtuals,
      ...covenants.filter(c => !standardVirtuals.some(s => s.id === c.id || s.formula === c.formula || clean(s.name) === clean(c.name))),
    ];
    const displayCovenants = allDisplayCovenants.filter(cov => {
      if (facilityFilter === 'all') return true;
      if (facilityFilter === 'general') return !cov.transactionId;
      return matchesFacilityFilter(cov, facilityFilter, transactions.length);
    });
    const covenantRows = displayCovenants.map(cov => ({ cov, ...evaluateCovenantAuto(cov, orderedStatements) }));
    const breachedCount = monitored ? covenantRows.filter(r => r.status === 'incumple').length : 0;
    const warningCount = monitored ? covenantRows.filter(r => r.status === 'alerta').length : 0;
    const calculatedCount = covenantRows.filter(r => r.value !== null).length;
    const latestPerformance = prioritizedLatestCovenantPerformance(displayCovenants, orderedStatements, contractCovenants);
    const performanceById = new Map(latestPerformance.map(row => [row.covenantId, row]));
    const analystInsight = buildCovenantAnalystInsight(latestPerformance);
    const latestInsightPrompt = buildCovenantInsightPrompt(clientName, latestPerformance);
    const deteriorationCount = latestPerformance.filter(r => r.movement === 'deterioration').length;
    const bettermentCount = latestPerformance.filter(r => r.movement === 'betterment').length;
    const noDataPerformanceCount = latestPerformance.filter(r => r.movement === 'insufficient').length;
    const covenantById = new Map(displayCovenants.map(cov => [cov.id, cov]));
    // Storyline = the analyst's favorites (always, pinned first) + the highest-priority movements to fill up to 6.
    const storylineAll = latestPerformance
      .map(row => ({ row, cov: covenantById.get(row.covenantId) }))
      .filter((item): item is { row: typeof latestPerformance[number]; cov: Covenant_DB } => !!item.cov);
    const favRows = storylineAll.filter(item => favorites.includes(indicatorKey(item.cov)));
    const otherRows = storylineAll.filter(item => !favorites.includes(indicatorKey(item.cov)));
    const storylineRows = [...favRows, ...otherRows.slice(0, Math.max(3, 6 - favRows.length))];
    const suggestions = suggestedCovenants(orderedStatements).filter(s => !allDisplayCovenants.some(c => clean(c.name) === clean(s.name)));
    const globalSuggestions = globalTemplates
      .filter(t => t.active)
      .filter(t => !allDisplayCovenants.some(c => clean(c.name) === clean(t.name) || (t.formula && c.formula === t.formula)));
    const mappedOptions = [
      { key: 'revenue', label: 'Mapped: Ingresos' },
      { key: 'ebitda', label: 'Mapped: EBITDA' },
      { key: 'totalDebt', label: 'Mapped: Deuda Total' },
      { key: 'interestExpense', label: 'Mapped: Intereses' },
      { key: 'currentAssets', label: 'Mapped: Activo Corriente' },
      { key: 'currentLiabilities', label: 'Mapped: Pasivo Corriente' },
      { key: 'netIncome', label: 'Mapped: Utilidad Neta' },
      { key: 'equity', label: 'Mapped: Capital' },
      { key: 'totalAssets', label: 'Mapped: Activos Totales' },
      ...concepts.map(c => ({ key: `concept:${c.id}`, label: `Concepto: ${c.name}` })),
    ];
    const labelMap = Object.fromEntries([...mappedOptions, ...options.map(o => ({ key: `account:${o.key}`, label: o.label }))].map(o => [o.key, o.label]));
    return {
      options, standardVirtuals, allDisplayCovenants, displayCovenants, covenantRows,
      breachedCount, warningCount, calculatedCount, latestPerformance, analystInsight,
      latestInsightPrompt, deteriorationCount, bettermentCount, noDataPerformanceCount,
      covenantById, storylineRows, suggestions, globalSuggestions, mappedOptions, labelMap,
      performanceById,
    };
  }, [orderedStatements, latestStatement, hiddenStandard, covenants, clientId, facilityFilter, transactions, contractCovenants, clientName, globalTemplates, concepts, monitored, favorites]);
  const formatConfigFor = (cov: Covenant_DB) => measurementConfig[cov.id] || {};
  const fmtCov = (value: number | null, cov: Covenant_DB) => formatCovenantValue(value, cov, formatConfigFor(cov));
  const reqLabel = (cov: Covenant_DB) => requirementLabel(cov, formatConfigFor(cov));
  const favoriteInsights = useMemo(
    () => buildFavoriteInsights(allDisplayCovenants, orderedStatements, favorites, (value, cov) => formatCovenantValue(value, cov, measurementConfig[cov.id] || {}), monitored),
    [allDisplayCovenants, orderedStatements, favorites, measurementConfig, monitored],
  );
  const favoriteSummary = useMemo(() => summarizeFavorites(favoriteInsights, session.userName || 'El analista'), [favoriteInsights, session.userName]);
  const favoriteInsightById = useMemo(() => new Map(favoriteInsights.map(i => [i.covenantId, i])), [favoriteInsights]);
  const mapLabels = useMemo(() => Object.fromEntries(Object.entries(labelMap).map(([k, v]) => [k, String(v).replace(/^Mapped:\s*/, '')])), [labelMap]);
  const mapRows = useMemo(
    () => allDisplayCovenants.filter(c => c.type === 'financial').map(cov => ({
      cov,
      explain: explainFormula(cov, latestStatement, mapLabels),
      shown: latestStatement ? evaluateCovenantForStatement(cov, latestStatement, orderedStatements) : null,
    })),
    [allDisplayCovenants, latestStatement, orderedStatements, mapLabels],
  );
  const contractKeysFor = (cov: Covenant_DB) => [cov.id, cov.formula ? `formula:${cov.formula}` : '', `name:${clean(cov.name)}`].filter(Boolean);
  const isContractCovenant = (cov: Covenant_DB) => contractKeysFor(cov).some(key => contractCovenants.includes(key));
  const handleExport = async (format: 'excel' | 'pdf') => {
    setExporting(format);
    try {
      const { exportCovenantsFinancieros } = await loadExportModule();
      await exportCovenantsFinancieros(displayCovenants, orderedStatements, clientName, format, format === 'pdf' ? panelRef.current ?? undefined : undefined, contractCovenants, transactions);
    } finally {
      setExporting(null);
    }
  };
  const persistContractCovenants = (keys: string[]) => {
    const unique = Array.from(new Set(keys));
    setContractCovenants(unique);
    void db.setClientSetting(clientId, contractCovenantsKey(clientId), unique);
  };
  const persistHiddenStandard = (keys: string[]) => {
    const unique = Array.from(new Set(keys));
    setHiddenStandard(unique);
    void db.setClientSetting(clientId, hiddenStandardKey(clientId), unique);
  };
  const parsePromptToTokens = (prompt: string): { tokens: string[]; missing: string[] } => parseFormulaText(prompt, [
    ...mappedOptions.map(o => ({ key: o.key, label: o.label.replace('Mapped: ', '') })),
    ...options.map(o => ({ key: `account:${o.key}`, label: o.label })),
  ], parseNullableFinancialNumber);

  const handleDelete = async (cov: Covenant_DB & { virtual?: boolean }) => {
    if (!confirm('¿Eliminar este covenant financiero?')) return;
    if (cov.virtual) {
      persistHiddenStandard([...hiddenStandard, cov.formula]);
    } else {
      await db.deleteCovenant(cov.id);
      if (!cov.isCustom) {
        persistHiddenStandard([...hiddenStandard, cov.formula]);
      }
    }
    await loadData();
  };

  const addSuggestion = async (suggestion: ReturnType<typeof suggestedCovenants>[number]) => {
    await db.createCovenant({
      clientId,
      name: suggestion.name,
      type: 'financial',
      formula: suggestion.formula,
      threshold: '',
      operator: 'none',
      description: suggestion.description,
      isCustom: true,
    });
    await loadData();
  };

  const addGlobalTemplate = async (template: GlobalCovenantTemplate) => {
    await db.createCovenant({
      clientId,
      name: template.name,
      type: 'financial',
      formula: template.formula,
      threshold: template.threshold || '',
      operator: template.operator || 'none',
      description: template.description || 'Plantilla global de covenant.',
      isCustom: true,
    });
    await loadData();
  };

  const materialize = async (cov: Covenant_DB & { virtual?: boolean }) => {
    if (!cov.virtual) return cov;
    return db.createCovenant({
      clientId,
      name: cov.name,
      type: 'financial',
      formula: cov.formula,
      threshold: cov.threshold,
      operator: cov.operator,
      description: cov.description,
      isCustom: false,
    });
  };

  const saveMeasurementConfig = async (
    cov: Covenant_DB & { virtual?: boolean },
    updates: Partial<CovenantMeasurementConfig>,
  ) => {
    const real = await materialize(cov);
    const current = measurementConfig[real.id] || { frequency: 'mensual' as const, startPeriod: '' };
    const nextConfig = {
      ...measurementConfig,
      [real.id]: { ...current, ...updates },
    };
    setMeasurementConfig(nextConfig);
    await db.setClientSetting(clientId, covenantMeasurementKey(clientId), nextConfig);
    if (cov.virtual) await loadData();
  };

  const toggleContractCovenant = async (cov: Covenant_DB & { virtual?: boolean }) => {
    const active = isContractCovenant(cov);
    const real = active ? cov : await materialize(cov);
    const keys = contractKeysFor(real);
    const next = active
      ? contractCovenants.filter(key => !keys.includes(key) && key !== `formula:${cov.formula}` && key !== `name:${clean(cov.name)}`)
      : [...contractCovenants, ...keys];
    persistContractCovenants(next);
    if (cov.virtual) await loadData();
  };

  const saveLimit = async (cov: Covenant_DB & { virtual?: boolean }) => {
    const draft = limitDrafts[cov.id] || { operator: cov.operator, threshold: cov.threshold };
    setSavingAction(`${cov.id}:limit`);
    try {
      const real = await materialize(cov);
      const updates = { operator: draft.operator, threshold: normalizeFinancialNumberString(draft.threshold) };
      await db.updateCovenant(real.id, updates);
      setCovenants(prev => {
        const exists = prev.some(item => item.id === real.id);
        return exists
          ? prev.map(item => item.id === real.id ? { ...item, ...updates } : item)
          : [...prev, { ...real, ...updates }];
      });
      flashNotice('Umbral guardado y recalculado');
      await loadData();
    } finally {
      setSavingAction(null);
    }
  };

  const chatBuildForCovenant = (cov: Covenant_DB) => {
    const draft = chatDrafts[cov.id] || { prompt: '', result: '' };
    const { tokens, missing } = parsePromptToTokens(draft.prompt);
    if (missing.length > 0 || tokens.length === 0) {
      setChatDrafts(p => ({ ...p, [cov.id]: { ...draft, result: `No encontré: ${missing.join(', ') || 'cuentas válidas'}.` } }));
      return;
    }
    setFormulaDrafts(p => ({ ...p, [cov.id]: tokens }));
    setChatDrafts(p => ({ ...p, [cov.id]: { ...draft, result: 'Fórmula creada. Revísala y guarda.' } }));
  };

  const handleSendNote = async (cov: Covenant_DB & { virtual?: boolean }) => {
    const text = noteText[cov.id]?.trim();
    if (!text) return;
    setSendingNote(cov.id);
    try {
      const real = await materialize(cov);
      const pendingNote: CovenantAnnotation = {
        id: `pending:${Date.now()}`,
        covenantId: real.id,
        userId: session.userId,
        userName: session.userName,
        text,
        createdAt: new Date().toISOString(),
      };
      let note = pendingNote;
      try {
        note = await db.addAnnotation({ covenantId: real.id, userId: session.userId, userName: session.userName, text });
      } catch {
        saveLocalNote(real.id, pendingNote);
      }
      setNoteText(prev => ({ ...prev, [cov.id]: '', [real.id]: '' }));
      setAnnotations(prev => ({ ...prev, [real.id]: [...(prev[real.id] || []), note], [cov.id]: [...(prev[cov.id] || []), note] }));
      if (real.id !== cov.id) await loadData();
    } catch (err: any) { alert(err.message); }
    finally { setSendingNote(null); }
  };

  const copyInsightPrompt = async () => {
    try {
      await navigator.clipboard.writeText(latestInsightPrompt + buildFavoritesPrompt(clientName, session.userName || 'el analista', favoriteInsights));
      setPromptCopied(true);
      window.setTimeout(() => setPromptCopied(false), 1800);
    } catch {
      setPromptCopied(false);
      alert('No se pudo copiar el prompt. Copia el texto manualmente desde la caja.');
    }
  };

  return (
    <div ref={panelRef} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-black text-slate-900">Indicadores Financieros</h2>
          <p className="text-slate-500 text-sm mt-0.5">{displayCovenants.length} de {allDisplayCovenants.length} covenant{allDisplayCovenants.length !== 1 ? 's' : ''} · métricas medidas contra estados financieros</p>
          {actionNotice && <p className="text-xs font-black text-emerald-700 mt-1">{actionNotice}</p>}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refreshData}
            disabled={refreshing}
            className="flex items-center gap-1.5 bg-white border border-slate-200 text-slate-600 font-bold px-3 py-2 rounded-xl text-xs hover:bg-slate-50 disabled:opacity-50 transition-all"
            title="Releer covenants y recalcular reporte"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Recalcular
          </button>
          <label className="flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2">
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest whitespace-nowrap">Facility</span>
            <select
              value={facilityFilter}
              onChange={e => setFacilityFilter(e.target.value)}
              disabled={transactions.length === 0}
              className="bg-transparent text-xs font-black text-slate-700 outline-none disabled:text-slate-400 min-w-44"
            >
              {transactions.length === 0 ? (
                <option value="all">Sin facilities registradas</option>
              ) : (
                <>
                  <option value="all">Todas las facilities</option>
                  <option value="general">General del cliente</option>
                  {transactions.map(tx => <option key={tx.id} value={tx.id}>{tx.name}</option>)}
                </>
              )}
            </select>
          </label>
          {displayCovenants.length > 0 && (
            <>
              <button onClick={() => handleExport('excel')} disabled={!!exporting} className="flex items-center gap-1.5 bg-white border border-slate-200 text-slate-600 font-bold px-3 py-2 rounded-xl text-xs hover:bg-slate-50 disabled:opacity-50 transition-all">
                {exporting === 'excel' ? <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg> : <Download className="w-3.5 h-3.5" />}
                Excel
              </button>
              <button onClick={() => handleExport('pdf')} disabled={!!exporting} className="flex items-center gap-1.5 bg-white border border-slate-200 text-slate-600 font-bold px-3 py-2 rounded-xl text-xs hover:bg-slate-50 disabled:opacity-50 transition-all">
                {exporting === 'pdf' ? <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg> : <FileText className="w-3.5 h-3.5" />}
                PDF
              </button>
            </>
          )}
          <button
            onClick={() => {
              setForm(p => ({ ...p, transactionId: facilityFilter !== 'all' && facilityFilter !== 'general' ? facilityFilter : '' }));
              setShowForm(true);
            }}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-4 py-2.5 rounded-xl text-sm transition-all"
          >
            <Plus className="w-4 h-4" />Nuevo
          </button>
        </div>
      </div>

      {allDisplayCovenants.length > 0 && displayCovenants.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center">
          <p className="text-slate-500 font-semibold">No hay indicadores financieros para esta facility.</p>
          <p className="text-slate-400 text-sm mt-1">Cambia el filtro o asigna un covenant existente a esta facility desde su detalle.</p>
        </div>
      )}

      {displayCovenants.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="bg-white border border-slate-200 rounded-2xl p-4">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Indicadores</p>
            <p className="text-2xl font-black text-slate-900 mt-1">{displayCovenants.length}</p>
          </div>
          <div className="bg-white border border-emerald-200 rounded-2xl p-4">
            <p className="text-[10px] font-black text-emerald-600 uppercase tracking-widest">Calculados</p>
            <p className="text-2xl font-black text-emerald-700 mt-1">{calculatedCount}</p>
          </div>
          <div className="bg-white border border-amber-200 rounded-2xl p-4">
            <p className="text-[10px] font-black text-amber-600 uppercase tracking-widest">Alertas</p>
            <p className="text-2xl font-black text-amber-700 mt-1">{warningCount}</p>
          </div>
          <div className="bg-white border border-rose-200 rounded-2xl p-4">
            <p className="text-[10px] font-black text-rose-600 uppercase tracking-widest">Incumplidos</p>
            <p className="text-2xl font-black text-rose-700 mt-1">{breachedCount}</p>
          </div>
        </div>
      )}

      {displayCovenants.length > 0 && (
        <div className="bg-white border border-indigo-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-indigo-100 bg-indigo-50/50 flex items-start justify-between gap-4">
            <div>
              <h3 className="text-xs font-black text-indigo-900 uppercase tracking-widest flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-indigo-600" />
                Insight para el analista
              </h3>
              <p className="text-xs text-indigo-700 mt-1">
                Degradación, mejoras y focos de seguimiento se analizan aquí, no en el reporte de monitoreo.
              </p>
            </div>
            <button
              onClick={copyInsightPrompt}
              className="flex items-center gap-1.5 bg-slate-900 text-white font-bold px-3 py-2 rounded-xl text-xs hover:bg-slate-800 transition-all"
            >
              <Clipboard className="w-3.5 h-3.5" />
              {promptCopied ? 'Copiado' : 'Copiar prompt AI'}
            </button>
          </div>
          <div className="p-5">
            <p className="text-sm font-black text-slate-900 leading-relaxed">{analystInsight.headline}</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
              {[
                { label: 'Deterioros', value: deteriorationCount, className: 'border-rose-100 bg-rose-50 text-rose-700' },
                { label: 'Mejoras', value: bettermentCount, className: 'border-emerald-100 bg-emerald-50 text-emerald-700' },
                { label: 'Sin datos', value: noDataPerformanceCount, className: 'border-slate-200 bg-slate-50 text-slate-600' },
              ].map(item => (
                <div key={item.label} className={`rounded-xl border px-4 py-3 ${item.className}`}>
                  <p className="text-[10px] font-black uppercase tracking-widest opacity-80">{item.label}</p>
                  <p className="text-2xl font-black mt-1">{item.value}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 space-y-2">
              {analystInsight.bullets.map((bullet, index) => (
                <p key={index} className="text-xs text-slate-600 leading-relaxed">
                  <span className="font-black text-indigo-600 mr-2">{index + 1}.</span>{bullet}
                </p>
              ))}
            </div>
          </div>
        </div>
      )}

      {displayCovenants.length > 0 && (
        <div className="bg-white border border-indigo-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-indigo-100 bg-indigo-50/50 flex items-start justify-between gap-4">
            <div>
              <h3 className="text-xs font-black text-indigo-900 uppercase tracking-widest flex items-center gap-2">
                <Pin className="w-4 h-4 text-indigo-600" />
                Mis indicadores favoritos
              </h3>
              <p className="text-xs text-indigo-700 mt-1">
                {favoriteSummary.headline}
              </p>
            </div>
            <span className="rounded-full bg-white px-3 py-1 text-[10px] font-black uppercase tracking-widest text-indigo-600 border border-indigo-100">{favorites.length} marcado{favorites.length === 1 ? '' : 's'}</span>
          </div>
          {favoriteInsights.length === 0 ? (
            <div className="p-5 text-xs font-semibold text-slate-500">
              {favoriteSummary.bullets[0]} Usa el ícono <Pin className="inline w-3.5 h-3.5 align-text-bottom text-indigo-600" /> en el storyline o en el mapa de fórmulas.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {favoriteInsights.map(ins => {
                const cov = covenantById.get(ins.covenantId);
                const style = SEVERITY_STYLE[ins.severity];
                return (
                  <div key={ins.key} className="grid grid-cols-1 gap-3 px-5 py-4 lg:grid-cols-[1.1fr_auto_2fr] lg:items-center">
                    <div className="flex items-start gap-2 min-w-0">
                      {cov && <FavButton active onClick={() => toggleFav(cov)} />}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-black text-slate-900">{ins.name}</p>
                          <span className={`rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ${style.chip}`}>{style.label}</span>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">{ins.period}: <span className="font-mono font-black text-slate-800">{cov ? fmtCov(ins.value, cov) : '—'}</span>
                          {ins.previousValue !== null && cov && <> <span className="text-slate-300">vs.</span> anterior <span className="font-mono font-black text-slate-700">{fmtCov(ins.previousValue, cov)}</span></>}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center"><Sparkline series={ins.series} className={style.spark} /></div>
                    <ul className="space-y-1">
                      {ins.lines.map((line, idx) => <li key={idx} className="text-xs leading-relaxed text-slate-600">{line}</li>)}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
          {favoriteInsights.length > 0 && (
            <div className="border-t border-indigo-100 bg-indigo-50/40 px-5 py-3">
              {favoriteSummary.bullets.map((b, i) => <p key={i} className="text-xs text-indigo-900"><span className="font-black mr-1">{i + 1}.</span>{b}</p>)}
            </div>
          )}
        </div>
      )}

      {storylineRows.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-4">
            <div>
              <h3 className="text-xs font-black text-slate-700 uppercase tracking-widest flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-indigo-500" />
                Storyline de indicadores
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                Tus favoritos van primero (con su tendencia); después, los movimientos más relevantes del último corte contra el anterior.
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-slate-500">
              {latestPeriod || 'Sin periodo'}
            </span>
          </div>
          <div className="divide-y divide-slate-100">
            {storylineRows.map(({ row, cov }) => {
              const distance = distanceToLimit(row.value, cov);
              const direction = deltaDirectionLabel(row.delta);
              const directionClass = row.delta === null || Math.abs(row.delta) < 0.000001
                ? 'text-slate-500 bg-slate-50 border-slate-200'
                : row.delta > 0
                  ? 'text-indigo-700 bg-indigo-50 border-indigo-100'
                  : 'text-cyan-700 bg-cyan-50 border-cyan-100';
              const impactClass = monitored && row.movement === 'deterioration'
                ? 'text-rose-700 bg-rose-50 border-rose-100'
                : row.movement === 'betterment'
                  ? 'text-emerald-700 bg-emerald-50 border-emerald-100'
                  : 'text-slate-600 bg-slate-50 border-slate-200';
              const riskTone = monitored ? riskToneFromDistance(distance, row.status) : 'Sin límite';
              const riskClass = riskTone === 'Breach'
                ? 'text-rose-700 bg-rose-50 border-rose-100'
                : riskTone === 'Presión alta'
                  ? 'text-amber-700 bg-amber-50 border-amber-100'
                  : riskTone === 'Con holgura'
                    ? 'text-emerald-700 bg-emerald-50 border-emerald-100'
                    : 'text-slate-500 bg-slate-50 border-slate-200';
              const deltaText = row.delta === null
                ? 'sin comparativo'
                : `${row.delta > 0 ? '+' : ''}${fmtCov(row.delta, cov)}${row.deltaPct !== null ? ` (${row.deltaPct > 0 ? '+' : ''}${(row.deltaPct * 100).toFixed(1)}%)` : ''}`;
              const previousText = row.previousValue === null ? '0' : fmtCov(row.previousValue, cov);
              const currentText = fmtCov(row.value, cov);
              const distanceText = distance === null ? '0' : fmtCov(distance, cov);
              return (
                <div key={row.covenantId} className="grid grid-cols-1 gap-4 px-5 py-4 lg:grid-cols-[1.2fr_1fr_1.6fr] lg:items-center">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <FavButton active={isFav(cov)} onClick={() => toggleFav(cov)} size="w-3.5 h-3.5" />
                      <p className="text-sm font-black text-slate-900">{row.covenantName}</p>
                      {favoriteInsightById.has(row.covenantId) && <Sparkline series={favoriteInsightById.get(row.covenantId)!.series} className={SEVERITY_STYLE[favoriteInsightById.get(row.covenantId)!.severity].spark} />}
                      {row.isContractCovenant && <span className="text-[9px] font-black text-amber-700 bg-amber-50 border border-amber-100 rounded-full px-2 py-0.5">CONTRATO</span>}
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {row.period}: <span className="font-mono font-black text-slate-800">{currentText}</span>
                      <span className="mx-1 text-slate-300">vs.</span>
                      anterior <span className="font-mono font-black text-slate-700">{previousText}</span>
                    </p>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className={`rounded-xl border px-3 py-2 ${directionClass}`}>
                      <p className="text-[9px] font-black uppercase tracking-widest opacity-80">Dirección</p>
                      <p className="mt-1 flex items-center gap-1 text-xs font-black">
                        {row.delta !== null && row.delta > 0 && <ArrowUpRight className="h-3.5 w-3.5" />}
                        {row.delta !== null && row.delta < 0 && <ArrowDownRight className="h-3.5 w-3.5" />}
                        {direction}
                      </p>
                    </div>
                    <div className={`rounded-xl border px-3 py-2 ${impactClass}`}>
                      <p className="text-[9px] font-black uppercase tracking-widest opacity-80">Impacto</p>
                      <p className="mt-1 text-xs font-black">{row.movementLabel}</p>
                    </div>
                    <div className={`rounded-xl border px-3 py-2 ${riskClass}`}>
                      <p className="text-[9px] font-black uppercase tracking-widest opacity-80">Límite</p>
                      <p className="mt-1 text-xs font-black">{riskTone}</p>
                    </div>
                  </div>
                  <p className="text-xs leading-relaxed text-slate-600">
                    {direction} {deltaText}. Esto se lee como <span className={`font-black ${row.movement === 'deterioration' ? 'text-rose-700' : row.movement === 'betterment' ? 'text-emerald-700' : 'text-slate-700'}`}>{row.movementLabel.toLowerCase()}</span>
                    {cov.operator !== 'none' && (
                      <>
                        {' '}contra el requisito <span className="font-mono font-black text-slate-800">{reqLabel(cov)}</span>; holgura actual <span className="font-mono font-black text-slate-800">{distanceText}</span>.
                      </>
                    )}
                    {cov.operator === 'none' && ' porque no hay umbral contractual capturado para esta métrica.'}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {mapRows.length > 0 && latestStatement && (() => {
        const issues = mapRows.filter(r => r.explain.severity !== 'ok');
        const errors = mapRows.filter(r => r.explain.severity === 'error').length;
        const q = fmap.query.trim().toLowerCase();
        const visible = mapRows
          .filter(r => !fmap.onlyFav || isFav(r.cov))
          .filter(r => !fmap.onlyIssues || r.explain.severity !== 'ok')
          .filter(r => !q || `${r.cov.name} ${r.explain.text}`.toLowerCase().includes(q));
        const money = (v: number | null) => (v === null ? 'sin dato' : Math.abs(v) >= 1e6 ? `$${(v / 1e6).toLocaleString('es-MX', { maximumFractionDigits: 1 })}M` : Math.abs(v) >= 1e3 ? `$${(v / 1e3).toLocaleString('es-MX', { maximumFractionDigits: 0 })}K` : v.toLocaleString('es-MX', { maximumFractionDigits: 2 }));
        return (
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
            <button type="button" onClick={() => setFmap(f => ({ ...f, open: !f.open }))} className="flex w-full items-start justify-between gap-4 px-5 py-4 text-left hover:bg-slate-50">
              <div>
                <h3 className="text-xs font-black text-slate-700 uppercase tracking-widest flex items-center gap-2">
                  {fmap.open ? <ChevronDown className="w-4 h-4 text-indigo-500" /> : <ChevronRight className="w-4 h-4 text-indigo-500" />}
                  Mapa de fórmulas
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Qué cuentas alimentan cada indicador en {latestStatement.period}, con su valor. Un insumo sin dato se toma como 0, por eso aquí se marca.
                </p>
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                {errors > 0 && <span className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-rose-700">{errors} con insumos sin dato</span>}
                <span className="rounded-full bg-slate-100 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-slate-500">{mapRows.length} indicadores{issues.length ? ` · ${issues.length} con avisos` : ''}</span>
              </div>
            </button>
            {fmap.open && (
              <>
                <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-5 py-3">
                  <input
                    value={fmap.query}
                    onChange={e => setFmap(f => ({ ...f, query: e.target.value }))}
                    placeholder="Buscar indicador o cuenta…"
                    className="min-w-[200px] flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 outline-none focus:ring-2 focus:ring-indigo-200"
                  />
                  <label className="flex items-center gap-1.5 text-[11px] font-black text-slate-600"><input type="checkbox" checked={fmap.onlyFav} onChange={e => setFmap(f => ({ ...f, onlyFav: e.target.checked }))} />Solo favoritos</label>
                  <label className="flex items-center gap-1.5 text-[11px] font-black text-slate-600"><input type="checkbox" checked={fmap.onlyIssues} onChange={e => setFmap(f => ({ ...f, onlyIssues: e.target.checked }))} />Solo con avisos</label>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-y border-slate-100 bg-slate-50 text-[10px] font-black uppercase tracking-widest text-slate-500">
                        <th className="px-3 py-2 w-10"></th>
                        <th className="px-3 py-2">Indicador</th>
                        <th className="px-3 py-2">Fórmula</th>
                        <th className="px-3 py-2">Insumos ({latestStatement.period})</th>
                        <th className="px-3 py-2 text-right">Resultado</th>
                        <th className="px-3 py-2">Avisos</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {visible.length === 0 && <tr><td colSpan={6} className="px-5 py-6 text-center text-xs font-semibold text-slate-400">Ningún indicador coincide con el filtro.</td></tr>}
                      {visible.map(({ cov, explain, shown }) => {
                        const source = isContractCovenant(cov) ? 'Contrato' : cov.isCustom ? 'Propio' : 'Estándar';
                        return (
                          <tr key={cov.id} className={explain.severity === 'error' ? 'bg-rose-50/40' : ''}>
                            <td className="px-3 py-2 align-top"><FavButton active={isFav(cov)} onClick={() => toggleFav(cov)} size="w-3.5 h-3.5" /></td>
                            <td className="px-3 py-2 align-top">
                              <p className="font-black text-slate-900">{cov.name}</p>
                              <span className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ${source === 'Contrato' ? 'border-amber-100 bg-amber-50 text-amber-700' : source === 'Propio' ? 'border-violet-100 bg-violet-50 text-violet-700' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>{source}</span>
                            </td>
                            <td className="px-3 py-2 align-top font-mono text-[11px] text-slate-700">{explain.text}</td>
                            <td className="px-3 py-2 align-top">
                              {explain.inputs.length === 0
                                ? <span className="text-[11px] font-semibold text-slate-400">{explain.kind === 'texto libre' ? 'Interpretada por palabras clave' : '—'}</span>
                                : <div className="flex flex-wrap gap-1">{explain.inputs.map(input => (
                                  <span key={input.ref} title={`${input.kind}: ${input.ref}`} className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${input.missing ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
                                    {input.label}: <span className="font-mono">{input.missing ? 'sin dato → 0' : money(input.value)}</span>
                                  </span>
                                ))}</div>}
                            </td>
                            <td className="px-3 py-2 align-top text-right font-mono font-black text-slate-900 whitespace-nowrap">
                              {shown ? fmtCov(shown.value, cov) : 'N/D'}
                              {shown?.annualized && <span className="block text-[9px] font-black uppercase tracking-widest text-indigo-500">anualizado</span>}
                            </td>
                            <td className="px-3 py-2 align-top">
                              {explain.notes.length === 0
                                ? <span className="text-[11px] font-semibold text-emerald-600">Completo</span>
                                : <ul className="space-y-1">{explain.notes.map((n, i) => <li key={i} className={`text-[11px] leading-snug ${explain.severity === 'error' && i === 0 ? 'font-bold text-rose-700' : 'text-slate-500'}`}>{n}</li>)}</ul>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        );
      })()}

      {covenantRows.length > 0 && orderedStatements.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-4">
            <div>
              <h3 className="text-xs font-black text-slate-700 uppercase tracking-widest flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-indigo-500" />
                Reporte de desempeño periodo a periodo
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                Último corte: {latestPeriod || 'N/D'} · {deteriorationCount} deterioro{deteriorationCount !== 1 ? 's' : ''} · {bettermentCount} mejora{bettermentCount !== 1 ? 's' : ''} · {noDataPerformanceCount} sin datos
              </p>
            </div>
          </div>
          {latestPerformance.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 p-5 border-b border-slate-100 bg-slate-50/60">
              {latestPerformance.slice(0, 3).map(row => (
                <div key={row.covenantId} className={`rounded-xl border p-4 ${
                  row.movement === 'deterioration' ? 'bg-rose-50 border-rose-100' :
                  row.movement === 'betterment' ? 'bg-emerald-50 border-emerald-100' :
                  'bg-white border-slate-200'
                }`}>
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">{row.movementLabel}</p>
                  <p className="text-sm font-black text-slate-900 mt-1 truncate">{row.covenantName}</p>
                  <p className="text-xs text-slate-600 mt-2">
                    Actual <span className="font-mono font-black">{(() => {
                      const cov = displayCovenants.find(c => c.id === row.covenantId) || ({ id: row.covenantId, clientId, name: row.covenantName, type: 'financial', formula: row.formula, description: '', threshold: row.threshold, operator: row.operator, isCustom: true, createdAt: '' } as Covenant_DB);
                      return fmtCov(row.value, cov);
                    })()}</span>
                    {row.delta !== null && (
                      <span className={
                        row.movement === 'deterioration' ? ' text-rose-700 font-black' :
                        row.movement === 'betterment' ? ' text-emerald-700 font-black' :
                        ' text-slate-500 font-black'
                      }>
                        {' '}({row.delta > 0 ? '+' : ''}{(() => {
                          const cov = displayCovenants.find(c => c.id === row.covenantId) || ({ id: row.covenantId, clientId, name: row.covenantName, type: 'financial', formula: row.formula, description: '', threshold: row.threshold, operator: row.operator, isCustom: true, createdAt: '' } as Covenant_DB);
                          return fmtCov(row.delta, cov);
                        })()})
                      </span>
                    )}
                  </p>
                </div>
              ))}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50">
                  <th className="text-left px-4 py-2 font-black text-slate-600 uppercase tracking-wider">Covenant</th>
                  <th className="text-left px-4 py-2 font-black text-slate-600 uppercase tracking-wider">Requisito</th>
                  <th className="text-left px-4 py-2 font-black text-slate-600 uppercase tracking-wider">Cambio último</th>
                  {orderedStatements.slice(-6).map(s => (
                    <th key={s.id} className="text-center px-4 py-2 font-black text-slate-600 uppercase tracking-wider whitespace-nowrap">{s.period}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayCovenants.map(cov => (
                  <tr key={cov.id} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-bold text-slate-800">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => toggleContractCovenant(cov as Covenant_DB & { virtual?: boolean })}
                          className={isContractCovenant(cov) ? 'text-amber-500' : 'text-slate-300 hover:text-amber-500'}
                          title="Marcar como covenant de contrato"
                        >
                          <Star className={`w-3.5 h-3.5 ${isContractCovenant(cov) ? 'fill-current' : ''}`} />
                        </button>
                        <span>{cov.name}</span>
                        {isContractCovenant(cov) && <span className="text-[9px] font-black text-amber-700 bg-amber-50 border border-amber-100 rounded-full px-2 py-0.5">CONTRATO</span>}
                      </div>
                    </td>
                    <td className="px-4 py-2 font-mono font-black text-slate-700 whitespace-nowrap">
                      {reqLabel(cov)}
                    </td>
                    <td className="px-4 py-2">
                      {(() => {
                        const last = performanceById.get(cov.id);
                        if (!last) return <span className="text-slate-400">N/A</span>;
                        return (
                          <div>
                            <span className={`font-black ${
                              last.movement === 'deterioration' ? 'text-rose-700' :
                              last.movement === 'betterment' ? 'text-emerald-700' :
                              'text-slate-500'
                            }`}>{last.movementLabel}</span>
                            <span className="block font-mono text-slate-500">
                              {last.delta === null ? 'sin comparativo' : `${last.delta > 0 ? '+' : ''}${last.delta.toLocaleString('es-MX', { maximumFractionDigits: 2 })}`}
                              {last.deltaPct !== null ? ` (${(last.deltaPct * 100).toFixed(1)}%)` : ''}
                            </span>
                          </div>
                        );
                      })()}
                    </td>
                    {orderedStatements.slice(-6).map(stmt => {
                      const result = evaluateCovenantForStatement(cov, stmt, orderedStatements);
                      return (
                        <td key={stmt.id} className="px-4 py-2 text-center">
                          <div className={`inline-flex min-w-20 flex-col items-center rounded-lg border px-2.5 py-1.5 ${
                            result.value === null || !monitored ? 'bg-slate-50 text-slate-400 border-slate-200' : periodStatusClass(result.status)
                          }`}>
                            <span className="font-mono font-black">{fmtCov(result.value, cov)}</span>
                            <span className="text-[9px] font-black uppercase opacity-80">{result.value === null ? '0' : result.status}</span>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="p-5 border-t border-slate-100 bg-white">
            <label className="text-xs font-black text-slate-600 uppercase tracking-widest block mb-2">Prompt AI para insights</label>
            <textarea
              readOnly
              value={latestInsightPrompt}
              rows={6}
              className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono text-slate-700 focus:outline-none"
            />
          </div>
        </div>
      )}

      {showForm && (
        <CovenantBuilder
          statements={orderedStatements}
          accountOpts={options}
          mappedOpts={mappedOptions}
          transactions={transactions}
          monitored={monitored}
          initialTransactionId={form.transactionId}
          saving={saving}
          onSave={handleBuilderSave}
          onClose={() => setShowForm(false)}
        />
      )}

      {globalSuggestions.length > 0 && (
        <div className="bg-white border border-emerald-100 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">Biblioteca global</h3>
              <p className="text-xs text-slate-400 mt-1">Plantillas activadas desde Consolidación. Tú decides si las creas para este cliente.</p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {globalSuggestions.map(t => (
              <div key={t.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-black text-slate-900">{t.name}</p>
                <p className="text-xs font-mono text-slate-500 mt-1">{formulaLabel(t.formula, labelMap)}</p>
                <p className="text-[10px] text-slate-400 mt-1">{t.source} · visto {t.seenCount}</p>
                <button onClick={() => addGlobalTemplate(t)} className="mt-3 w-full bg-emerald-600 text-white rounded-lg px-3 py-2 text-xs font-black hover:bg-emerald-500">Crear en cliente</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="bg-white border border-indigo-100 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">Sugeridos por cuentas detectadas</h3>
              <p className="text-xs text-slate-400 mt-1">Se calculan con EFF; tú defines umbral/operador si aplica.</p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {suggestions.slice(0, 6).map(s => (
              <div key={s.name} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-black text-slate-900">{s.name}</p>
                <p className="text-xs text-slate-500 mt-1">Actual: <span className="font-mono font-black">{s.currentValue?.toLocaleString('es-MX', { maximumFractionDigits: 4 })}</span></p>
                <button onClick={() => addSuggestion(s)} className="mt-3 w-full bg-indigo-600 text-white rounded-lg px-3 py-2 text-xs font-black hover:bg-indigo-500">Agregar</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {displayCovenants.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center">
          <TrendingUp className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 font-semibold">Sin indicadores financieros</p>
          <p className="text-slate-400 text-sm mt-1">Agrega métricas definidas en el contrato para monitorearlas contra los estados financieros</p>
        </div>
      )}

      <div className="space-y-3">
        {displayCovenants.map(cov => {
          const { value, status, mode } = evaluateCovenantAuto(cov, orderedStatements);
          const isExpanded = expanded === cov.id;
          const covAnnotations = (cov as any).virtual ? [] : (annotations[cov.id] || []);
          const limitDraft = limitDrafts[cov.id] || { operator: cov.operator, threshold: cov.threshold };
          const measurement = measurementConfig[cov.id] || { frequency: 'mensual' as const, startPeriod: '' };
          return (
            <div key={cov.id} className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
              <div className="flex items-start gap-4 px-6 py-4">
                <button onClick={() => toggleExpanded(cov)} className="text-slate-400 hover:text-slate-700 transition-colors mt-0.5">
                  {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 flex-wrap">
                    <h4 className="font-black text-slate-900 text-sm">{cov.name}</h4>
                    <StatusBadge status={status} />
                    {(cov as any).virtual && <span className="text-[10px] font-black bg-indigo-50 text-indigo-700 border border-indigo-100 rounded-full px-2 py-0.5">RATIO BASE</span>}
                    {isContractCovenant(cov) && <span className="text-[10px] font-black bg-amber-50 text-amber-700 border border-amber-100 rounded-full px-2 py-0.5">CONTRATO</span>}
                    {transactionName(cov.transactionId) && <span className="text-[10px] font-black bg-slate-100 text-slate-700 border border-slate-200 rounded-full px-2 py-0.5">{transactionName(cov.transactionId)}</span>}
                    <span className="text-[10px] font-black bg-cyan-50 text-cyan-700 border border-cyan-100 rounded-full px-2 py-0.5">
                      {frequencyLabels[measurement.frequency]}{measurement.startPeriod ? ` desde ${measurement.startPeriod}` : ''}
                    </span>
                    <span className="text-[10px] font-black bg-slate-100 text-slate-600 border border-slate-200 rounded-full px-2 py-0.5">
                      {(measurement.displayMode || 'auto') === 'percent' ? '%' : (measurement.displayMode || 'auto') === 'number' ? 'NUM' : 'AUTO'} · {measurement.decimals ?? 'auto'} dec
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
                    {cov.formula && <span className="font-mono bg-slate-100 px-2 py-0.5 rounded">{formulaLabel(cov.formula, labelMap)}</span>}
                    {cov.threshold && cov.operator !== 'none' && <span>{reqLabel(cov)}</span>}
                    <span className="font-bold text-slate-800">Actual: {fmtCov(value, cov)}</span>
                    <span className={`font-black ${mode === 'auto' ? 'text-indigo-600' : 'text-amber-600'}`}>{mode === 'auto' ? 'AUTO' : 'MANUAL'}</span>
                    {orderedStatements.length === 0 && <span className="text-amber-500 font-semibold">Sin estados financieros cargados</span>}
                  </div>
                  {cov.description && <p className="text-xs text-slate-500 mt-1 line-clamp-1">{cov.description}</p>}
                </div>
                <div className="flex items-center gap-2">
                  {covAnnotations.length > 0 && (
                    <span className="flex items-center gap-1 text-xs text-slate-500">
                      <MessageCircle className="w-3.5 h-3.5" />{covAnnotations.length}
                    </span>
                  )}
                  <button onClick={() => toggleContractCovenant(cov as Covenant_DB & { virtual?: boolean })} className={isContractCovenant(cov) ? 'text-amber-500' : 'text-slate-300 hover:text-amber-500'}>
                    <Star className={`w-4 h-4 ${isContractCovenant(cov) ? 'fill-current' : ''}`} />
                  </button>
                  <button onClick={() => handleDelete(cov as Covenant_DB & { virtual?: boolean })} className="text-slate-300 hover:text-rose-500 transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {isExpanded && (
                <div className="border-t border-slate-100 bg-slate-50">
                  {transactions.length > 0 && !(cov as any).virtual && (
                    <div className="px-6 py-4 border-b border-slate-100">
                      <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block mb-2">Facility / Transacción</label>
                      <select value={cov.transactionId || ''} onChange={e => saveTransactionLink(cov, e.target.value)} className={inputClass}>
                        <option value="">General del cliente</option>
                        {transactions.map(tx => <option key={tx.id} value={tx.id}>{tx.name}</option>)}
                      </select>
                    </div>
                  )}
                  <div className="px-6 py-4 border-b border-slate-100">
                    <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Medición contractual</p>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                      <label>
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Frecuencia</span>
                        <select value={measurement.frequency} onChange={e => saveMeasurementConfig(cov as Covenant_DB & { virtual?: boolean }, { frequency: e.target.value as CovenantMeasurementFrequency })} className={inputClass}>
                          <option value="mensual">Mensual</option>
                          <option value="trimestral">Trimestral</option>
                          <option value="semestral">Semestral</option>
                          <option value="anual">Anual</option>
                        </select>
                      </label>
                      <label>
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Desde cuándo</span>
                        <input type="month" value={measurement.startPeriod} onChange={e => saveMeasurementConfig(cov as Covenant_DB & { virtual?: boolean }, { startPeriod: e.target.value })} className={inputClass} />
                      </label>
                      <label>
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Mostrar como</span>
                        <select
                          value={measurement.displayMode || 'auto'}
                          onChange={e => saveMeasurementConfig(cov as Covenant_DB & { virtual?: boolean }, { displayMode: e.target.value as CovenantDisplayMode })}
                          className={inputClass}
                        >
                          <option value="auto">Auto</option>
                          <option value="number">Número</option>
                          <option value="percent">%</option>
                        </select>
                      </label>
                      <label>
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Decimales</span>
                        <input
                          type="number"
                          min={0}
                          max={6}
                          value={measurement.decimals ?? ''}
                          onChange={e => saveMeasurementConfig(cov as Covenant_DB & { virtual?: boolean }, { decimals: e.target.value === '' ? undefined : Number(e.target.value) })}
                          placeholder="Auto"
                          className={inputClass}
                        />
                      </label>
                    </div>
                  </div>
                  {cov.description && (
                    <div className="px-6 py-4 border-b border-slate-100">
                      <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Descripción</p>
                      <p className="text-sm text-slate-700 leading-relaxed">{cov.description}</p>
                    </div>
                  )}
                  <div className="px-6 py-4 border-b border-slate-100">
                    <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Umbral</p>
                    <div className="grid grid-cols-1 md:grid-cols-[140px_1fr_auto] gap-2 mb-4">
                      <select
                        value={limitDraft.operator}
                        onChange={e => setLimitDrafts(p => ({ ...p, [cov.id]: { ...limitDraft, operator: e.target.value as Covenant_DB['operator'] } }))}
                        className={inputClass}
                      >
                        <option value="none">Sin umbral</option>
                        <option value="lte">≤ menor o igual</option>
                        <option value="gte">≥ mayor o igual</option>
                        <option value="lt">&lt; menor que</option>
                        <option value="gt">&gt; mayor que</option>
                      </select>
                      <input
                        value={limitDraft.threshold}
                        onChange={e => setLimitDrafts(p => ({ ...p, [cov.id]: { ...limitDraft, threshold: e.target.value } }))}
                        placeholder="Umbral"
                        className={inputClass}
                      />
                      <button
                        onClick={() => saveLimit(cov as Covenant_DB & { virtual?: boolean })}
                        disabled={savingAction === `${cov.id}:limit`}
                        className="px-3 py-2 rounded-xl text-xs font-black bg-indigo-600 text-white disabled:opacity-60"
                      >
                        {savingAction === `${cov.id}:limit` ? 'Guardando...' : 'Guardar umbral'}
                      </button>
                    </div>
                    <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Editar fórmula</p>
                    <div className="rounded-xl bg-white border border-slate-200 p-4 mb-4 space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap gap-2">
                          <button onClick={() => setFormulaDrafts(p => ({ ...p, [cov.id]: tokensFromFormula(cov.formula) }))} className="h-8 rounded-md border border-slate-300 bg-white px-3 text-xs font-black text-slate-700 hover:bg-slate-50">Cargar global</button>
                          <button onClick={() => setFormulaDrafts(p => ({ ...p, [cov.id]: tokensFromFormula(cov.formulaByPeriod?.[latestPeriod] || cov.formula) }))} disabled={!latestPeriod} className="h-8 rounded-md border border-slate-300 bg-white px-3 text-xs font-black text-slate-700 hover:bg-slate-50 disabled:opacity-40">Cargar periodo</button>
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => setFormulaDrafts(p => ({ ...p, [cov.id]: (p[cov.id] || []).slice(0, -1) }))} className="h-8 rounded-md border border-slate-300 bg-white px-3 text-xs font-black text-slate-600 hover:bg-slate-50">Borrar</button>
                          <button onClick={() => setFormulaDrafts(p => ({ ...p, [cov.id]: [] }))} className="h-8 rounded-md border border-rose-200 bg-white px-3 text-xs font-black text-rose-600 hover:bg-rose-50">Limpiar</button>
                        </div>
                      </div>
                      <div className="grid grid-cols-[40px_1fr] items-stretch overflow-hidden rounded-lg border border-slate-300 bg-white">
                        <div className="flex items-center justify-center border-r border-slate-300 bg-slate-100 text-xs font-black text-slate-500">fx</div>
                        <div className={formulaBarClass}>
                          {(formulaDrafts[cov.id] || []).length === 0 ? <span className="text-slate-400">Carga o construye una fórmula</span> : formulaLabel(`expr:${JSON.stringify(formulaDrafts[cov.id])}`, labelMap)}
                        </div>
                      </div>
                      {latestStatement && (formulaDrafts[cov.id] || []).length > 0 && (() => {
                        const preview = evaluateFormula(`expr:${JSON.stringify(formulaDrafts[cov.id])}`, latestStatement);
                        return (
                          <div className="rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs text-indigo-900">
                            <span className="font-black uppercase tracking-widest text-indigo-500 mr-2">Preview {latestPeriod}</span>
                            <span className="font-mono font-black">{fmtCov(preview, cov)}</span>
                          </div>
                        );
                      })()}
                      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_auto]">
                        <div>
                          <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-1.5">Cuenta o métrica</label>
                          <select className={inputClass} onChange={e => e.target.value && setFormulaDrafts(p => ({ ...p, [cov.id]: [...(p[cov.id] || []), `ref:${e.target.value}`] }))} value="">
                            <option value="">Insertar referencia</option>
                            {mappedOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                            {options.map(o => <option key={o.key} value={`account:${o.key}`}>{o.label}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-1.5">Operadores</label>
                          <div className="flex flex-wrap gap-1.5">
                            {(['+', '-', '*', '/', '^', '(', ')'] as const).map(op => (
                              <button key={op} onClick={() => setFormulaDrafts(p => ({ ...p, [cov.id]: [...(p[cov.id] || []), op] }))} className={formulaToolButtonClass}>{op}</button>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="border-t border-slate-200 pt-3">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-1.5">Convertir texto a fórmula</label>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
                          <textarea
                            value={chatDrafts[cov.id]?.prompt || ''}
                            onChange={e => setChatDrafts(p => ({ ...p, [cov.id]: { prompt: e.target.value, result: p[cov.id]?.result || '' } }))}
                            rows={2}
                            placeholder="Ej: deuda total entre ebitda"
                            className={inputClass}
                          />
                          <button onClick={() => chatBuildForCovenant(cov)} className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-black text-slate-700 hover:bg-slate-50">Convertir</button>
                        </div>
                        {chatDrafts[cov.id]?.result && <p className="mt-2 text-xs font-bold text-slate-500">{chatDrafts[cov.id].result}</p>}
                      </div>
                      <div className="flex gap-2 flex-wrap border-t border-slate-200 pt-3">
                        <button
                          onClick={() => saveFormula(cov, 'global')}
                          disabled={savingAction === `${cov.id}:formula:global`}
                          className="px-3 py-2 rounded-lg text-xs font-black bg-indigo-600 text-white disabled:opacity-60"
                        >
                          {savingAction === `${cov.id}:formula:global` ? 'Guardando...' : 'Guardar global'}
                        </button>
                        <button
                          onClick={() => saveFormula(cov, 'period')}
                          disabled={!latestPeriod || savingAction === `${cov.id}:formula:period`}
                          className="px-3 py-2 rounded-lg text-xs font-black bg-slate-900 text-white disabled:opacity-40"
                        >
                          {savingAction === `${cov.id}:formula:period` ? 'Guardando...' : `Guardar solo ${latestPeriod || 'periodo'}`}
                        </button>
                        <button
                          onClick={() => clearPeriodFormula(cov)}
                          disabled={!cov.formulaByPeriod?.[latestPeriod] || savingAction === `${cov.id}:clear-period`}
                          className="px-3 py-2 rounded-lg text-xs font-black bg-white border border-slate-200 text-slate-600 disabled:opacity-40"
                        >
                          {savingAction === `${cov.id}:clear-period` ? 'Quitando...' : 'Quitar override periodo'}
                        </button>
                      </div>
                      {cov.formulaByPeriod?.[latestPeriod] && <p className="text-xs text-amber-600 font-bold mt-2">Este periodo usa fórmula específica.</p>}
                    </div>
                    {latestStatement && refsFromFormula(cov.formulaByPeriod?.[latestPeriod] || cov.formula || cov.name).length > 0 && (
                      <div className="rounded-xl bg-white border border-slate-200 p-3 mb-4">
                        <p className="text-xs font-black text-slate-500 uppercase tracking-widest mb-2">
                          Trazabilidad último periodo ({latestPeriod})
                        </p>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="bg-slate-50">
                                <th className="text-left px-3 py-2 font-black text-slate-500 uppercase tracking-wider">Ref</th>
                                <th className="text-left px-3 py-2 font-black text-slate-500 uppercase tracking-wider">Cuenta / métrica</th>
                                <th className="text-right px-3 py-2 font-black text-slate-500 uppercase tracking-wider">Valor usado</th>
                              </tr>
                            </thead>
                            <tbody>
                              {refsFromFormula(cov.formulaByPeriod?.[latestPeriod] || cov.formula || cov.name).map(ref => {
                                const value = ref.startsWith('account:')
                                  ? latestStatement.rawLineItems.find(item => `account:${rawAccountKey(item)}` === ref)?.value ?? null
                                  : getMetric(latestStatement, ref);
                                return (
                                  <tr key={ref} className="border-t border-slate-100">
                                    <td className="px-3 py-2 font-mono text-slate-500">{ref}</td>
                                    <td className="px-3 py-2 font-bold text-slate-700">{labelMap[ref] || ref}</td>
                                    <td className="px-3 py-2 text-right font-mono font-black text-slate-900">
                                      {(value ?? 0).toLocaleString('es-MX', { maximumFractionDigits: 2 })}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        <p className="text-[11px] text-slate-400 font-semibold mt-2">
                          Estos refs son los mismos que usa el Chat formula builder y el Excel exportado en Datos Covenant.
                        </p>
                      </div>
                    )}
                    <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Modo de cumplimiento</p>
                    <div className="flex gap-2 flex-wrap">
                      <button
                        onClick={() => setManualStatus(cov, 'auto')}
                        disabled={savingAction === `${cov.id}:status`}
                        className={`px-3 py-1.5 rounded-lg text-xs font-black disabled:opacity-60 ${mode === 'auto' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
                      >
                        Automático
                      </button>
                      {(['cumple', 'alerta', 'incumple'] as const).filter(opt => monitored || opt === 'cumple').map(s => (
                        <button
                          key={s}
                          onClick={() => setManualStatus(cov, s)}
                          disabled={savingAction === `${cov.id}:status`}
                          className={`px-3 py-1.5 rounded-lg text-xs font-black disabled:opacity-60 ${mode === 'manual' && status === s ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
                        >
                          {s.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="px-6 py-4">
                    <p className="text-xs font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                      <MessageCircle className="w-3.5 h-3.5" />Notas y Seguimiento
                    </p>
                    {covAnnotations.length === 0 ? (
                      <p className="text-xs text-slate-400 text-center py-4">Sin notas. Agrega la primera nota abajo.</p>
                    ) : (
                      <div className="space-y-3 mb-4 max-h-64 overflow-y-auto">
                        {covAnnotations.map(ann => {
                          const isMe = ann.userId === session.userId;
                          return (
                            <div key={ann.id} className={`flex gap-3 ${isMe ? 'flex-row-reverse' : ''}`}>
                              <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-black ${isMe ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-700'}`}>
                                {ann.userName.charAt(0).toUpperCase()}
                              </div>
                              <div className={`max-w-[80%] ${isMe ? 'items-end' : 'items-start'} flex flex-col`}>
                                <div className={`px-4 py-2.5 rounded-2xl text-sm ${isMe ? 'bg-indigo-600 text-white rounded-tr-sm' : 'bg-white border border-slate-200 text-slate-800 rounded-tl-sm'}`}>
                                  {ann.text}
                                </div>
                                <p className="text-[10px] text-slate-400 mt-1 px-1">
                                  {ann.userName} · {new Date(ann.createdAt).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                                  {ann.id.startsWith('pending:') ? ' · pendiente local' : ''}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                        <div ref={notesEndRef} />
                      </div>
                    )}
                    <div className="flex gap-3">
                      <input
                        type="text"
                        value={noteText[cov.id] || ''}
                        onChange={e => setNoteText(prev => ({ ...prev, [cov.id]: e.target.value }))}
                        onKeyDown={e => e.key === 'Enter' && handleSendNote(cov as Covenant_DB & { virtual?: boolean })}
                        placeholder="Agregar nota..."
                        className="flex-1 bg-white border border-slate-200 text-slate-900 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-all"
                      />
                      <button onClick={() => handleSendNote(cov as Covenant_DB & { virtual?: boolean })} disabled={!noteText[cov.id]?.trim() || sendingNote === cov.id} className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-300 text-white p-2.5 rounded-xl transition-all">
                        <Send className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default FinancialCovenantsPanel;
