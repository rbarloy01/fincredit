import React, { Suspense, useState, useEffect, useRef } from 'react';
import { db, LoanTape_DB } from '../../db/index';
import { Session } from '../../services/auth';
import { AISettings, analyzeLoanTape, StructuredLoanTapeAnalysis } from '../../services/ai';
import {
  Upload, Trash2, Sparkles, TrendingUp, TrendingDown, Minus,
  BarChart3, FileSpreadsheet, ChevronDown, ChevronRight,
  ShieldCheck, ShieldAlert, ShieldX, AlertTriangle, CheckCircle, XCircle,
  FileText, Bot, Plus, LayoutDashboard,
} from 'lucide-react';
import { analyzeLoanTapesLocally, answerLoanTapeQuestion, buildLoanTapeDataProfile, standardizeLoanTape } from '../../lib/loanTapeAnalytics';
import {
  createLoanTapeWorkspaceBlock,
  LoanTapeAnalystState,
  LoanTapeBlockType,
  normalizeLoanTapeAnalystState,
} from '../../lib/loanTapeWorkspace';
import WorkingOverlay from '../common/WorkingOverlay';
import { lazyWithChunkRetry } from '../../lib/lazyWithChunkRetry';
import { loadExportModule } from '../../lib/exportLoader';

const WorkspaceBlock = lazyWithChunkRetry(() => import('./LoanTapeWorkspaceBlock'), 'loan-tape-workspace-block');

interface Props {
  clientId: string;
  clientName?: string;
  session: Session;
  aiSettings: AISettings;
  onTapesChange: (tapes: LoanTape_DB[]) => void;
}

function StatusBadge({ status }: { status?: string }) {
  if (status === 'good') return (
    <span className="flex items-center gap-1 text-xs font-black text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full">
      <ShieldCheck className="w-3 h-3" /> BUENO
    </span>
  );
  if (status === 'warning') return (
    <span className="flex items-center gap-1 text-xs font-black text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-full">
      <ShieldAlert className="w-3 h-3" /> ALERTA
    </span>
  );
  return (
    <span className="flex items-center gap-1 text-xs font-black text-rose-700 bg-rose-50 border border-rose-200 px-2.5 py-1 rounded-full">
      <ShieldX className="w-3 h-3" /> CRÍTICO
    </span>
  );
}

function RiskGauge({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, score));
  const color = clamped < 35 ? '#10b981' : clamped < 65 ? '#f59e0b' : '#f43f5e';
  const rotation = -135 + (clamped / 100) * 270;
  return (
    <div className="relative w-28 h-16 mx-auto">
      <svg viewBox="0 0 120 70" className="w-full h-full">
        <path d="M 10 65 A 50 50 0 0 1 110 65" fill="none" stroke="#F1F5F9" strokeWidth="10" strokeLinecap="round" />
        <g transform={`translate(60 65) rotate(${rotation})`}>
          <line x1="0" y1="0" x2="0" y2="-38" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="0" cy="0" r="4" fill={color} />
        </g>
        <text x="60" y="58" textAnchor="middle" fontSize="13" fontWeight="900" fill="#1E293B">{clamped}</text>
      </svg>
    </div>
  );
}

function TrendIcon({ trend }: { trend?: string }) {
  if (trend === 'up') return <TrendingUp className="w-3.5 h-3.5 text-emerald-500" />;
  if (trend === 'down') return <TrendingDown className="w-3.5 h-3.5 text-rose-500" />;
  return <Minus className="w-3.5 h-3.5 text-slate-400" />;
}

function MetricStatus({ status }: { status?: string }) {
  if (status === 'good') return <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />;
  if (status === 'warning') return <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />;
  return <XCircle className="w-3.5 h-3.5 text-rose-500" />;
}

const SEVERITY_COLORS: Record<string, string> = {
  high: 'bg-rose-50 border-rose-200 text-rose-800',
  medium: 'bg-amber-50 border-amber-200 text-amber-800',
  low: 'bg-slate-50 border-slate-200 text-slate-700',
};

const fmtMoney = (value: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(value || 0);
const fmtPct = (value: number) => `${((value || 0) * 100).toFixed(1)}%`;
const fmtNum = (value: number) => Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—';
const QUICK_QUESTIONS = ['qué falta', 'mora', 'top concentración', 'por producto', 'cambios vs mes anterior'];
const BLOCK_PROMPTS = ['Resumen ejecutivo', 'Gráfica de mora por DPD', 'Top clientes por saldo', 'Cartera por producto', 'Evolución vs mes anterior'];
function SmallDataTable({ title, rows, columns }: { title: string; rows?: any[]; columns: Array<{ key: string; label: string; format?: (value: any) => string }> }) {
  if (!rows?.length) return null;
  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100">
        <p className="text-xs font-black text-slate-700 uppercase tracking-widest">{title}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-slate-50">
              {columns.map(c => <th key={c.key} className="text-left px-4 py-2 font-black text-slate-600 uppercase tracking-wider">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 20).map((row, i) => (
              <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}>
                {columns.map(c => <td key={c.key} className="px-4 py-2.5 font-semibold text-slate-800">{c.format ? c.format(row[c.key]) : String(row[c.key] ?? '—')}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const LoanTapePanel: React.FC<Props> = ({ clientId, clientName = '', session, aiSettings, onTapesChange }) => {
  const [tapes, setTapes] = useState<LoanTape_DB[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'excel' | 'pdf' | null>(null);
  const [analystStates, setAnalystStates] = useState<Record<string, LoanTapeAnalystState>>({});
  const analystStatesRef = useRef<Record<string, LoanTapeAnalystState>>({});
  const analystSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return () => {
      Object.keys(analystSaveTimers.current).forEach(tapeId => {
        clearTimeout(analystSaveTimers.current[tapeId]);
        void db.updateLoanTape(tapeId, { analystState: analystStatesRef.current[tapeId] });
      });
    };
  }, []);

  const saveAnalystState = (tapeId: string, next: LoanTapeAnalystState, debounce = false) => {
    const normalized = { ...next, updatedAt: new Date().toISOString() };
    analystStatesRef.current = { ...analystStatesRef.current, [tapeId]: normalized };
    setAnalystStates(analystStatesRef.current);
    setTapes(current => current.map(tape => tape.id === tapeId ? { ...tape, analystState: normalized } : tape));

    if (analystSaveTimers.current[tapeId]) clearTimeout(analystSaveTimers.current[tapeId]);
    const persist = () => {
      delete analystSaveTimers.current[tapeId];
      db.updateLoanTape(tapeId, { analystState: analystStatesRef.current[tapeId] })
        .catch(error => console.error('Unable to persist loan tape analyst state.', error));
    };
    if (debounce) analystSaveTimers.current[tapeId] = setTimeout(persist, 500);
    else persist();
  };

  const updateAnalystState = (
    tapeId: string,
    updater: (current: LoanTapeAnalystState) => LoanTapeAnalystState,
    debounce = false,
  ) => {
    const current = analystStatesRef.current[tapeId] || normalizeLoanTapeAnalystState(undefined);
    saveAnalystState(tapeId, updater(current), debounce);
  };

  const handleExport = async (format: 'excel' | 'pdf') => {
    setExporting(format);
    try {
      const { exportLoanTape } = await loadExportModule();
      await exportLoanTape(tapes, clientName, format, format === 'pdf' ? panelRef.current ?? undefined : undefined);
    } finally {
      setExporting(null);
    }
  };

  const loadTapes = async () => {
    const list = await db.getLoanTapes(clientId);
    let legacyBlocks: Record<string, any[]> = {};
    try {
      legacyBlocks = JSON.parse(localStorage.getItem('finmonitor_loan_tape_workspace') || '{}');
    } catch {}
    const migrations: Promise<void>[] = [];
    const hydratedList = list.map(tape => {
      const persisted = normalizeLoanTapeAnalystState(tape.analystState);
      if (persisted.workspaceBlocks.length || !Array.isArray(legacyBlocks[tape.id]) || !legacyBlocks[tape.id].length) return tape;
      const analystState = {
        ...persisted,
        workspaceBlocks: legacyBlocks[tape.id],
        updatedAt: new Date().toISOString(),
      };
      migrations.push(db.updateLoanTape(tape.id, { analystState }));
      return { ...tape, analystState };
    });
    if (migrations.length) {
      const results = await Promise.allSettled(migrations);
      if (results.every(result => result.status === 'fulfilled')) {
        localStorage.removeItem('finmonitor_loan_tape_workspace');
      }
    }
    const loadedStates = Object.fromEntries(hydratedList.map(tape => [tape.id, normalizeLoanTapeAnalystState(tape.analystState)]));
    analystStatesRef.current = loadedStates;
    setAnalystStates(loadedStates);
    setTapes(hydratedList);
    onTapesChange(hydratedList);
    setLoading(false);
  };

  useEffect(() => { loadTapes(); }, [clientId]);

  const saveLoanTapeFile = async (file: File) => {
    if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls') && !file.name.endsWith('.csv')) {
      throw new Error(`${file.name}: solo se aceptan archivos Excel (.xlsx, .xls) o CSV`);
    }
    const buffer = await file.arrayBuffer();
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
    const local = standardizeLoanTape(rows, file.name);

    const headers = rows.length > 0 ? Object.keys(rows[0] as any) : [];
    let tapeType: 'credito' | 'factoraje' | 'otro' = 'otro';
    if (headers.some(h => /factoraje|factor|cedente/i.test(h))) tapeType = 'factoraje';
    else if (headers.some(h => /credito|prestamo|loan|vencimiento|saldo/i.test(h))) tapeType = 'credito';

    const sourceDocument = await db.uploadClientDocument(clientId, file, 'loan_tape', {
      clientName,
      uploadSurface: 'loan_tape_panel',
      rows: rows.length,
      tapeType,
    });

    return db.createLoanTape({
      clientId,
      sourceDocumentId: sourceDocument.id,
      name: file.name.replace(/\.[^.]+$/, ''),
      fileName: file.name,
      tapeType,
      extractedData: { rows, _standardized: local.standardized, _mappingReport: local.mappingReport },
    });
  };

  const handleFilesSelect = async (files: FileList | File[]) => {
    const selected = Array.from(files);
    if (selected.length === 0) return;
    setUploading(true);
    try {
      let lastId: string | null = null;
      for (const file of selected) {
        const tape = await saveLoanTapeFile(file);
        lastId = tape.id;
      }
      if (lastId) setExpanded(lastId);
      await loadTapes();
    } catch (err: any) {
      alert(`Error al procesar archivo: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  const handleAnalyze = async (tape: LoanTape_DB) => {
    setAnalyzing(tape.id);
    try {
      const rows: any[] = Array.isArray(tape.extractedData) ? tape.extractedData : (tape.extractedData?.rows || []);
      const standardized = tape.extractedData?._standardized || standardizeLoanTape(rows, tape.fileName).standardized;
      const baseData = Array.isArray(tape.extractedData)
        ? { rows: tape.extractedData, _standardized: standardized }
        : { ...tape.extractedData, rows, _standardized: standardized };
      const localTapes = tapes.map(t => t.id === tape.id ? { ...t, extractedData: baseData } : t);
      const localAnalysis = analyzeLoanTapesLocally(localTapes, tape.id);
      let analysis = localAnalysis;
      try {
        analysis = { ...localAnalysis, ...(await analyzeLoanTape(aiSettings, rows, clientName || clientId)), portfolioQuality: localAnalysis.portfolioQuality, dpd_distribution: localAnalysis.dpd_distribution, concentrations: localAnalysis.concentrations, anomalies: localAnalysis.anomalies, validation: localAnalysis.validation };
      } catch (error) {
        if (aiSettings.apiKey) throw error;
        console.warn('Loan tape AI analysis unavailable; using local analysis.', error);
      }
      const updatedData = Array.isArray(tape.extractedData)
        ? { rows: tape.extractedData, _standardized: standardized, _analysis: analysis }
        : { ...baseData, _analysis: analysis };
      await db.updateLoanTape(tape.id, { extractedData: updatedData });
      await loadTapes();
    } catch (err: any) {
      alert(`Error al analizar: ${err.message}`);
    } finally {
      setAnalyzing(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar este loan tape?')) return;
    await db.deleteLoanTape(id);
    await loadTapes();
  };

  const askQuickQuestion = (tapeId: string, question: string, standardizedRows: any[], analysis: StructuredLoanTapeAnalysis | null, mappingRows: any[]) => {
    const answer = answerLoanTapeQuestion(question, standardizedRows, analysis, mappingRows);
    updateAnalystState(tapeId, current => ({
      ...current,
      qa: {
        draft: question,
        question,
        answer,
        updatedAt: new Date().toISOString(),
      },
    }));
  };

  const createWorkspaceBlock = (
    tapeId: string,
    prompt: string,
    standardizedRows: any[],
    analysis: StructuredLoanTapeAnalysis | null,
    mappingRows: any[],
  ) => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return;
    const item = createLoanTapeWorkspaceBlock(cleanPrompt, standardizedRows, analysis, mappingRows);
    updateAnalystState(tapeId, current => ({
      ...current,
      workspaceBlocks: [...current.workspaceBlocks, item],
      qa: { ...current.qa, draft: '' },
    }));
  };

  const updateWorkspaceBlockType = (tapeId: string, blockId: string, type: LoanTapeBlockType) => {
    updateAnalystState(tapeId, current => ({
      ...current,
      workspaceBlocks: current.workspaceBlocks.map(item => item.id === blockId ? { ...item, type } : item),
    }));
  };

  const deleteWorkspaceBlock = (tapeId: string, blockId: string) => {
    updateAnalystState(tapeId, current => ({
      ...current,
      workspaceBlocks: current.workspaceBlocks.filter(item => item.id !== blockId),
    }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <svg className="animate-spin h-6 w-6 text-indigo-500" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
      </div>
    );
  }

  return (
    <div ref={panelRef} className="space-y-6">
      <WorkingOverlay
        show={uploading || !!analyzing || !!exporting}
        title={exporting ? 'Exportando' : analyzing ? 'Analizando Loan Tape' : 'Procesando Loan Tape'}
        messages={[
          'Almost there...',
          'Working on it...',
          'Still moving...',
          'One more pass...',
          exporting ? 'Construyendo archivo...' : 'Leyendo columnas y saldos...',
          exporting ? 'Aplicando formato...' : 'Normalizando cartera...',
          exporting ? 'Preparando descarga...' : 'Construyendo dashboard...',
          exporting ? 'Acomodando hojas...' : 'Revisando concentraciones...',
          exporting ? 'Casi queda...' : 'Detectando alertas...',
          exporting ? 'Listo en un momento...' : 'Preparando métricas...',
        ]}
      />
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-black text-slate-900">Loan Tape</h2>
          <p className="text-slate-500 text-sm mt-0.5">{tapes.length} archivo{tapes.length !== 1 ? 's' : ''} cargado{tapes.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex items-center gap-2">
          {tapes.length > 0 && (
            <>
              <button onClick={() => handleExport('excel')} disabled={!!exporting} className="flex items-center gap-1.5 bg-white border border-slate-200 text-slate-600 font-bold px-3 py-2 rounded-xl text-xs hover:bg-slate-50 disabled:opacity-50 transition-all">
                {exporting === 'excel' ? <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg> : <FileSpreadsheet className="w-3.5 h-3.5" />}
                Excel
              </button>
              <button onClick={() => handleExport('pdf')} disabled={!!exporting} className="flex items-center gap-1.5 bg-white border border-slate-200 text-slate-600 font-bold px-3 py-2 rounded-xl text-xs hover:bg-slate-50 disabled:opacity-50 transition-all">
                {exporting === 'pdf' ? <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg> : <FileText className="w-3.5 h-3.5" />}
                PDF
              </button>
            </>
          )}
          <input ref={fileInputRef} type="file" multiple accept=".xlsx,.xls,.csv" className="hidden"
            onChange={e => {
              if (e.target.files?.length) handleFilesSelect(e.target.files);
              e.currentTarget.value = '';
            }} />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-400 text-white font-bold px-4 py-2.5 rounded-xl text-sm transition-all"
          >
            <Upload className="w-4 h-4" />
            {uploading ? 'Procesando...' : 'Subir Loan Tape(s)'}
          </button>
        </div>
      </div>

      {tapes.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center">
          <BarChart3 className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 font-semibold">Sin loan tapes cargados</p>
          <p className="text-slate-400 text-sm mt-1">Sube un Excel con la cartera de crédito</p>
        </div>
      )}

      <div className="space-y-4">
        {tapes.map(tape => {
          const isExpanded = expanded === tape.id;
          const data = tape.extractedData;
          const rows: any[] = Array.isArray(data) ? data : (data?.rows || []);
          const mappingRows: any[] = Array.isArray(data?._mappingReport) ? data._mappingReport : [];
          const standardizedRows: any[] = Array.isArray(data?._standardized) ? data._standardized : [];
          const analysis: StructuredLoanTapeAnalysis | null = data?._analysis || null;
          const profile = buildLoanTapeDataProfile(standardizedRows, mappingRows);
          const analystState = analystStates[tape.id] || normalizeLoanTapeAnalystState(tape.analystState);

          return (
            <div key={tape.id} className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
              {/* Header row */}
              <div className="flex items-center gap-4 px-6 py-4">
                <button onClick={() => setExpanded(isExpanded ? null : tape.id)} className="text-slate-400 hover:text-slate-700 transition-colors">
                  {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                </button>
                <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center flex-shrink-0">
                  <FileSpreadsheet className="w-5 h-5 text-emerald-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-black text-slate-900 text-sm truncate">{tape.name}</h3>
                    <span className={`text-[10px] font-black px-2 py-0.5 rounded-md flex-shrink-0 ${
                      tape.tapeType === 'credito' ? 'bg-blue-100 text-blue-700' :
                      tape.tapeType === 'factoraje' ? 'bg-purple-100 text-purple-700' :
                      'bg-slate-100 text-slate-600'
                    }`}>{tape.tapeType.toUpperCase()}</span>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {new Date(tape.uploadDate).toLocaleDateString('es-MX')} · {rows.length} registros
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {analysis && <StatusBadge status={analysis.overallStatus} />}
                  <button
                    onClick={() => handleAnalyze(tape)}
                    disabled={analyzing === tape.id}
                    className="flex items-center gap-1.5 text-xs bg-indigo-50 border border-indigo-200 text-indigo-700 font-bold px-3 py-1.5 rounded-lg hover:bg-indigo-100 transition-all disabled:opacity-60"
                  >
                    {analyzing === tape.id ? (
                      <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                    ) : <Sparkles className="w-3.5 h-3.5" />}
                    {analyzing === tape.id ? 'Analizando...' : analysis ? 'Actualizar análisis' : 'Analizar'}
                  </button>
                  <button onClick={() => handleDelete(tape.id)} className="text-slate-300 hover:text-rose-500 transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Expanded: analysis */}
              {isExpanded && analysis && (
                <div className="border-t border-slate-100 p-6 bg-slate-50 space-y-6">
                  <div className="bg-slate-900 text-white rounded-2xl border border-slate-800 overflow-hidden">
                    <div className="grid grid-cols-1 xl:grid-cols-3">
                      <div className="p-5 border-b xl:border-b-0 xl:border-r border-white/10">
                        <div className="flex items-center gap-2 mb-3">
                          <Bot className="w-4 h-4 text-indigo-300" />
                          <p className="text-xs font-black uppercase tracking-widest text-indigo-200">Julius-style Data Check</p>
                        </div>
                        <div className="flex items-end gap-3">
                          <p className="text-4xl font-black">{profile.readinessScore}</p>
                          <p className="text-xs font-bold text-slate-300 mb-1">/100 preparación</p>
                        </div>
                        <p className="text-xs text-slate-300 mt-3 leading-relaxed">
                          {profile.canAnalyze
                            ? 'El tape se puede analizar, pero revisa huecos antes de tomar decisiones de crédito.'
                            : 'Faltan campos base; el análisis puede verse bonito pero no sería confiable todavía.'}
                        </p>
                      </div>
                      <div className="p-5 border-b xl:border-b-0 xl:border-r border-white/10">
                        <p className="text-xs font-black uppercase tracking-widest text-slate-300 mb-3">Qué falta realmente</p>
                        <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
                          {profile.missingFields.filter(f => f.severity !== 'low').slice(0, 6).map(f => (
                            <div key={f.field} className="bg-white/5 border border-white/10 rounded-xl p-3">
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-xs font-black text-white">{f.field}</p>
                                <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${f.severity === 'high' ? 'bg-rose-400/20 text-rose-100' : 'bg-amber-400/20 text-amber-100'}`}>
                                  {f.mapped ? `${(f.missingPct * 100).toFixed(0)}% vacío` : 'NO MAPEADO'}
                                </span>
                              </div>
                              <p className="text-[11px] text-slate-300 mt-1">{f.impact}</p>
                            </div>
                          ))}
                          {profile.missingFields.every(f => f.severity === 'low') && (
                            <p className="text-sm font-semibold text-emerald-200">No hay campos críticos faltantes relevantes.</p>
                          )}
                        </div>
                      </div>
                      <div className="p-5">
                        <p className="text-xs font-black uppercase tracking-widest text-slate-300 mb-1">Construye con el chat</p>
                        <p className="text-[11px] text-slate-400 mb-3">Pide una tabla, KPI o gráfica y se añadirá al workspace.</p>
                        <div className="flex gap-2">
                          <input
                            value={analystState.qa.draft}
                            onChange={e => updateAnalystState(tape.id, current => ({
                              ...current,
                              qa: { ...current.qa, draft: e.target.value },
                            }), true)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') createWorkspaceBlock(tape.id, analystState.qa.draft, standardizedRows, analysis, mappingRows);
                            }}
                            placeholder='Ej. "gráfica de mora por DPD"'
                            className="min-w-0 flex-1 bg-white/10 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder:text-slate-400 outline-none focus:border-indigo-300"
                          />
                          <button
                            onClick={() => createWorkspaceBlock(tape.id, analystState.qa.draft, standardizedRows, analysis, mappingRows)}
                            className="bg-indigo-500 hover:bg-indigo-400 text-white rounded-xl px-3 flex items-center justify-center transition-all"
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {BLOCK_PROMPTS.map(question => (
                            <button
                              key={question}
                              onClick={() => createWorkspaceBlock(tape.id, question, standardizedRows, analysis, mappingRows)}
                              className="text-[10px] font-black uppercase tracking-wide text-slate-200 bg-white/10 hover:bg-white/15 border border-white/10 rounded-full px-2.5 py-1 transition-all"
                            >
                              {question}
                            </button>
                          ))}
                        </div>
                        <div className="mt-3 bg-black/20 border border-white/10 rounded-xl p-3 flex items-center gap-3">
                          <LayoutDashboard className="w-5 h-5 text-indigo-300" />
                          <div>
                            <p className="text-sm font-black">{analystState.workspaceBlocks.length} bloques</p>
                            <p className="text-[10px] text-slate-400">Guardados con este loan tape</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-5">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <Bot className="w-4 h-4 text-indigo-600" />
                          <p className="text-xs font-black uppercase tracking-widest text-indigo-900">Workspace de análisis</p>
                        </div>
                        <p className="text-xs text-indigo-700 mt-1">Cada mensaje crea un bloque nuevo; puedes cambiarlo entre tabla, barras, línea o dona.</p>
                      </div>
                      <button
                        onClick={() => createWorkspaceBlock(tape.id, 'Resumen ejecutivo', standardizedRows, analysis, mappingRows)}
                        className="flex items-center gap-1.5 bg-indigo-600 text-white rounded-xl px-3 py-2 text-xs font-black hover:bg-indigo-500"
                      >
                        <Plus className="w-3.5 h-3.5" /> Nuevo bloque
                      </button>
                    </div>
                  </div>

                  {analystState.workspaceBlocks.length > 0 && (
                    <div className="space-y-4">
                      {analystState.workspaceBlocks.map(item => (
                        <Suspense
                          key={item.id}
                          fallback={<div className="h-48 animate-pulse rounded-2xl border border-slate-200 bg-white" />}
                        >
                          <WorkspaceBlock
                            item={item}
                            onDelete={() => deleteWorkspaceBlock(tape.id, item.id)}
                            onTypeChange={type => updateWorkspaceBlockType(tape.id, item.id, type)}
                          />
                        </Suspense>
                      ))}
                    </div>
                  )}

                  {/* Risk score + summary */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="bg-white rounded-xl p-5 border border-slate-200 flex flex-col items-center justify-center">
                      <p className="text-xs font-black text-slate-500 uppercase tracking-widest mb-2">Riesgo</p>
                      <RiskGauge score={analysis.riskScore} />
                      <div className="mt-2"><StatusBadge status={analysis.overallStatus} /></div>
                    </div>
                    <div className="md:col-span-2 bg-white rounded-xl p-5 border border-slate-200">
                      <div className="flex items-center gap-2 mb-2">
                        <p className="text-xs font-black text-slate-700 uppercase tracking-widest">Resumen Ejecutivo</p>
                        <TrendIcon trend={analysis.trendDirection} />
                      </div>
                      <p className="text-sm text-slate-700 leading-relaxed">{analysis.executiveSummary}</p>
                    </div>
                  </div>

                  {analysis.portfolioQuality && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      {Object.entries(analysis.portfolioQuality).map(([name, item]) => (
                        <div key={name} className="bg-white border border-slate-200 rounded-xl p-4">
                          <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{name}</p>
                          <p className="text-lg font-black text-slate-900 mt-1">{fmtMoney(item.balance)}</p>
                          <p className="text-xs text-slate-500 font-semibold">{item.count} créditos · {fmtPct(item.pct)}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  <SmallDataTable
                    title="Distribución DPD"
                    rows={analysis.dpd_distribution}
                    columns={[
                      { key: 'bucket', label: 'Bucket' },
                      { key: 'count', label: 'Créditos' },
                      { key: 'balance', label: 'Saldo', format: fmtMoney },
                      { key: 'pct', label: '%', format: fmtPct },
                    ]}
                  />

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <SmallDataTable
                      title="Concentración por Cliente"
                      rows={analysis.concentrations?.by_client}
                      columns={[
                        { key: 'name', label: 'Cliente' },
                        { key: 'count', label: 'Créditos' },
                        { key: 'balance', label: 'Saldo', format: fmtMoney },
                        { key: 'pct', label: '%', format: fmtPct },
                      ]}
                    />
                    <SmallDataTable
                      title="Concentración por Producto"
                      rows={analysis.concentrations?.by_loan_type}
                      columns={[
                        { key: 'name', label: 'Producto' },
                        { key: 'count', label: 'Créditos' },
                        { key: 'balance', label: 'Saldo', format: fmtMoney },
                        { key: 'pct', label: '%', format: fmtPct },
                        { key: 'avg_interest_rate', label: 'Tasa Prom.', format: fmtNum },
                        { key: 'avg_days_overdue', label: 'DPD Prom.', format: fmtNum },
                      ]}
                    />
                  </div>

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <SmallDataTable
                      title="Concentración por Estado"
                      rows={analysis.concentrations?.by_state}
                      columns={[
                        { key: 'name', label: 'Estado' },
                        { key: 'count', label: 'Créditos' },
                        { key: 'balance', label: 'Saldo', format: fmtMoney },
                        { key: 'pct', label: '%', format: fmtPct },
                      ]}
                    />
                    <SmallDataTable
                      title="Concentración por Industria"
                      rows={analysis.concentrations?.by_industry}
                      columns={[
                        { key: 'name', label: 'Industria' },
                        { key: 'count', label: 'Créditos' },
                        { key: 'balance', label: 'Saldo', format: fmtMoney },
                        { key: 'pct', label: '%', format: fmtPct },
                      ]}
                    />
                  </div>

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <SmallDataTable
                      title="Buckets por Saldo"
                      rows={analysis.concentrations?.buckets_outstanding}
                      columns={[
                        { key: 'bucket', label: 'Bucket' },
                        { key: 'count', label: 'Créditos' },
                        { key: 'balance', label: 'Saldo', format: fmtMoney },
                        { key: 'pct', label: '%', format: fmtPct },
                      ]}
                    />
                    <SmallDataTable
                      title="Buckets por Línea"
                      rows={analysis.concentrations?.buckets_amount}
                      columns={[
                        { key: 'bucket', label: 'Bucket' },
                        { key: 'count', label: 'Créditos' },
                        { key: 'balance', label: 'Monto', format: fmtMoney },
                        { key: 'pct', label: '%', format: fmtPct },
                      ]}
                    />
                  </div>

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <SmallDataTable
                      title="Anomalías: Nuevos Créditos"
                      rows={analysis.anomalies?.new_loans}
                      columns={[
                        { key: 'loan_id', label: 'Crédito' },
                        { key: 'outstanding_balance', label: 'Saldo', format: fmtMoney },
                        { key: 'start_date', label: 'Inicio' },
                        { key: 'category', label: 'Categoría' },
                        { key: 'percentage', label: '%', format: fmtPct },
                      ]}
                    />
                    <SmallDataTable
                      title="Anomalías: Deterioro DPD"
                      rows={analysis.anomalies?.dpd_deterioration}
                      columns={[
                        { key: 'loan_id', label: 'Crédito' },
                        { key: 'days_overdue_prev', label: 'DPD Ant.' },
                        { key: 'days_overdue_latest', label: 'DPD Act.' },
                      ]}
                    />
                  </div>

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <SmallDataTable
                      title="Anomalías: Créditos que Desaparecen"
                      rows={analysis.anomalies?.disappeared_loans}
                      columns={[
                        { key: 'loan_id', label: 'Crédito' },
                        { key: 'outstanding_balance', label: 'Saldo', format: fmtMoney },
                        { key: 'end_date', label: 'Vencimiento' },
                        { key: 'category', label: 'Categoría' },
                        { key: 'percentage', label: '%', format: fmtPct },
                      ]}
                    />
                    <SmallDataTable
                      title="Anomalías: Vencidos aún Activos"
                      rows={analysis.anomalies?.ended_loans}
                      columns={[
                        { key: 'loan_id', label: 'Crédito' },
                        { key: 'outstanding_balance', label: 'Saldo', format: fmtMoney },
                        { key: 'end_date', label: 'Vencimiento' },
                        { key: 'days_overdue', label: 'DPD' },
                      ]}
                    />
                  </div>

                  <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                    <SmallDataTable
                      title="DPD Mejora"
                      rows={analysis.anomalies?.dpd_improvement}
                      columns={[
                        { key: 'loan_id', label: 'Crédito' },
                        { key: 'days_overdue_prev', label: 'DPD Ant.' },
                        { key: 'days_overdue_latest', label: 'DPD Act.' },
                      ]}
                    />
                    <SmallDataTable
                      title="DPD Inconsistente"
                      rows={analysis.anomalies?.dpd_inconsistency}
                      columns={[
                        { key: 'loan_id', label: 'Crédito' },
                        { key: 'delta_days_overdue', label: 'Delta' },
                        { key: 'category', label: 'Categoría' },
                      ]}
                    />
                    <SmallDataTable
                      title="Cambios de Condición"
                      rows={analysis.anomalies?.condition_changes}
                      columns={[
                        { key: 'loan_id', label: 'Crédito' },
                        { key: 'field_changed', label: 'Campo' },
                        { key: 'value_prev', label: 'Anterior' },
                        { key: 'value_latest', label: 'Actual' },
                      ]}
                    />
                  </div>

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <SmallDataTable
                      title="Mapeo de Columnas"
                      rows={mappingRows}
                      columns={[
                        { key: 'source_header', label: 'Columna Fuente' },
                        { key: 'target_term', label: 'Campo Estándar' },
                        { key: 'confidence', label: 'Confianza' },
                        { key: 'reasoning', label: 'Razón' },
                      ]}
                    />
                    <SmallDataTable
                      title="Datos Estandarizados"
                      rows={standardizedRows}
                      columns={[
                        { key: 'loan_id', label: 'Crédito' },
                        { key: 'client', label: 'Cliente' },
                        { key: 'outstanding_balance', label: 'Saldo', format: fmtMoney },
                        { key: 'days_overdue', label: 'DPD' },
                        { key: 'file_date', label: 'Fecha Corte' },
                      ]}
                    />
                  </div>

                  <SmallDataTable
                    title="Validación de Datos"
                    rows={analysis.validation}
                    columns={[
                      { key: 'loan_id', label: 'Crédito' },
                      { key: 'rule_id', label: 'Regla' },
                      { key: 'field', label: 'Campo' },
                      { key: 'message', label: 'Detalle' },
                    ]}
                  />

                  {/* Metrics table */}
                  {analysis.metrics?.length > 0 && (
                    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                      <div className="px-5 py-3 border-b border-slate-100">
                        <p className="text-xs font-black text-slate-700 uppercase tracking-widest">Métricas de Cartera</p>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-slate-50">
                              <th className="text-left px-4 py-2 font-black text-slate-600 uppercase tracking-wider">Métrica</th>
                              <th className="text-right px-4 py-2 font-black text-slate-600 uppercase tracking-wider">Valor Actual</th>
                              <th className="text-right px-4 py-2 font-black text-slate-600 uppercase tracking-wider">Anterior</th>
                              <th className="text-right px-4 py-2 font-black text-slate-600 uppercase tracking-wider">Cambio</th>
                              <th className="text-center px-4 py-2 font-black text-slate-600 uppercase tracking-wider">Tendencia</th>
                              <th className="text-right px-4 py-2 font-black text-slate-600 uppercase tracking-wider">Límite</th>
                              <th className="text-center px-4 py-2 font-black text-slate-600 uppercase tracking-wider">Estado</th>
                            </tr>
                          </thead>
                          <tbody>
                            {analysis.metrics.map((m, i) => (
                              <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}>
                                <td className="px-4 py-2.5 font-semibold text-slate-800">{m.name}</td>
                                <td className="px-4 py-2.5 text-right font-mono font-bold text-slate-900">{m.latestValue}</td>
                                <td className="px-4 py-2.5 text-right font-mono text-slate-500">{m.previousValue || '—'}</td>
                                <td className="px-4 py-2.5 text-right font-mono text-slate-500">{m.change || '—'}</td>
                                <td className="px-4 py-2.5 text-center">
                                  <div className="flex justify-center"><TrendIcon trend={m.trend} /></div>
                                </td>
                                <td className="px-4 py-2.5 text-right font-mono text-slate-500">{m.contractLimit || '—'}</td>
                                <td className="px-4 py-2.5 text-center">
                                  <div className="flex justify-center"><MetricStatus status={m.status} /></div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Findings */}
                  {analysis.findings?.length > 0 && (
                    <div>
                      <p className="text-xs font-black text-slate-700 uppercase tracking-widest mb-3">Hallazgos</p>
                      <div className="space-y-2">
                        {analysis.findings.map((f, i) => (
                          <div key={i} className={`rounded-xl px-4 py-3 border ${SEVERITY_COLORS[f.severity] || SEVERITY_COLORS.low}`}>
                            <div className="flex items-start gap-3">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-0.5">
                                  <span className="text-[10px] font-black uppercase tracking-wider opacity-60">{f.category}</span>
                                  <span className={`text-[10px] font-black px-1.5 py-0.5 rounded ${
                                    f.severity === 'high' ? 'bg-rose-200 text-rose-900' :
                                    f.severity === 'medium' ? 'bg-amber-200 text-amber-900' :
                                    'bg-slate-200 text-slate-800'
                                  }`}>{f.severity.toUpperCase()}</span>
                                </div>
                                <p className="text-sm font-bold">{f.title}</p>
                                <p className="text-xs mt-0.5 opacity-80">{f.detail}</p>
                                {f.recommendation && (
                                  <p className="text-xs mt-1 font-semibold opacity-70">→ {f.recommendation}</p>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Congruency checks */}
                  {analysis.congruencyChecks?.length > 0 && (
                    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                      <div className="px-5 py-3 border-b border-slate-100">
                        <p className="text-xs font-black text-slate-700 uppercase tracking-widest">Verificación de Congruencia</p>
                      </div>
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-slate-50">
                            <th className="text-left px-4 py-2 font-black text-slate-600 uppercase tracking-wider">Indicador</th>
                            <th className="text-right px-4 py-2 font-black text-slate-600 uppercase tracking-wider">Requerido</th>
                            <th className="text-right px-4 py-2 font-black text-slate-600 uppercase tracking-wider">Real</th>
                            <th className="text-center px-4 py-2 font-black text-slate-600 uppercase tracking-wider">Estado</th>
                          </tr>
                        </thead>
                        <tbody>
                          {analysis.congruencyChecks.map((c, i) => (
                            <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}>
                              <td className="px-4 py-2.5 font-semibold text-slate-800">{c.item}</td>
                              <td className="px-4 py-2.5 text-right font-mono text-slate-500">{c.contractRequirement || '—'}</td>
                              <td className="px-4 py-2.5 text-right font-mono font-bold text-slate-900">{c.actualValue}</td>
                              <td className="px-4 py-2.5 text-center">
                                <span className={`text-[10px] font-black px-2 py-0.5 rounded ${
                                  c.status === 'pass' ? 'bg-emerald-100 text-emerald-800' :
                                  c.status === 'fail' ? 'bg-rose-100 text-rose-800' :
                                  'bg-slate-100 text-slate-600'
                                }`}>
                                  {c.status === 'pass' ? 'CUMPLE' : c.status === 'fail' ? 'INCUMPLE' : 'N/A'}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Expanded: no analysis */}
              {isExpanded && !analysis && (
                <div className="border-t border-slate-100 p-6 bg-slate-50 space-y-4">
                  <div className="bg-white rounded-2xl border border-slate-200 p-5">
                    <div className="flex items-center justify-between gap-4 mb-4">
                      <div>
                        <p className="text-xs font-black text-slate-700 uppercase tracking-widest">Diagnóstico antes de analizar</p>
                        <p className="text-sm text-slate-500 mt-1">{rows.length} registros cargados · preparación {profile.readinessScore}/100</p>
                      </div>
                      <StatusBadge status={profile.readinessScore >= 80 ? 'good' : profile.readinessScore >= 55 ? 'warning' : 'critical'} />
                    </div>
                    <SmallDataTable
                      title="Campos críticos faltantes"
                      rows={profile.missingFields.filter(f => f.severity !== 'low')}
                      columns={[
                        { key: 'field', label: 'Campo' },
                        { key: 'mapped', label: 'Mapeado', format: v => v ? 'Sí' : 'No' },
                        { key: 'missingPct', label: '% Vacío', format: v => fmtPct(v || 0) },
                        { key: 'impact', label: 'Impacto' },
                      ]}
                    />
                    {profile.nextActions.length > 0 && (
                      <div className="mt-4">
                        <p className="text-xs font-black text-slate-700 uppercase tracking-widest mb-2">Siguiente mejor acción</p>
                        <div className="space-y-2">
                          {profile.nextActions.map((item, index) => (
                            <p key={index} className="text-xs font-semibold text-slate-600 bg-slate-50 border border-slate-100 rounded-xl px-3 py-2">{item}</p>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="mt-4 flex flex-wrap gap-2">
                      {QUICK_QUESTIONS.slice(0, 3).map(question => (
                        <button
                          key={question}
                          onClick={() => askQuickQuestion(tape.id, question, standardizedRows, analysis, mappingRows)}
                          className="text-[10px] font-black uppercase tracking-wide text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 rounded-full px-3 py-1.5 transition-all"
                        >
                          {question}
                        </button>
                      ))}
                    </div>
                  </div>
                  {analystState.qa.answer && (
                    <div className="bg-slate-900 text-white rounded-2xl border border-slate-800 p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <Bot className="w-4 h-4 text-indigo-300" />
                        <p className="text-xs font-black uppercase tracking-widest text-indigo-200">Respuesta rápida</p>
                      </div>
                      {analystState.qa.question && (
                        <p className="text-[10px] font-black uppercase tracking-wide text-slate-400 mb-2">{analystState.qa.question}</p>
                      )}
                      <pre className="text-xs leading-relaxed whitespace-pre-wrap font-sans text-slate-100">{analystState.qa.answer}</pre>
                    </div>
                  )}
                  <div className="text-center py-4">
                    <BarChart3 className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                    <p className="text-slate-500 text-sm font-semibold">Haz clic en "Analizar" para generar métricas, anomalías y chat local</p>
                    <p className="text-slate-400 text-xs mt-1">El diagnóstico ya te dice si el tape trae lo necesario.</p>
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

export default LoanTapePanel;
