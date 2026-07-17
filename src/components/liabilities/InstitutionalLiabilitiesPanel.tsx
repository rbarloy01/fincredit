import React, { useEffect, useMemo, useState } from 'react';
import {
  Upload, Trash2, Plus, Landmark, Pencil, X, Download, AlertTriangle,
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { db, InstitutionalLiability_DB } from '../../db/index';
import {
  buildLiabilitiesSummary, buildLenderConcentration, buildMaturityLadder,
  formatMoney, formatPercent, parseLiabilitiesRows, LIABILITY_TYPE_LABELS,
} from '../../lib/institutionalLiabilitiesAnalytics';
import { loadExportModule } from '../../lib/exportLoader';
import WorkingOverlay from '../common/WorkingOverlay';

interface Props {
  clientId: string;
  clientName?: string;
  onLiabilitiesChange?: (liabilities: InstitutionalLiability_DB[]) => void;
}

const CHART_COLORS = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#f43f5e', '#64748b', '#8b5cf6', '#14b8a6'];

type FormState = {
  lenderName: string;
  liabilityType: InstitutionalLiability_DB['liabilityType'];
  originalAmount: string;
  currentBalance: string;
  currency: string;
  interestRate: string;
  rateDescription: string;
  originationDate: string;
  maturityDate: string;
  amortization: string;
  guarantee: string;
  notes: string;
};

const EMPTY_FORM: FormState = {
  lenderName: '', liabilityType: 'linea_credito', originalAmount: '', currentBalance: '',
  currency: 'MXN', interestRate: '', rateDescription: '', originationDate: '', maturityDate: '',
  amortization: '', guarantee: '', notes: '',
};

function toForm(l: InstitutionalLiability_DB): FormState {
  return {
    lenderName: l.lenderName,
    liabilityType: l.liabilityType,
    originalAmount: l.originalAmount === null ? '' : String(l.originalAmount),
    currentBalance: l.currentBalance === null ? '' : String(l.currentBalance),
    currency: l.currency,
    interestRate: l.interestRate === null ? '' : String(l.interestRate * 100),
    rateDescription: l.rateDescription || '',
    originationDate: l.originationDate || '',
    maturityDate: l.maturityDate || '',
    amortization: l.amortization || '',
    guarantee: l.guarantee || '',
    notes: l.notes || '',
  };
}

function fromForm(clientId: string, form: FormState): Omit<InstitutionalLiability_DB, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    clientId,
    lenderName: form.lenderName.trim(),
    liabilityType: form.liabilityType,
    originalAmount: form.originalAmount === '' ? null : Number(form.originalAmount),
    currentBalance: form.currentBalance === '' ? null : Number(form.currentBalance),
    currency: form.currency.trim().toUpperCase() || 'MXN',
    interestRate: form.interestRate === '' ? null : Number(form.interestRate) / 100,
    rateDescription: form.rateDescription.trim() || undefined,
    originationDate: form.originationDate || undefined,
    maturityDate: form.maturityDate || undefined,
    amortization: form.amortization.trim() || undefined,
    guarantee: form.guarantee.trim() || undefined,
    notes: form.notes.trim() || undefined,
  };
}

const InstitutionalLiabilitiesPanel: React.FC<Props> = ({ clientId, clientName, onLiabilitiesChange }) => {
  const [liabilities, setLiabilities] = useState<InstitutionalLiability_DB[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);
  const [schemaReady, setSchemaReady] = useState<boolean | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [rows, ready] = await Promise.all([
        db.getInstitutionalLiabilities(clientId),
        db.checkInstitutionalLiabilitiesSchema(),
      ]);
      setLiabilities(rows);
      setSchemaReady(ready);
      onLiabilitiesChange?.(rows);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [clientId]);

  const summary = useMemo(() => buildLiabilitiesSummary(liabilities), [liabilities]);
  const lenderConcentration = useMemo(() => buildLenderConcentration(liabilities).slice(0, 8), [liabilities]);
  const maturityLadder = useMemo(() => buildMaturityLadder(liabilities), [liabilities]);

  const openNew = () => { setEditingId(null); setForm(EMPTY_FORM); setModalOpen(true); };
  const openEdit = (l: InstitutionalLiability_DB) => { setEditingId(l.id); setForm(toForm(l)); setModalOpen(true); };

  const handleSave = async () => {
    if (!form.lenderName.trim()) { alert('El acreedor / institución es obligatorio.'); return; }
    if (schemaReady === false) { setModalOpen(false); return; }
    setBusy(editingId ? 'Guardando cambios...' : 'Agregando pasivo...');
    try {
      if (editingId) {
        await db.updateInstitutionalLiability(editingId, fromForm(clientId, form));
      } else {
        await db.createInstitutionalLiability(fromForm(clientId, form));
      }
      setModalOpen(false);
      await load();
    } catch (e: any) {
      alert(`Error al guardar: ${e?.message || e}`);
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar este pasivo institucional?')) return;
    setBusy('Eliminando...');
    try {
      await db.deleteInstitutionalLiability(id);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const handleFileUpload = async (file: File) => {
    if (schemaReady === false) return;
    if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls') && !file.name.endsWith('.csv')) {
      alert('Solo se aceptan archivos Excel (.xlsx, .xls) o CSV.');
      return;
    }
    setBusy('Leyendo archivo...');
    setUploadWarning(null);
    try {
      const buffer = await file.arrayBuffer();
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: null }) as Record<string, unknown>[];
      const { parsed, unmatchedFields } = parseLiabilitiesRows(rows);
      if (!parsed.length) {
        alert('No se detectaron filas con acreedor/institución. Revisa que el archivo tenga una columna tipo "Acreedor" o "Institución".');
        return;
      }
      let sourceDocumentId: string | undefined;
      try {
        const doc = await db.uploadClientDocument(clientId, file, 'institutional_liability', { clientName, rows: parsed.length });
        sourceDocumentId = doc.id;
      } catch {
        // Non-fatal: still create the liability rows even if raw-file archival fails.
      }
      setBusy(`Guardando ${parsed.length} pasivos...`);
      for (const row of parsed) {
        await db.createInstitutionalLiability({ clientId, sourceDocumentId, ...row });
      }
      if (unmatchedFields.length) {
        setUploadWarning(`No se detectaron columnas para: ${unmatchedFields.join(', ')}. Puedes completarlas manualmente editando cada fila.`);
      }
      await load();
    } catch (e: any) {
      alert(`Error al procesar el archivo: ${e?.message || e}`);
    } finally {
      setBusy(null);
    }
  };

  const handleExport = async () => {
    setBusy('Generando Excel...');
    try {
      const mod = await loadExportModule();
      await mod.exportInstitutionalLiabilities(liabilities, clientName || 'Cliente');
    } catch (e: any) {
      alert(`Error al exportar: ${e?.message || e}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <WorkingOverlay show={!!busy} title={busy || 'Procesando'} />
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-black text-slate-900 flex items-center gap-2">
            <Landmark className="w-5 h-5 text-indigo-600" /> Pasivos Institucionales
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">Quién le presta dinero a este cliente: líneas de crédito, préstamos y bonos con instituciones.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className={`flex items-center gap-1.5 text-xs font-black text-slate-700 bg-white border border-slate-200 hover:border-indigo-300 px-3 py-2 rounded-xl transition-colors ${schemaReady === false ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
            <Upload className="w-3.5 h-3.5" /> Subir Excel/CSV
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" disabled={schemaReady === false} onChange={e => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); e.target.value = ''; }} />
          </label>
          <button onClick={openNew} disabled={schemaReady === false} className="flex items-center gap-1.5 text-xs font-black text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-2 rounded-xl transition-colors">
            <Plus className="w-3.5 h-3.5" /> Agregar
          </button>
          <button onClick={handleExport} disabled={!liabilities.length} className="flex items-center gap-1.5 text-xs font-black text-slate-700 bg-white border border-slate-200 hover:border-indigo-300 disabled:opacity-40 px-3 py-2 rounded-xl transition-colors">
            <Download className="w-3.5 h-3.5" /> Excel
          </button>
        </div>
      </div>

      {schemaReady === false && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 text-amber-900 text-xs font-semibold px-4 py-3.5 rounded-xl">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-black">Falta aplicar una migración en Supabase</p>
            <p className="mt-1 opacity-90">
              La tabla <code className="font-mono bg-amber-100 px-1 rounded">institutional_liabilities</code> todavía no existe en la base de datos.
              Corre <code className="font-mono bg-amber-100 px-1 rounded">database/20260716_institutional_liabilities.sql</code> en el editor SQL de Supabase y vuelve a cargar esta pestaña para poder agregar o subir pasivos.
            </p>
          </div>
        </div>
      )}

      {uploadWarning && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-800 text-xs font-semibold px-4 py-3 rounded-xl">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {uploadWarning}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-slate-400 py-10 text-center">Cargando...</div>
      ) : !liabilities.length ? (
        <div className="text-center py-16 bg-slate-50 rounded-2xl border border-slate-200">
          <Landmark className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 font-semibold">Sin pasivos institucionales registrados</p>
          <p className="text-slate-400 text-sm mt-1">Sube un Excel/CSV o agrega manualmente para comenzar</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <SummaryCard label="Saldo Total" value={formatMoney(summary.totalCurrentBalance)} />
            <SummaryCard label="Tasa Prom. Ponderada" value={formatPercent(summary.weightedAverageRate)} />
            <SummaryCard label="Acreedores" value={String(summary.lenderCount)} />
            <SummaryCard
              label="Próximo Vencimiento"
              value={summary.nextMaturity ? summary.nextMaturity.maturityDate : 'N/A'}
              sub={summary.nextMaturity ? summary.nextMaturity.lenderName : undefined}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white rounded-2xl border border-slate-200 p-4">
              <h3 className="text-xs font-black text-slate-500 uppercase mb-3">Concentración por Acreedor</h3>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={lenderConcentration} dataKey="currentBalance" nameKey="key" cx="50%" cy="50%" outerRadius={80} label={({ pctOfTotal }: any) => `${(pctOfTotal * 100).toFixed(0)}%`}>
                    {lenderConcentration.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => formatMoney(v)} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 p-4">
              <h3 className="text-xs font-black text-slate-500 uppercase mb-3">Calendario de Vencimientos</h3>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={maturityLadder.map(b => ({ ...b, label: b.year === 0 ? 'Sin fecha' : String(b.year) }))}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" fontSize={11} />
                  <YAxis fontSize={11} tickFormatter={(v: number) => formatMoney(v)} width={70} />
                  <Tooltip formatter={(v: number) => formatMoney(v)} />
                  <Bar dataKey="currentBalance" fill="#4f46e5" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left">
                  <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs">Acreedor</th>
                  <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs">Tipo</th>
                  <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs text-right">Monto Original</th>
                  <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs text-right">Saldo Actual</th>
                  <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs text-right">Tasa</th>
                  <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs">Vencimiento</th>
                  <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs" />
                </tr>
              </thead>
              <tbody>
                {liabilities.map(l => (
                  <tr key={l.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3 font-bold text-slate-800">{l.lenderName}</td>
                    <td className="px-4 py-3 text-slate-600">{LIABILITY_TYPE_LABELS[l.liabilityType] || l.liabilityType}</td>
                    <td className="px-4 py-3 text-right text-slate-600">{formatMoney(l.originalAmount, l.currency)}</td>
                    <td className="px-4 py-3 text-right font-bold text-slate-800">{formatMoney(l.currentBalance, l.currency)}</td>
                    <td className="px-4 py-3 text-right text-slate-600">{formatPercent(l.interestRate)}{l.rateDescription ? <span className="text-slate-400"> ({l.rateDescription})</span> : null}</td>
                    <td className="px-4 py-3 text-slate-600">{l.maturityDate || 'N/A'}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button onClick={() => openEdit(l)} className="text-slate-400 hover:text-indigo-600 mr-2"><Pencil className="w-3.5 h-3.5" /></button>
                      <button onClick={() => handleDelete(l.id)} className="text-slate-300 hover:text-rose-500"><Trash2 className="w-3.5 h-3.5" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {modalOpen && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setModalOpen(false)}>
          <div className="bg-white rounded-2xl p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-black text-slate-900">{editingId ? 'Editar Pasivo' : 'Nuevo Pasivo Institucional'}</h3>
              <button onClick={() => setModalOpen(false)}><X className="w-4 h-4 text-slate-400" /></button>
            </div>
            <div className="space-y-3">
              <Field label="Acreedor / Institución *"><input className="input" value={form.lenderName} onChange={e => setForm({ ...form, lenderName: e.target.value })} placeholder="ej: Banco XYZ" /></Field>
              <Field label="Tipo">
                <select className="input" value={form.liabilityType} onChange={e => setForm({ ...form, liabilityType: e.target.value as any })}>
                  {Object.entries(LIABILITY_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Monto Original"><input type="number" className="input" value={form.originalAmount} onChange={e => setForm({ ...form, originalAmount: e.target.value })} /></Field>
                <Field label="Saldo Actual"><input type="number" className="input" value={form.currentBalance} onChange={e => setForm({ ...form, currentBalance: e.target.value })} /></Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Moneda"><input className="input" value={form.currency} onChange={e => setForm({ ...form, currency: e.target.value })} /></Field>
                <Field label="Tasa Anual (%)"><input type="number" className="input" value={form.interestRate} onChange={e => setForm({ ...form, interestRate: e.target.value })} /></Field>
              </div>
              <Field label="Referencia de Tasa"><input className="input" value={form.rateDescription} onChange={e => setForm({ ...form, rateDescription: e.target.value })} placeholder="ej: TIIE + 350 pb" /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Fecha de Originación"><input type="date" className="input" value={form.originationDate} onChange={e => setForm({ ...form, originationDate: e.target.value })} /></Field>
                <Field label="Fecha de Vencimiento"><input type="date" className="input" value={form.maturityDate} onChange={e => setForm({ ...form, maturityDate: e.target.value })} /></Field>
              </div>
              <Field label="Amortización"><input className="input" value={form.amortization} onChange={e => setForm({ ...form, amortization: e.target.value })} placeholder="ej: mensual, bullet" /></Field>
              <Field label="Garantía"><input className="input" value={form.guarantee} onChange={e => setForm({ ...form, guarantee: e.target.value })} /></Field>
              <Field label="Notas"><textarea className="input" rows={2} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></Field>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setModalOpen(false)} className="text-xs font-black text-slate-500 px-4 py-2">Cancelar</button>
              <button onClick={handleSave} className="text-xs font-black text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-xl">Guardar</button>
            </div>
          </div>
        </div>
      )}
      <style>{`.input { width: 100%; border: 1px solid #e2e8f0; border-radius: 0.75rem; padding: 0.5rem 0.75rem; font-size: 0.875rem; }`}</style>
    </div>
  );
};

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <p className="text-[11px] font-black text-slate-400 uppercase">{label}</p>
      <p className="text-xl font-black text-slate-900 mt-1">{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-black text-slate-500 uppercase mb-1">{label}</label>
      {children}
    </div>
  );
}

export default InstitutionalLiabilitiesPanel;
