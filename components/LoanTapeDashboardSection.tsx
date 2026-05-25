import React, { useRef } from 'react';
import { Company, LoanTapeSnapshot } from '../types';
import { GeminiService, MonitoreoExtraction, StructuredLoanTapeAnalysis } from '../services/geminiService';
import {
  FileSpreadsheet, Image as ImageIcon, Trash2, Plus, Upload, X,
  AlertTriangle, TrendingUp, TrendingDown, Minus, ShieldCheck, ShieldAlert,
  ShieldX, BarChart3, Activity, Pencil, CheckCircle2, ChevronRight,
  Zap, AlertCircle, Info, RefreshCw
} from 'lucide-react';

interface LoanTapeDashboardSectionProps {
  company: Company;
  onUpdateCompany: (updated: Company) => void;
  gemini: GeminiService;
}

// ─── Mini helpers ─────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
    ? `$${(n / 1_000).toFixed(1)}K`
    : `$${n.toLocaleString('es-MX')}`;

const pct = (n: number) => `${n.toFixed(2)}%`;

function TrendIcon({ trend, positive }: { trend: string; positive?: boolean }) {
  // positive=true means "up is good" (balance), positive=false means "up is bad" (mora)
  if (trend === 'up') {
    const good = positive !== false;
    return <TrendingUp className={`w-3.5 h-3.5 ${good ? 'text-emerald-400' : 'text-rose-400'}`} />;
  }
  if (trend === 'down') {
    const good = positive === false;
    return <TrendingDown className={`w-3.5 h-3.5 ${good ? 'text-emerald-400' : 'text-rose-400'}`} />;
  }
  return <Minus className="w-3.5 h-3.5 text-slate-400" />;
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    good: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    warning: 'bg-amber-50 text-amber-700 border-amber-200',
    critical: 'bg-rose-50 text-rose-700 border-rose-200',
    pass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    fail: 'bg-rose-50 text-rose-700 border-rose-200',
    unknown: 'bg-slate-50 text-slate-600 border-slate-200',
  };
  const label: Record<string, string> = {
    good: 'CUMPLE', warning: 'ALERTA', critical: 'CRÍTICO',
    pass: 'OK', fail: 'FALLA', unknown: 'N/D',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-black tracking-widest border ${map[status] ?? map.unknown}`}>
      {label[status] ?? status}
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
        {/* Track */}
        <path d="M 10 65 A 50 50 0 0 1 110 65" fill="none" stroke="#F1F5F9" strokeWidth="10" strokeLinecap="round" />
        {/* Fill — green segment */}
        <path d="M 10 65 A 50 50 0 0 1 110 65" fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
          strokeDasharray={`${(clamped / 100) * 157} 157`} style={{ opacity: 0.2 }} />
        {/* Needle */}
        <g transform={`translate(60 65) rotate(${rotation})`}>
          <line x1="0" y1="0" x2="0" y2="-38" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="0" cy="0" r="4" fill={color} />
        </g>
        {/* Score label */}
        <text x="60" y="58" textAnchor="middle" fontSize="13" fontWeight="900" fill="#1E293B">{clamped}</text>
      </svg>
    </div>
  );
}

const FindingCard: React.FC<{ finding: any }> = ({ finding }) => {
  const colors = {
    critical: { bg: 'bg-rose-50 border-rose-100', icon: 'text-rose-600', badge: 'bg-rose-100 text-rose-700' },
    warning:  { bg: 'bg-amber-50 border-amber-100', icon: 'text-amber-600', badge: 'bg-amber-100 text-amber-700' },
    info:     { bg: 'bg-blue-50 border-blue-100', icon: 'text-blue-600', badge: 'bg-blue-100 text-blue-700' },
  };
  const c = colors[finding.severity as keyof typeof colors] ?? colors.info;
  const Icon = finding.severity === 'critical' ? ShieldX : finding.severity === 'warning' ? AlertCircle : Info;

  return (
    <div className={`rounded-2xl border p-4 ${c.bg}`}>
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 flex-shrink-0 ${c.icon}`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className={`text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-md ${c.badge}`}>
              {finding.category}
            </span>
            <span className="text-[11px] font-bold text-slate-900 leading-tight">{finding.title}</span>
          </div>
          <p className="text-[11px] text-slate-600 leading-relaxed">{finding.detail}</p>
          {finding.recommendation && (
            <div className="mt-2 flex items-start gap-1.5">
              <ChevronRight className="w-3 h-3 text-slate-400 flex-shrink-0 mt-0.5" />
              <p className="text-[10px] text-slate-500 italic">{finding.recommendation}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

const LoanTapeDashboardSection: React.FC<LoanTapeDashboardSectionProps> = ({
  company, onUpdateCompany, gemini,
}) => {
  const [isParsingExcel, setIsParsingExcel] = React.useState(false);
  const [isAnalyzing, setIsAnalyzing] = React.useState(false);
  const [parseError, setParseError] = React.useState<string | null>(null);
  const [editingNotes, setEditingNotes] = React.useState(false);
  const excelInputRef = useRef<HTMLInputElement>(null);

  const snapshots: LoanTapeSnapshot[] = Array.isArray(company.loanTapeSnapshots) ? company.loanTapeSnapshots : [];
  const monitoreo: MonitoreoExtraction | null = (company as any).monitoreoData ?? null;
  const analysis: StructuredLoanTapeAnalysis | null = (company as any).loanTapeStructuredAnalysis ?? null;
  const analystNotes: string = (company as any).loanTapeAnalystNotes ?? '';

  // ── Snapshot CRUD ─────────────────────────────────────────────────────────

  const updateSnapshot = (id: string, field: keyof LoanTapeSnapshot, value: any) => {
    onUpdateCompany({ ...company, loanTapeSnapshots: snapshots.map(s => s.id === id ? { ...s, [field]: value } : s) });
  };

  const addSnapshot = () => {
    const s: LoanTapeSnapshot = {
      id: crypto.randomUUID(),
      name: `Cierre ${new Date().toLocaleString('es-ES', { month: 'long', year: 'numeric' })}`,
      date: new Date().toISOString().split('T')[0],
      totalPoolBalance: 0, loanCount: 0, avgBalance: 0, avgApr: 0,
      weightedAvgLife: 0, delinquency30Plus: 0, delinquency60Plus: 0,
      delinquency90Plus: 0, lastUpdated: new Date().toISOString(),
    };
    onUpdateCompany({ ...company, loanTapeSnapshots: [...snapshots, s] });
  };

  const deleteSnapshot = (id: string) =>
    onUpdateCompany({ ...company, loanTapeSnapshots: snapshots.filter(s => s.id !== id) });

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>, snapshotId: string) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => updateSnapshot(snapshotId, 'chartImage', reader.result as string);
    reader.readAsDataURL(file);
  };

  // ── Excel upload ──────────────────────────────────────────────────────────

  const handleMonitoreoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsParsingExcel(true);
    setParseError(null);
    try {
      const buffer = await file.arrayBuffer();
      const extraction = gemini.parseMonitoreoExcel(buffer);
      if (extraction.rows.length === 0) throw new Error('No se encontraron filas de covenants.');
      onUpdateCompany({ ...company, monitoreoData: extraction } as any);
    } catch (err: any) {
      setParseError(err?.message ?? 'Error al leer el archivo.');
    } finally {
      setIsParsingExcel(false);
      if (excelInputRef.current) excelInputRef.current.value = '';
    }
  };

  // ── AI Analysis ───────────────────────────────────────────────────────────

  const runAnalysis = async () => {
    if (snapshots.length === 0) return;
    setIsAnalyzing(true);
    try {
      const contractSummary = `
        Contrato: ${company.contractName}
        Monto Máximo: ${company.maxAmount?.toLocaleString() ?? 'N/D'}
        Covenants Financieros: ${company.covenants?.map(c => `${c.name} (${c.threshold})`).join(', ') || 'Ninguno registrado'}
        Obligaciones de Hacer: ${company.condicionesHacer?.slice(0, 5).map(c => c.name).join(', ') || 'Ninguna'}
        Obligaciones de No Hacer: ${company.condicionesNoHacer?.slice(0, 5).map(c => c.name).join(', ') || 'Ninguna'}
        Aforo Requerido: ${company.aforoRequerido ?? 'N/D'}
      `;
      const result = await gemini.analyzeLoanTapeStructured(
        snapshots,
        contractSummary,
        monitoreo?.rows
      );
      onUpdateCompany({ ...company, loanTapeStructuredAnalysis: result } as any);
    } catch (err) {
      console.error('Analysis failed:', err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  // ── Analyst notes ─────────────────────────────────────────────────────────

  const saveNotes = (val: string) => {
    onUpdateCompany({ ...company, loanTapeAnalystNotes: val } as any);
    setEditingNotes(false);
  };

  // ── Overall status badge ──────────────────────────────────────────────────

  const statusMap = {
    CUMPLE: { bg: 'bg-emerald-500', label: 'CUMPLE', Icon: ShieldCheck },
    ALERTA: { bg: 'bg-amber-500', label: 'ALERTA', Icon: ShieldAlert },
    INCUMPLIMIENTO: { bg: 'bg-rose-500', label: 'INCUMPLIMIENTO', Icon: ShieldX },
  };
  const trendMap = {
    MEJORA: { color: 'text-emerald-600', Icon: TrendingUp },
    ESTABLE: { color: 'text-slate-500', Icon: Minus },
    DETERIORO: { color: 'text-rose-600', Icon: TrendingDown },
  };

  const statusInfo = analysis ? (statusMap[analysis.overallStatus] ?? statusMap.ALERTA) : null;
  const trendInfo = analysis ? (trendMap[analysis.trendDirection] ?? trendMap.ESTABLE) : null;

  return (
    <div className="space-y-8">

      {/* ═══════════════════════════════════════════════════════════
          SECTION 1 — Snapshot cards
      ═══════════════════════════════════════════════════════════ */}
      <div className="bg-white rounded-[2rem] border border-slate-200 shadow-sm overflow-hidden">
        {/* Card header */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center px-8 pt-8 pb-6 gap-4 bg-blue-50/30">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-bluebonnet rounded-xl flex items-center justify-center text-white">
              <FileSpreadsheet className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-xl font-black text-slate-900 tracking-tight">Snapshots de Cartera</h3>
              <p className="text-[10px] font-bold text-bluebonnet uppercase tracking-widest">Registros periódicos de Loan Tape</p>
            </div>
          </div>
          <button
            onClick={addSnapshot}
            className="bg-bluebonnet text-white px-5 py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-blue-700 transition-all shadow-lg shadow-blue-900/20 active:scale-95 flex items-center gap-2 flex-shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            Nuevo Período
          </button>
        </div>

        {/* Divider */}
        <div className="h-px bg-slate-100 mx-8" />

        {/* Cards grid */}
        <div className="p-8">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {snapshots.map((s) => (
              <div key={s.id} className="group relative bg-slate-50 hover:bg-white border border-slate-100 hover:border-slate-200 hover:shadow-xl hover:shadow-slate-100 rounded-[1.5rem] p-5 transition-all duration-200">

                {/* Delete */}
                <button
                  onClick={() => deleteSnapshot(s.id)}
                  className="absolute top-3.5 right-3.5 w-7 h-7 flex items-center justify-center rounded-xl bg-white border border-slate-100 text-slate-300 hover:text-rose-500 hover:border-rose-200 opacity-0 group-hover:opacity-100 transition-all shadow-sm"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>

                {/* Name + date row */}
                <div className="flex items-center gap-2 mb-4 pr-8">
                  <div className="flex-1 bg-white rounded-xl px-3 py-1.5 border border-slate-100 shadow-sm">
                    <input
                      type="text"
                      value={s.name}
                      onChange={e => updateSnapshot(s.id, 'name', e.target.value)}
                      className="bg-transparent w-full text-xs font-black text-slate-800 outline-none"
                    />
                  </div>
                  <input
                    type="date"
                    value={s.date}
                    onChange={e => updateSnapshot(s.id, 'date', e.target.value)}
                    className="text-[10px] font-bold text-slate-400 bg-transparent outline-none border-none"
                  />
                </div>

                <div className="flex gap-4">
                  {/* Left: metrics */}
                  <div className="flex-1 space-y-4">
                    {/* Balance + count */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-white rounded-2xl border border-slate-100 p-3.5 shadow-sm hover:border-blue-200 transition-colors">
                        <p className="text-[7.5px] font-black text-slate-400 uppercase tracking-widest mb-1">Pool Balance</p>
                        <div className="flex items-baseline gap-0.5">
                          <span className="text-[9px] text-slate-300 font-black">$</span>
                          <input
                            type="number"
                            value={s.totalPoolBalance}
                            onChange={e => updateSnapshot(s.id, 'totalPoolBalance', parseFloat(e.target.value) || 0)}
                            className="bg-transparent border-none text-sm font-black text-blue-600 outline-none w-full p-0"
                          />
                        </div>
                      </div>
                      <div className="bg-white rounded-2xl border border-slate-100 p-3.5 shadow-sm hover:border-blue-200 transition-colors">
                        <p className="text-[7.5px] font-black text-slate-400 uppercase tracking-widest mb-1">Créditos</p>
                        <input
                          type="number"
                          value={s.loanCount}
                          onChange={e => updateSnapshot(s.id, 'loanCount', parseInt(e.target.value) || 0)}
                          className="bg-transparent border-none text-sm font-black text-slate-800 outline-none w-full p-0"
                        />
                      </div>
                    </div>

                    {/* Quick Stats Row */}
                    <div className="grid grid-cols-3 gap-2">
                       <div className="bg-slate-50 rounded-xl p-2.5 text-center">
                          <p className="text-[7px] font-black text-slate-400 uppercase tracking-widest mb-1">APR %</p>
                          <input
                            type="number"
                            step="0.01"
                            value={s.avgApr}
                            onChange={e => updateSnapshot(s.id, 'avgApr', parseFloat(e.target.value) || 0)}
                            className="bg-transparent border-none w-full text-center text-xs font-black outline-none text-violet-600"
                          />
                        </div>
                        <div className="bg-slate-50 rounded-xl p-2.5 text-center">
                          <p className="text-[7px] font-black text-slate-400 uppercase tracking-widest mb-1">Avg Balance</p>
                          <input
                            type="number"
                            value={s.avgBalance}
                            onChange={e => updateSnapshot(s.id, 'avgBalance', parseFloat(e.target.value) || 0)}
                            className="bg-transparent border-none w-full text-center text-xs font-black outline-none text-slate-600"
                          />
                        </div>
                        <div className="bg-slate-50 rounded-xl p-2.5 text-center">
                          <p className="text-[7px] font-black text-slate-400 uppercase tracking-widest mb-1">Wtd Life</p>
                          <input
                            type="number"
                            step="0.1"
                            value={s.weightedAvgLife}
                            onChange={e => updateSnapshot(s.id, 'weightedAvgLife', parseFloat(e.target.value) || 0)}
                            className="bg-transparent border-none w-full text-center text-xs font-black outline-none text-slate-600"
                          />
                        </div>
                    </div>

                    {/* Delinquency Buckets */}
                    <div className="bg-white border border-slate-100 rounded-2xl p-4">
                      <p className="text-[8px] font-black text-bluebonnet uppercase tracking-widest mb-3">Buckets de Mora (%)</p>
                      <div className="grid grid-cols-4 gap-2">
                        {[
                          { label: '1-30 D', field: 'delinquency1_30' as keyof LoanTapeSnapshot },
                          { label: '31-60 D', field: 'delinquency31_60' as keyof LoanTapeSnapshot },
                          { label: '61-90 D', field: 'delinquency61_90' as keyof LoanTapeSnapshot },
                          { label: '90+ D', field: 'delinquency90Plus' as keyof LoanTapeSnapshot },
                        ].map(b => (
                          <div key={b.field} className="bg-slate-50 rounded-lg p-2 text-center">
                            <p className="text-[6px] font-black text-slate-400 uppercase mb-1">{b.label}</p>
                            <input
                              type="number"
                              step="0.1"
                              value={s[b.field] as any}
                              onChange={e => updateSnapshot(s.id, b.field, parseFloat(e.target.value) || 0)}
                              className="bg-transparent border-none w-full text-center text-[10px] font-black outline-none text-slate-700"
                            />
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Origination & Growth */}
                    <div className="bg-white border border-slate-100 rounded-2xl p-4">
                      <p className="text-[8px] font-black text-emerald-600 uppercase tracking-widest mb-3">Originación del Mes</p>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { label: '# Créditos', field: 'newCréditos' as keyof LoanTapeSnapshot },
                          { label: '# Clientes', field: 'newClientes' as keyof LoanTapeSnapshot },
                          { label: 'Max Exposure %', field: 'biggestPortfolioPct' as keyof LoanTapeSnapshot },
                        ].map(b => (
                          <div key={b.field} className="bg-emerald-50/30 border border-emerald-100 rounded-lg p-2 text-center">
                            <p className="text-[6px] font-black text-emerald-500 uppercase mb-1">{b.label}</p>
                            <input
                              type="number"
                              value={s[b.field] as any}
                              onChange={e => updateSnapshot(s.id, b.field, parseFloat(e.target.value) || 0)}
                              className="bg-transparent border-none w-full text-center text-[10px] font-black outline-none text-emerald-700"
                            />
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Concentration */}
                    <div className="bg-white border border-slate-100 rounded-2xl p-4">
                      <p className="text-[8px] font-black text-amber-600 uppercase tracking-widest mb-3">Concentración (%)</p>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { label: 'TOP 3', field: 'top3Pct' as keyof LoanTapeSnapshot },
                          { label: 'TOP 5', field: 'top5Pct' as keyof LoanTapeSnapshot },
                          { label: 'TOP 10', field: 'top10Pct' as keyof LoanTapeSnapshot },
                        ].map(b => (
                          <div key={b.field} className="bg-amber-50/30 border border-amber-100 rounded-lg p-2 text-center">
                            <p className="text-[6px] font-black text-amber-500 uppercase mb-1">{b.label}</p>
                            <input
                              type="number"
                              step="0.1"
                              value={s[b.field] as any}
                              onChange={e => updateSnapshot(s.id, b.field, parseFloat(e.target.value) || 0)}
                              className="bg-transparent border-none w-full text-center text-[10px] font-black outline-none text-amber-700"
                            />
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Categorization (Loans Desaparecidos) */}
                    <div className="bg-white border border-slate-100 rounded-2xl p-4">
                      <p className="text-[8px] font-black text-rose-600 uppercase tracking-widest mb-3">Categorización - Cierres (Count)</p>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { label: 'Expected', field: 'expectedVencimiento' as keyof LoanTapeSnapshot },
                          { label: 'Prepago', field: 'earlyPayments' as keyof LoanTapeSnapshot },
                          { label: 'Mora/Castigo', field: 'moraCastigo' as keyof LoanTapeSnapshot },
                        ].map(b => (
                          <div key={b.field} className="bg-rose-50/30 border border-rose-100 rounded-lg p-2 text-center">
                            <p className="text-[6px] font-black text-rose-500 uppercase mb-1">{b.label}</p>
                            <input
                              type="number"
                              value={s[b.field] as any}
                              onChange={e => updateSnapshot(s.id, b.field, parseFloat(e.target.value) || 0)}
                              className="bg-transparent border-none w-full text-center text-[10px] font-black outline-none text-rose-700"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Right: chart image */}
                  <div className="w-32 flex-shrink-0">
                    <p className="text-[7.5px] font-black text-slate-400 uppercase tracking-widest mb-2">Gráfica</p>
                    <div className="aspect-square bg-white rounded-2xl border-2 border-dashed border-slate-200 relative overflow-hidden group/chart hover:border-blue-300 transition-colors cursor-pointer">
                      {s.chartImage ? (
                        <>
                          <img src={s.chartImage} alt="chart" className="w-full h-full object-cover transition-transform duration-300 group-hover/chart:scale-110" />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/chart:opacity-100 transition-opacity flex items-center justify-center">
                            <button
                              onClick={e => { e.stopPropagation(); updateSnapshot(s.id, 'chartImage', undefined); }}
                              className="bg-rose-500 text-white p-1.5 rounded-lg"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </>
                      ) : (
                        <div className="flex flex-col items-center justify-center h-full gap-1.5 text-slate-300">
                          <ImageIcon className="w-6 h-6" />
                          <span className="text-[7px] font-black uppercase tracking-tight">Subir imagen</span>
                        </div>
                      )}
                      <input type="file" accept="image/*" onChange={e => handleImageUpload(e, s.id)} className="absolute inset-0 opacity-0 cursor-pointer" />
                    </div>
                  </div>
                </div>
              </div>
            ))}

            {snapshots.length === 0 && (
              <div className="col-span-full py-16 border-2 border-dashed border-slate-100 rounded-3xl flex flex-col items-center gap-4">
                <div className="w-14 h-14 bg-slate-50 rounded-2xl flex items-center justify-center">
                  <FileSpreadsheet className="w-7 h-7 text-slate-200" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-black text-slate-300 uppercase tracking-widest">Sin registros</p>
                  <p className="text-xs text-slate-400 mt-1">Crea el primer snapshot con "+ Nuevo Período"</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════
          SECTION 2 — Monitoreo Excel table
      ═══════════════════════════════════════════════════════════ */}
      <div className="bg-white rounded-[2rem] border border-slate-200 shadow-sm overflow-hidden">
        {/* Header bar */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between px-8 py-6 gap-4 border-b border-blue-50 bg-blue-50/20">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-bluebonnet rounded-xl flex items-center justify-center">
              <BarChart3 className="w-5 h-5 text-white" />
            </div>
            <div>
              <h4 className="text-sm font-black text-slate-900">Covenants por Período</h4>
              <p className="text-[10px] font-medium text-bluebonnet mt-0.5 uppercase tracking-widest">
                Concentrado de métricas de Loan Tape
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {monitoreo && (
              <button
                onClick={() => { const u = { ...company } as any; delete u.monitoreoData; onUpdateCompany(u); }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest text-slate-400 hover:text-rose-600 border border-slate-100 hover:border-rose-200 transition-all"
              >
                <X className="w-3 h-3" /> Limpiar
              </button>
            )}
            <label className="cursor-pointer flex items-center gap-2 bg-bluebonnet hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all active:scale-95 shadow-lg shadow-blue-900/10">
              {isParsingExcel ? <Activity className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              {isParsingExcel ? 'Procesando…' : 'Subir Excel'}
              <input ref={excelInputRef} type="file" accept=".xlsx,.xls" onChange={handleMonitoreoUpload} className="hidden" disabled={isParsingExcel} />
            </label>
          </div>
        </div>

      {/* Error */}
      {parseError && (
        <div className="mx-6 mt-5 flex items-start gap-3 bg-rose-50 border border-rose-100 rounded-2xl px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
          <p className="text-rose-700 text-xs font-medium">{parseError}</p>
        </div>
      )}

      {/* Empty state */}
      {!monitoreo && !isParsingExcel && (
        <div className="px-8 py-14 flex flex-col items-center gap-4 text-center">
          <div className="w-12 h-12 bg-slate-50 rounded-2xl flex items-center justify-center">
            <FileSpreadsheet className="w-6 h-6 text-slate-300" />
          </div>
          <div>
            <p className="text-sm font-black text-slate-400 uppercase tracking-widest">Sin archivo</p>
            <p className="text-xs text-slate-400 mt-1">
              Columna A/B = nombre del covenant · Columnas siguientes = valor por mes/trimestre
            </p>
          </div>
        </div>
      )}

        {/* Table */}
        {monitoreo && monitoreo.rows.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="sticky left-0 bg-white text-left px-6 py-4 text-[9px] font-black text-slate-400 uppercase tracking-widest min-w-[220px] whitespace-nowrap">
                      Covenant / Métrica
                    </th>
                    {monitoreo.periods.map(p => (
                      <th key={p} className="text-center px-5 py-4 text-[9px] font-black text-slate-400 uppercase tracking-widest whitespace-nowrap">
                        {p}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {monitoreo.rows.map((row, i) => (
                    <tr key={i} className={`border-b border-slate-50 hover:bg-slate-50 transition-colors ${i % 2 === 0 ? '' : 'bg-slate-50/30'}`}>
                      <td className="sticky left-0 px-6 py-3.5 text-[11px] font-semibold text-slate-700 whitespace-nowrap max-w-[280px] truncate" title={row.covenantName}
                        style={{ background: i % 2 === 0 ? 'white' : 'transparent' }}>
                        {row.covenantName}
                      </td>
                      {monitoreo.periods.map(period => {
                        const val = row.values[period] ?? '';
                        const n = parseFloat(val.replace('%', '').replace(',', '.'));
                        const isNum = !isNaN(n);
                        return (
                          <td key={period} className="px-5 py-3.5 text-center">
                            <span className={`font-mono text-[11px] font-bold ${isNum ? 'text-slate-800' : 'text-slate-400'}`}>
                              {val || '—'}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-6 py-3 border-t border-slate-100 flex items-center gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              <p className="text-[9px] font-bold text-slate-500">
                {monitoreo.rows.length} covenants · {monitoreo.periods.length} períodos
              </p>
            </div>
          </>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════════
          SECTION 3 — Analytical Report
      ═══════════════════════════════════════════════════════════ */}
      {snapshots.length > 0 && (
        <div className="bg-white rounded-[2rem] border border-slate-200 shadow-sm overflow-hidden">

          {/* Report header */}
          <div className="px-8 py-6 border-b border-slate-100 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-blue-50 rounded-xl flex items-center justify-center">
                <Activity className="w-5 h-5 text-bluebonnet" />
              </div>
              <div>
                <h4 className="text-sm font-black text-slate-900">Análisis de Congruencia</h4>
                <p className="text-[10px] text-slate-400 mt-0.5">
                  {analysis
                    ? `Generado ${new Date(analysis.generatedAt).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })} · ${snapshots.length} períodos analizados`
                    : `${snapshots.length} período${snapshots.length !== 1 ? 's' : ''} disponible${snapshots.length !== 1 ? 's' : ''} para análisis`}
                </p>
              </div>
            </div>
            <button
              onClick={runAnalysis}
              disabled={isAnalyzing}
              className="flex items-center gap-2 bg-bluebonnet hover:bg-blue-700 disabled:opacity-50 text-white px-5 py-2.5 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all active:scale-95 flex-shrink-0 shadow-lg shadow-blue-900/10"
            >
              {isAnalyzing ? <Activity className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              {isAnalyzing ? 'Analizando…' : analysis ? 'Actualizar' : 'Generar Análisis'}
            </button>
          </div>

        {/* No analysis yet */}
        {!analysis && !isAnalyzing && (
          <div className="px-8 py-14 flex flex-col items-center gap-4 text-center">
            <div className="w-12 h-12 bg-slate-50 rounded-2xl flex items-center justify-center">
              <Zap className="w-6 h-6 text-slate-300" />
            </div>
            <div>
              <p className="text-sm font-black text-slate-400 uppercase tracking-widest">Sin análisis</p>
              <p className="text-xs text-slate-400 mt-1">Haz clic en "Generar Análisis" para obtener el reporte de congruencia</p>
            </div>
          </div>
        )}

        {isAnalyzing && (
          <div className="px-8 py-14 flex flex-col items-center gap-4">
            <div className="w-10 h-10 border-2 border-slate-200 border-t-bluebonnet rounded-full animate-spin" />
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Procesando datos…</p>
          </div>
        )}

          {/* ── ANALYSIS BODY ── */}
          {analysis && !isAnalyzing && (
            <div className="p-8 space-y-8">

              {/* ── Row 1: Status + Risk gauge + Trend + Executive summary ── */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">

                {/* Overall status card */}
                <div className="bg-blue-50/40 border border-blue-100/60 rounded-2xl p-5 flex flex-col items-center justify-center gap-3">
                  {statusInfo && (
                    <>
                      <div className={`w-12 h-12 ${statusInfo.bg} rounded-2xl flex items-center justify-center shadow-lg shadow-black/5`}>
                        <statusInfo.Icon className="w-6 h-6 text-white" />
                      </div>
                      <div className="text-center">
                        <p className="text-[8px] font-black text-blue-400 uppercase tracking-widest mb-1 text-center">Estado General</p>
                        <p className={`text-lg font-black ${statusInfo.bg === 'bg-emerald-500' ? 'text-emerald-600' : statusInfo.bg === 'bg-amber-500' ? 'text-amber-600' : 'text-rose-600'}`}>
                          {analysis.overallStatus}
                        </p>
                      </div>
                    </>
                  )}
                </div>

                {/* Risk gauge */}
                <div className="bg-blue-50/40 border border-blue-100/60 rounded-2xl p-5 flex flex-col items-center justify-center gap-2">
                  <p className="text-[8px] font-black text-blue-400 uppercase tracking-widest">Score de Riesgo</p>
                  <RiskGauge score={analysis.riskScore} />
                  <p className="text-[10px] font-bold text-blue-500">
                    {analysis.riskScore < 35 ? 'Riesgo Bajo' : analysis.riskScore < 65 ? 'Riesgo Moderado' : 'Riesgo Alto'}
                  </p>
                </div>

                {/* Trend + summary */}
                <div className="bg-blue-50/40 border border-blue-100/60 rounded-2xl p-5 flex flex-col justify-between gap-4">
                  {trendInfo && (
                    <div className="flex items-center gap-2">
                      <trendInfo.Icon className={`w-4 h-4 ${trendInfo.color}`} />
                      <span className={`text-xs font-black ${trendInfo.color}`}>{analysis.trendDirection}</span>
                    </div>
                  )}
                  <div>
                    <p className="text-[8px] font-black text-blue-400 uppercase tracking-widest mb-2">Resumen Ejecutivo</p>
                    <p className="text-[12px] text-slate-700 leading-relaxed font-medium">{analysis.executiveSummary}</p>
                  </div>
                </div>
              </div>

              {/* ── Row 2: Key metrics ── */}
              {analysis.metrics && analysis.metrics.length > 0 && (
                <div>
                  <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-4">Métricas Clave</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                    {analysis.metrics.map((m, i) => {
                      const isBalance = m.name.toLowerCase().includes('balance') || m.name.toLowerCase().includes('saldo') || m.name.toLowerCase().includes('count') || m.name.toLowerCase().includes('crédito');
                      const isMora = m.name.toLowerCase().includes('mora') || m.name.toLowerCase().includes('delinq');
                      const positive = isBalance ? true : isMora ? false : undefined;
                      return (
                        <div key={i} className={`rounded-2xl border p-3.5 ${
                          m.status === 'critical' ? 'bg-rose-50 border-rose-100' :
                          m.status === 'warning'  ? 'bg-amber-50 border-amber-100' :
                          'bg-blue-50/20 border-blue-100/50 shadow-sm'
                        }`}>
                          <p className={`text-[7px] font-black uppercase tracking-widest mb-2 leading-tight ${
                            m.status === 'critical' ? 'text-rose-400' :
                            m.status === 'warning'  ? 'text-amber-400' :
                            'text-blue-400'
                          }`}>{m.name}</p>
                          <p className={`text-sm font-black mb-1 ${
                            m.status === 'critical' ? 'text-rose-700' :
                            m.status === 'warning'  ? 'text-amber-700' :
                            'text-slate-900'
                          }`}>{m.latestValue}</p>
                          <div className="flex items-center gap-1.5">
                            <TrendIcon trend={m.trend} positive={positive} />
                            {m.change && <span className="text-[9px] font-bold text-slate-400">{m.change}</span>}
                          </div>
                          {m.contractLimit && (
                            <p className="text-[8px] text-slate-400 mt-1.5 font-mono">Lím: {m.contractLimit}</p>
                          )}
                          <div className="mt-2">
                            <StatusPill status={m.status} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ── Row 3: Findings + Congruency ── */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                {/* Findings */}
                {analysis.findings && analysis.findings.length > 0 && (
                  <div>
                    <p className="text-[9px] font-black text-bluebonnet uppercase tracking-widest mb-4 flex items-center gap-2">
                       <span className="w-4 h-[2px] bg-bluebonnet"></span>
                       Hallazgos e Inteligencia
                    </p>
                    <div className="space-y-3">
                      {/* Sort: critical first, then warning, then info */}
                      {[...analysis.findings]
                        .sort((a, b) => {
                          const order = { critical: 0, warning: 1, info: 2 };
                          return (order[a.severity as keyof typeof order] ?? 3) - (order[b.severity as keyof typeof order] ?? 3);
                        })
                        .map((f, i) => <FindingCard key={i} finding={f} />)}
                    </div>
                  </div>
                )}

                {/* Congruency checks */}
                {analysis.congruencyChecks && analysis.congruencyChecks.length > 0 && (
                  <div>
                    <p className="text-[9px] font-black text-bluebonnet uppercase tracking-widest mb-4 flex items-center gap-2">
                       <span className="w-4 h-[2px] bg-bluebonnet"></span>
                       Verificación de Congruencia
                    </p>
                    <div className="bg-white border border-blue-100 rounded-2xl overflow-hidden shadow-sm">
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-slate-100 bg-slate-50/50">
                            <th className="text-left px-4 py-3 text-[8px] font-black text-slate-400 uppercase tracking-widest">Parámetro</th>
                            <th className="text-center px-3 py-3 text-[8px] font-black text-slate-400 uppercase tracking-widest">Contrato</th>
                            <th className="text-center px-3 py-3 text-[8px] font-black text-slate-400 uppercase tracking-widest">Real</th>
                            <th className="text-center px-3 py-3 text-[8px] font-black text-slate-400 uppercase tracking-widest">Est.</th>
                          </tr>
                        </thead>
                        <tbody>
                          {analysis.congruencyChecks.map((chk, i) => (
                            <tr key={i} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                              <td className="px-4 py-3 text-[10px] font-semibold text-slate-700">{chk.item}</td>
                              <td className="px-3 py-3 text-center text-[10px] font-mono text-slate-400">{chk.contractRequirement || '—'}</td>
                              <td className="px-3 py-3 text-center text-[10px] font-mono font-bold text-slate-900">{chk.actualValue}</td>
                              <td className="px-3 py-3 text-center"><StatusPill status={chk.status} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>

              {/* ── Row 4: Analyst notes ── */}
              <div className="border-t border-blue-50 pt-6">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[9px] font-black text-bluebonnet uppercase tracking-widest flex items-center gap-2">
                    <span className="w-4 h-[2px] bg-bluebonnet"></span>
                    Notas del Analista
                  </p>
                  {!editingNotes && (
                    <button
                      onClick={() => setEditingNotes(true)}
                      className="text-[9px] font-black text-slate-500 hover:text-bluebonnet uppercase tracking-widest transition-colors"
                    >
                      {analystNotes ? 'Editar' : '+ Agregar nota'}
                    </button>
                  )}
                </div>

                {editingNotes ? (
                  <div className="space-y-3">
                    <textarea
                      autoFocus
                      defaultValue={analystNotes}
                      rows={4}
                      placeholder="Escribe tu análisis, observaciones o comentarios adicionales…"
                      className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm text-slate-700 placeholder-slate-300 outline-none focus:border-bluebonnet/40 resize-none font-medium leading-relaxed shadow-sm"
                      onKeyDown={e => { if (e.key === 'Escape') setEditingNotes(false); }}
                      id="analyst-notes-ta"
                    />
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => setEditingNotes(false)} className="px-4 py-2 text-[9px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-600 transition-colors">
                        Cancelar
                      </button>
                      <button
                        onClick={() => saveNotes((document.getElementById('analyst-notes-ta') as HTMLTextAreaElement)?.value ?? '')}
                        className="px-5 py-2 bg-bluebonnet hover:bg-blue-700 text-white rounded-xl text-[9px] font-black uppercase tracking-widest transition-all shadow-lg shadow-blue-900/10"
                      >
                        Guardar
                      </button>
                    </div>
                  </div>
                ) : analystNotes ? (
                  <div className="bg-slate-50 border border-slate-100 rounded-2xl px-5 py-4">
                    <p className="text-sm text-slate-600 leading-relaxed whitespace-pre-wrap font-medium">{analystNotes}</p>
                  </div>
                ) : (
                  <div className="bg-slate-50/50 border border-dashed border-slate-200 rounded-2xl px-5 py-6 text-center">
                    <p className="text-xs text-slate-400">Sin notas. Haz clic en "+ Agregar nota" para añadir tu análisis.</p>
                  </div>
                )}
              </div>

            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default LoanTapeDashboardSection;
