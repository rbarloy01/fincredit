import React, { useState, useEffect, useRef } from 'react';
import { db, LoanTape_DB } from '../../db/index';
import { Session } from '../../services/auth';
import { AISettings, analyzeLoanTape, StructuredLoanTapeAnalysis } from '../../services/ai';
import {
  Upload, Trash2, Sparkles, TrendingUp, TrendingDown, Minus,
  BarChart3, FileSpreadsheet, ChevronDown, ChevronRight,
  ShieldCheck, ShieldAlert, ShieldX, AlertTriangle, CheckCircle, XCircle,
  Download, FileText,
} from 'lucide-react';
import { exportLoanTape } from '../../lib/export';
import { analyzeLoanTapesLocally, standardizeLoanTape } from '../../lib/loanTapeAnalytics';
import * as XLSX from 'xlsx';
import WorkingOverlay from '../common/WorkingOverlay';

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleExport = async (format: 'excel' | 'pdf') => {
    setExporting(format);
    try {
      await exportLoanTape(tapes, clientName, format, format === 'pdf' ? panelRef.current ?? undefined : undefined);
    } finally {
      setExporting(null);
    }
  };

  const loadTapes = async () => {
    const list = await db.getLoanTapes(clientId);
    setTapes(list);
    onTapesChange(list);
    setLoading(false);
  };

  useEffect(() => { loadTapes(); }, [clientId]);

  const saveLoanTapeFile = async (file: File) => {
    if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls') && !file.name.endsWith('.csv')) {
      throw new Error(`${file.name}: solo se aceptan archivos Excel (.xlsx, .xls) o CSV`);
    }
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
    const local = standardizeLoanTape(rows, file.name);

    const headers = rows.length > 0 ? Object.keys(rows[0] as any) : [];
    let tapeType: 'credito' | 'factoraje' | 'otro' = 'otro';
    if (headers.some(h => /factoraje|factor|cedente/i.test(h))) tapeType = 'factoraje';
    else if (headers.some(h => /credito|prestamo|loan|vencimiento|saldo/i.test(h))) tapeType = 'credito';

    return db.createLoanTape({
      clientId,
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
      const analysis = aiSettings.apiKey
        ? { ...localAnalysis, ...(await analyzeLoanTape(aiSettings, rows, clientName || clientId)), portfolioQuality: localAnalysis.portfolioQuality, dpd_distribution: localAnalysis.dpd_distribution, concentrations: localAnalysis.concentrations, anomalies: localAnalysis.anomalies, validation: localAnalysis.validation }
        : localAnalysis;
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
                    {analyzing === tape.id ? 'Analizando...' : 'Analizar'}
                  </button>
                  <button onClick={() => handleDelete(tape.id)} className="text-slate-300 hover:text-rose-500 transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Expanded: analysis */}
              {isExpanded && analysis && (
                <div className="border-t border-slate-100 p-6 bg-slate-50 space-y-6">
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
                <div className="border-t border-slate-100 p-6 bg-slate-50">
                  <div className="text-center py-6">
                    <BarChart3 className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                    <p className="text-slate-500 text-sm font-semibold">{rows.length} registros cargados</p>
                    <p className="text-slate-400 text-xs mt-1">Haz clic en "Analizar" para generar el análisis de cartera con IA</p>
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
