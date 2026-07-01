import React, { useState, useEffect, useRef } from 'react';
import { db, Covenant_DB, CovenantAnnotation, FinancialStatement_DB } from '../../db/index';
import { Session } from '../../services/auth';
import { Plus, ChevronDown, ChevronRight, MessageCircle, Send, TrendingUp, CheckCircle, AlertTriangle, XCircle, X, Trash2, Download, FileText, Star, Clipboard, BarChart3 } from 'lucide-react';
import type { DefinedConcept } from '../../lib/export';
import { accountOptions, buildCovenantInsightPrompt, covenantPerformanceHistory, evaluateCovenantAuto, evaluateCovenantForStatement, formulaLabel, latestCovenantPerformance, standardRatioFormula, standardRatios, suggestedCovenants } from '../../lib/financialMetrics';
import { GlobalCovenantTemplate, loadOrgConsolidationRules, loadOrgGlobalCovenantTemplates } from '../../lib/accountConsolidation';
import { normalizeFinancialNumberString, parseNullableFinancialNumber } from '../../lib/numberParsing';

const nanoid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

interface Props {
  clientId: string;
  clientName?: string;
  session: Session;
  statements: FinancialStatement_DB[];
  onCovenantsChange: (covenants: Covenant_DB[]) => void;
}

const StatusBadge: React.FC<{ status: 'cumple' | 'alerta' | 'incumple' }> = ({ status }) => {
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
}

const EMPTY: FormData = { name: '', formula: '', threshold: '', operator: 'lte', description: '', numerator: '', denominator: '', expressionTokens: [], selectedRef: '', numberValue: '', chatPrompt: '', chatResult: '' };

const inputClass = 'bg-slate-50 border border-slate-200 text-slate-900 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-all w-full';
const clean = (v: string) => v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const LOCAL_NOTES_KEY = 'finmonitor_pending_covenant_notes';
const hiddenStandardKey = (clientId: string) => `finmonitor_hidden_standard_covs_${clientId}`;
const contractCovenantsKey = (clientId: string) => `finmonitor_contract_covs_${clientId}`;

const operatorLabel = (operator: Covenant_DB['operator']) => (
  operator === 'gte' ? '>=' :
  operator === 'gt' ? '>' :
  operator === 'lte' ? '<=' :
  operator === 'lt' ? '<' :
  'N/A'
);

const isPercentCovenant = (cov: Covenant_DB) => {
  const text = `${cov.name} ${cov.formula} ${cov.description || ''}`.toLowerCase();
  return text.includes('%') || text.includes('capital') || text.includes('roa') || text.includes('roe') || text.includes('margen') || text.includes('margin');
};

const formatCovenantValue = (value: number | null, cov: Covenant_DB) => {
  if (value === null || !Number.isFinite(value)) return 'N/A';
  if (isPercentCovenant(cov) && Math.abs(value) <= 3) return `${(value * 100).toFixed(1)}%`;
  return value.toLocaleString('es-MX', { maximumFractionDigits: 2 });
};

const requirementLabel = (cov: Covenant_DB) => {
  if (cov.operator === 'none' || !cov.threshold) return 'Sin umbral';
  const threshold = parseNullableFinancialNumber(cov.threshold);
  return `${operatorLabel(cov.operator)} ${threshold === null ? cov.threshold : formatCovenantValue(threshold, cov)}`;
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

const FinancialCovenantsPanel: React.FC<Props> = ({ clientId, clientName = '', session, statements, onCovenantsChange }) => {
  const [covenants, setCovenants] = useState<Covenant_DB[]>([]);
  const [annotations, setAnnotations] = useState<Record<string, CovenantAnnotation[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormData>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [noteText, setNoteText] = useState<Record<string, string>>({});
  const [sendingNote, setSendingNote] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'excel' | 'pdf' | null>(null);
  const [formulaDrafts, setFormulaDrafts] = useState<Record<string, string[]>>({});
  const [limitDrafts, setLimitDrafts] = useState<Record<string, { operator: Covenant_DB['operator']; threshold: string }>>({});
  const [chatDrafts, setChatDrafts] = useState<Record<string, { prompt: string; result: string }>>({});
  const [promptCopied, setPromptCopied] = useState(false);
  const [concepts, setConcepts] = useState<DefinedConcept[]>([]);
  const [globalTemplates, setGlobalTemplates] = useState<GlobalCovenantTemplate[]>([]);
  const [contractCovenants, setContractCovenants] = useState<string[]>([]);
  const [hiddenStandard, setHiddenStandard] = useState<string[]>([]);
  const notesEndRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleExport = async (format: 'excel' | 'pdf') => {
    setExporting(format);
    try {
      const { exportCovenantsFinancieros } = await import('../../lib/export');
      await exportCovenantsFinancieros(covenants, statements, clientName, format, format === 'pdf' ? panelRef.current ?? undefined : undefined, contractCovenants);
    } finally {
      setExporting(null);
    }
  };

  const loadData = async () => {
    await loadOrgConsolidationRules(session.userId);
    const hidden = await db.getClientSetting<string[]>(clientId, hiddenStandardKey(clientId), []);
    setHiddenStandard(hidden);
    let all = await db.getCovenants(clientId);
    let financial = all.filter(c => c.type === 'financial');
    const latest = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate)).at(-1);
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

  useEffect(() => { loadData(); }, [clientId, statements.length]);
  useEffect(() => {
    db.getClientSetting<DefinedConcept[]>(clientId, `finmonitor_defined_concepts_${clientId}`, []).then(setConcepts);
  }, [clientId]);
  useEffect(() => {
    db.getClientSetting<string[]>(clientId, contractCovenantsKey(clientId), []).then(setContractCovenants);
  }, [clientId]);
  useEffect(() => {
    let cancelled = false;
    loadOrgGlobalCovenantTemplates(session.userId).then(templates => {
      if (!cancelled) setGlobalTemplates(templates);
    });
    return () => { cancelled = true; };
  }, [session.userId, clientId, statements.length]);

  useEffect(() => {
    if (expanded && notesEndRef.current) notesEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [expanded, annotations]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const formula = form.expressionTokens.length > 0
        ? `expr:${JSON.stringify(form.expressionTokens)}`
        : form.numerator && form.denominator
          ? `ratio:${form.numerator}/${form.denominator}`
          : form.formula.trim();
      await db.createCovenant({ clientId, name: form.name.trim(), type: 'financial', formula, threshold: form.threshold.trim(), operator: form.operator, description: form.description.trim(), isCustom: true });
      setForm(EMPTY);
      setShowForm(false);
      await loadData();
    } catch (err: any) { alert(err.message); }
    finally { setSaving(false); }
  };

  const setManualStatus = async (cov: Covenant_DB, status: 'cumple' | 'alerta' | 'incumple' | 'auto') => {
    const real = await materialize(cov as Covenant_DB & { virtual?: boolean });
    await db.updateCovenant(real.id, { complianceStatus: status === 'auto' ? '' : `manual:${status}` });
    await loadData();
  };

  const latestPeriod = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate)).at(-1)?.period || '';
  const latestStatement = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate)).at(-1);

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

  const saveFormula = async (cov: Covenant_DB, scope: 'global' | 'period') => {
    const tokens = formulaDrafts[cov.id] || [];
    if (tokens.length === 0) return;
    const real = await materialize(cov as Covenant_DB & { virtual?: boolean });
    const formula = `expr:${JSON.stringify(tokens)}`;
    if (scope === 'global') {
      await db.updateCovenant(real.id, { formula });
    } else if (latestPeriod) {
      await db.updateCovenant(real.id, { formulaByPeriod: { ...(real.formulaByPeriod || {}), [latestPeriod]: formula } });
    }
    await loadData();
  };

  const clearPeriodFormula = async (cov: Covenant_DB) => {
    if (!latestPeriod) return;
    const next = { ...(cov.formulaByPeriod || {}) };
    delete next[latestPeriod];
    await db.updateCovenant(cov.id, { formulaByPeriod: next });
    await loadData();
  };

  const options = accountOptions(statements);
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
  const displayCovenants = [
    ...standardVirtuals,
    ...covenants.filter(c => !standardVirtuals.some(s => s.id === c.id || s.formula === c.formula || clean(s.name) === clean(c.name))),
  ];
  const covenantRows = displayCovenants.map(cov => ({ cov, ...evaluateCovenantAuto(cov, statements) }));
  const breachedCount = covenantRows.filter(r => r.status === 'incumple').length;
  const warningCount = covenantRows.filter(r => r.status === 'alerta').length;
  const calculatedCount = covenantRows.filter(r => r.value !== null).length;
  const latestPerformance = latestCovenantPerformance(displayCovenants, statements);
  const latestInsightPrompt = buildCovenantInsightPrompt(clientName, latestPerformance);
  const deteriorationCount = latestPerformance.filter(r => r.movement === 'deterioration').length;
  const bettermentCount = latestPerformance.filter(r => r.movement === 'betterment').length;
  const noDataPerformanceCount = latestPerformance.filter(r => r.movement === 'insufficient').length;
  const suggestions = suggestedCovenants(statements).filter(s => !displayCovenants.some(c => clean(c.name) === clean(s.name)));
  const globalSuggestions = globalTemplates
    .filter(t => t.active)
    .filter(t => !displayCovenants.some(c => clean(c.name) === clean(t.name) || (t.formula && c.formula === t.formula)));
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
  const contractKeysFor = (cov: Covenant_DB) => [cov.id, cov.formula ? `formula:${cov.formula}` : '', `name:${clean(cov.name)}`].filter(Boolean);
  const isContractCovenant = (cov: Covenant_DB) => contractKeysFor(cov).some(key => contractCovenants.includes(key));
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
  const parsePromptToTokens = (prompt: string): { tokens: string[]; missing: string[] } => {
    const aliases = [
      ...mappedOptions.map(o => ({ key: o.key, label: o.label.replace('Mapped: ', '') })),
      ...options.map(o => ({ key: `account:${o.key}`, label: o.label })),
    ].sort((a, b) => b.label.length - a.label.length);
    const operatorWords: Array<[RegExp, string]> = [
      [/\belevado a\b|\ba la potencia\b|\bpotencia\b|\^/gi, '^'],
      [/\bentre\b|\bdividido por\b|\bsobre\b|\//gi, '/'],
      [/\bpor\b|\bmultiplicado por\b|\*/gi, '*'],
      [/\bmenos\b|\brestando\b|-/gi, '-'],
      [/\bmas\b|\bmás\b|\bsumando\b|\+/gi, '+'],
      [/\(/g, '('],
      [/\)/g, ')'],
    ];
    let text = ` ${prompt} `;
    for (const [re, op] of operatorWords) text = text.replace(re, ` ${op} `);
    const parts = text.split(/\s+/).filter(Boolean);
    const tokens: string[] = [];
    const missing: string[] = [];
    let buffer: string[] = [];
    const flush = () => {
      const phrase = clean(buffer.join(' '));
      buffer = [];
      if (!phrase) return;
      const asNumber = parseNullableFinancialNumber(phrase);
      if (asNumber !== null) { tokens.push(`num:${asNumber}`); return; }
      const hit = aliases.find(a => {
        const label = clean(a.label);
        return label.includes(phrase) || phrase.includes(label) || phrase.split(' ').every(w => label.includes(w));
      });
      if (hit) tokens.push(`ref:${hit.key}`);
      else missing.push(phrase);
    };
    for (const part of parts) {
      if (['+', '-', '*', '/', '^', '(', ')'].includes(part)) {
        flush();
        tokens.push(part);
      } else {
        buffer.push(part);
      }
    }
    flush();
    return { tokens, missing };
  };

  const handleChatBuild = () => {
    const { tokens, missing } = parsePromptToTokens(form.chatPrompt);
    if (missing.length > 0 || tokens.length === 0) {
      setForm(p => ({ ...p, chatResult: `No encontré: ${missing.join(', ') || 'cuentas válidas'}. Usa nombres extraídos o selecciona manual.` }));
      return;
    }
    setForm(p => ({ ...p, expressionTokens: tokens, chatResult: 'Fórmula creada. Revísala antes de guardar.' }));
  };

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
    const real = await materialize(cov);
    await db.updateCovenant(real.id, { operator: draft.operator, threshold: normalizeFinancialNumberString(draft.threshold) });
    await loadData();
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
      await navigator.clipboard.writeText(latestInsightPrompt);
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
          <h2 className="text-lg font-black text-slate-900">Covenants Financieros</h2>
          <p className="text-slate-500 text-sm mt-0.5">{displayCovenants.length} covenant{displayCovenants.length !== 1 ? 's' : ''} · métricas medidas contra estados financieros</p>
        </div>
        <div className="flex items-center gap-2">
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
          <button onClick={() => setShowForm(true)} className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-4 py-2.5 rounded-xl text-sm transition-all">
            <Plus className="w-4 h-4" />Nuevo
          </button>
        </div>
      </div>

      {displayCovenants.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="bg-white border border-slate-200 rounded-2xl p-4">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Covenants</p>
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

      {covenantRows.length > 0 && statements.length > 0 && (
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
            <button
              onClick={copyInsightPrompt}
              className="flex items-center gap-1.5 bg-slate-900 text-white font-bold px-3 py-2 rounded-xl text-xs hover:bg-slate-800 transition-all"
            >
              <Clipboard className="w-3.5 h-3.5" />
              {promptCopied ? 'Copiado' : 'Copiar prompt AI'}
            </button>
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
                    Actual <span className="font-mono font-black">{formatCovenantValue(row.value, displayCovenants.find(c => c.id === row.covenantId) || ({ name: row.covenantName, formula: row.formula, description: '', threshold: row.threshold, operator: row.operator } as Covenant_DB))}</span>
                    {row.delta !== null && (
                      <span className={
                        row.movement === 'deterioration' ? ' text-rose-700 font-black' :
                        row.movement === 'betterment' ? ' text-emerald-700 font-black' :
                        ' text-slate-500 font-black'
                      }>
                        {' '}({row.delta > 0 ? '+' : ''}{row.delta.toLocaleString('es-MX', { maximumFractionDigits: 2 })})
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
                  {statements.slice(-6).map(s => (
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
                      {requirementLabel(cov)}
                    </td>
                    <td className="px-4 py-2">
                      {(() => {
                        const last = covenantPerformanceHistory(cov, statements).at(-1);
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
                    {statements.slice(-6).map(stmt => {
                      const result = evaluateCovenantForStatement(cov, stmt);
                      return (
                        <td key={stmt.id} className="px-4 py-2 text-center">
                          <div className={`inline-flex min-w-20 flex-col items-center rounded-lg border px-2.5 py-1.5 ${
                            result.value === null ? 'bg-slate-50 text-slate-400 border-slate-200' : periodStatusClass(result.status)
                          }`}>
                            <span className="font-mono font-black">{formatCovenantValue(result.value, cov)}</span>
                            <span className="text-[9px] font-black uppercase opacity-80">{result.value === null ? 'N/D' : result.status}</span>
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
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-6 border-b border-slate-100">
              <h3 className="font-black text-slate-900">Nuevo Covenant Financiero</h3>
              <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSave} className="p-6 space-y-4">
              <div>
                <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Nombre *</label>
                <input className={inputClass} value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="ej: Razón de Apalancamiento" required />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Fórmula</label>
                  <input className={inputClass} value={form.formula} onChange={e => setForm(p => ({ ...p, formula: e.target.value }))} placeholder="ej: Deuda/EBITDA" />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Umbral</label>
                  <input className={inputClass} value={form.threshold} onChange={e => setForm(p => ({ ...p, threshold: e.target.value }))} placeholder="ej: 4.0" />
                </div>
              </div>
              {options.length > 0 && (
                <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-3 space-y-3">
                  <p className="text-xs font-black text-indigo-900 uppercase tracking-widest">Builder tipo Excel con cuentas extraídas</p>
                  <div className="rounded-xl bg-white border border-indigo-100 p-3 space-y-2">
                    <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block">Chat formula builder</label>
                    <textarea
                      value={form.chatPrompt}
                      onChange={e => setForm(p => ({ ...p, chatPrompt: e.target.value }))}
                      rows={2}
                      placeholder="Ej: (deuda total + pasivo corriente) / ebitda"
                      className={inputClass}
                    />
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={handleChatBuild} className="bg-slate-900 text-white px-3 py-2 rounded-lg text-xs font-black">Crear fórmula</button>
                      {form.chatResult && <span className="text-xs font-bold text-slate-500">{form.chatResult}</span>}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2">
                    <select className={inputClass} value={form.selectedRef} onChange={e => setForm(p => ({ ...p, selectedRef: e.target.value }))}>
                      <option value="">Selecciona cuenta o mapped field</option>
                      {mappedOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                      {options.map(o => <option key={o.key} value={`account:${o.key}`}>{o.label}</option>)}
                    </select>
                    <button type="button" onClick={() => form.selectedRef && setForm(p => ({ ...p, expressionTokens: [...p.expressionTokens, `ref:${p.selectedRef}`], selectedRef: '' }))} className="bg-indigo-600 text-white px-3 py-2 rounded-xl text-xs font-black">Agregar cuenta</button>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {(['+', '-', '*', '/', '^', '(', ')'] as const).map(op => (
                      <button key={op} type="button" onClick={() => setForm(p => ({ ...p, expressionTokens: [...p.expressionTokens, op] }))} className="w-10 h-9 rounded-lg bg-white border border-slate-200 font-black text-slate-700">{op}</button>
                    ))}
                    <input value={form.numberValue} onChange={e => setForm(p => ({ ...p, numberValue: e.target.value }))} placeholder="número" className="w-28 bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono" />
                    <button type="button" onClick={() => {
                      const value = normalizeFinancialNumberString(form.numberValue);
                      if (value) setForm(p => ({ ...p, expressionTokens: [...p.expressionTokens, `num:${value}`], numberValue: '' }));
                    }} className="bg-white border border-slate-200 text-slate-700 px-3 py-2 rounded-lg text-xs font-black">Agregar #</button>
                    <button type="button" onClick={() => setForm(p => ({ ...p, expressionTokens: p.expressionTokens.slice(0, -1) }))} className="bg-white border border-slate-200 text-slate-700 px-3 py-2 rounded-lg text-xs font-black">Borrar último</button>
                    <button type="button" onClick={() => setForm(p => ({ ...p, expressionTokens: [] }))} className="bg-rose-50 text-rose-700 px-3 py-2 rounded-lg text-xs font-black">Limpiar</button>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-xl p-3 min-h-12 text-sm font-mono text-slate-800">
                    {form.expressionTokens.length === 0 ? <span className="text-slate-300">Ej: EBITDA + Otra cuenta - Gastos / Deuda</span> : form.expressionTokens.map(t => {
                      if (t.startsWith('ref:')) return labelMap[t.slice(4)] || t.slice(4);
                      if (t.startsWith('num:')) return t.slice(4);
                      return t;
                    }).join(' ')}
                  </div>
                </div>
              )}
              <div>
                <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Operador</label>
                <select className={inputClass} value={form.operator} onChange={e => setForm(p => ({ ...p, operator: e.target.value as any }))}>
                  <option value="lte">≤ menor o igual</option>
                  <option value="gte">≥ mayor o igual</option>
                  <option value="lt">&lt; menor que</option>
                  <option value="gt">&gt; mayor que</option>
                  <option value="none">N/A</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Descripción</label>
                <textarea className={inputClass} value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} rows={3} placeholder="Descripción del covenant según contrato" />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)} className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-700 text-sm font-bold hover:bg-slate-50">Cancelar</button>
                <button type="submit" disabled={saving} className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-black disabled:opacity-60">{saving ? 'Guardando...' : 'Guardar'}</button>
              </div>
            </form>
          </div>
        </div>
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
          <p className="text-slate-500 font-semibold">Sin covenants financieros</p>
          <p className="text-slate-400 text-sm mt-1">Agrega métricas definidas en el contrato para monitorearlas contra los estados financieros</p>
        </div>
      )}

      <div className="space-y-3">
        {displayCovenants.map(cov => {
          const { value, status, mode } = evaluateCovenantAuto(cov, statements);
          const isExpanded = expanded === cov.id;
          const covAnnotations = (cov as any).virtual ? [] : (annotations[cov.id] || []);
          const limitDraft = limitDrafts[cov.id] || { operator: cov.operator, threshold: cov.threshold };
          return (
            <div key={cov.id} className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
              <div className="flex items-start gap-4 px-6 py-4">
                <button onClick={() => setExpanded(isExpanded ? null : cov.id)} className="text-slate-400 hover:text-slate-700 transition-colors mt-0.5">
                  {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 flex-wrap">
                    <h4 className="font-black text-slate-900 text-sm">{cov.name}</h4>
                    <StatusBadge status={status} />
                    {(cov as any).virtual && <span className="text-[10px] font-black bg-indigo-50 text-indigo-700 border border-indigo-100 rounded-full px-2 py-0.5">RATIO BASE</span>}
                    {isContractCovenant(cov) && <span className="text-[10px] font-black bg-amber-50 text-amber-700 border border-amber-100 rounded-full px-2 py-0.5">CONTRATO</span>}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
                    {cov.formula && <span className="font-mono bg-slate-100 px-2 py-0.5 rounded">{formulaLabel(cov.formula, labelMap)}</span>}
                    {cov.threshold && cov.operator !== 'none' && <span>{requirementLabel(cov)}</span>}
                    {value !== null && <span className="font-bold text-slate-800">Actual: {formatCovenantValue(value, cov)}</span>}
                    <span className={`font-black ${mode === 'auto' ? 'text-indigo-600' : 'text-amber-600'}`}>{mode === 'auto' ? 'AUTO' : 'MANUAL'}</span>
                    {statements.length === 0 && <span className="text-amber-500 font-semibold">Sin estados financieros cargados</span>}
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
                      <button onClick={() => saveLimit(cov as Covenant_DB & { virtual?: boolean })} className="px-3 py-2 rounded-xl text-xs font-black bg-indigo-600 text-white">
                        Guardar umbral
                      </button>
                    </div>
                    <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Editar fórmula</p>
                    <div className="rounded-xl bg-white border border-slate-200 p-3 mb-4">
                      <div className="rounded-xl bg-indigo-50/50 border border-indigo-100 p-3 mb-3">
                        <label className="text-xs font-black text-indigo-900 uppercase tracking-widest block mb-2">Chat formula builder</label>
                        <textarea
                          value={chatDrafts[cov.id]?.prompt || ''}
                          onChange={e => setChatDrafts(p => ({ ...p, [cov.id]: { prompt: e.target.value, result: p[cov.id]?.result || '' } }))}
                          rows={2}
                          placeholder="Ej: (deuda total + pasivo corriente) / ebitda"
                          className={inputClass}
                        />
                        <div className="flex items-center gap-2 mt-2">
                          <button onClick={() => chatBuildForCovenant(cov)} className="bg-slate-900 text-white px-3 py-2 rounded-lg text-xs font-black">Crear fórmula</button>
                          {chatDrafts[cov.id]?.result && <span className="text-xs font-bold text-slate-500">{chatDrafts[cov.id].result}</span>}
                        </div>
                      </div>
                      <div className="flex gap-2 flex-wrap mb-3">
                        <button onClick={() => setFormulaDrafts(p => ({ ...p, [cov.id]: tokensFromFormula(cov.formula) }))} className="px-3 py-1.5 rounded-lg text-xs font-black bg-slate-100 text-slate-700">Cargar global</button>
                        <button onClick={() => setFormulaDrafts(p => ({ ...p, [cov.id]: tokensFromFormula(cov.formulaByPeriod?.[latestPeriod] || cov.formula) }))} disabled={!latestPeriod} className="px-3 py-1.5 rounded-lg text-xs font-black bg-slate-100 text-slate-700 disabled:opacity-40">Cargar periodo</button>
                        {(['+', '-', '*', '/', '^', '(', ')'] as const).map(op => (
                          <button key={op} onClick={() => setFormulaDrafts(p => ({ ...p, [cov.id]: [...(p[cov.id] || []), op] }))} className="w-8 h-8 rounded-lg bg-white border border-slate-200 font-black text-slate-700">{op}</button>
                        ))}
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2 mb-3">
                        <select className={inputClass} onChange={e => e.target.value && setFormulaDrafts(p => ({ ...p, [cov.id]: [...(p[cov.id] || []), `ref:${e.target.value}`] }))} value="">
                          <option value="">Agregar cuenta...</option>
                          {mappedOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                          {options.map(o => <option key={o.key} value={`account:${o.key}`}>{o.label}</option>)}
                        </select>
                        <button onClick={() => setFormulaDrafts(p => ({ ...p, [cov.id]: (p[cov.id] || []).slice(0, -1) }))} className="px-3 py-2 rounded-xl text-xs font-black bg-rose-50 text-rose-700">Borrar último</button>
                      </div>
                      <div className="bg-slate-50 rounded-xl p-3 text-xs font-mono text-slate-800 min-h-10">
                        {(formulaDrafts[cov.id] || []).length === 0 ? 'Sin draft cargado' : formulaLabel(`expr:${JSON.stringify(formulaDrafts[cov.id])}`, labelMap)}
                      </div>
                      <div className="flex gap-2 mt-3 flex-wrap">
                        <button onClick={() => saveFormula(cov, 'global')} className="px-3 py-2 rounded-lg text-xs font-black bg-indigo-600 text-white">Guardar global</button>
                        <button onClick={() => saveFormula(cov, 'period')} disabled={!latestPeriod} className="px-3 py-2 rounded-lg text-xs font-black bg-slate-900 text-white disabled:opacity-40">Guardar solo {latestPeriod || 'periodo'}</button>
                        <button onClick={() => clearPeriodFormula(cov)} disabled={!cov.formulaByPeriod?.[latestPeriod]} className="px-3 py-2 rounded-lg text-xs font-black bg-white border border-slate-200 text-slate-600 disabled:opacity-40">Quitar override periodo</button>
                      </div>
                      {cov.formulaByPeriod?.[latestPeriod] && <p className="text-xs text-amber-600 font-bold mt-2">Este periodo usa fórmula específica.</p>}
                    </div>
                    <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Modo de cumplimiento</p>
                    <div className="flex gap-2 flex-wrap">
                      <button onClick={() => setManualStatus(cov, 'auto')} className={`px-3 py-1.5 rounded-lg text-xs font-black ${mode === 'auto' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}>Automático</button>
                      {(['cumple', 'alerta', 'incumple'] as const).map(s => (
                        <button key={s} onClick={() => setManualStatus(cov, s)} className={`px-3 py-1.5 rounded-lg text-xs font-black ${mode === 'manual' && status === s ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}>{s.toUpperCase()}</button>
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
