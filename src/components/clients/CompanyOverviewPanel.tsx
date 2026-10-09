import React, { useEffect, useState } from 'react';
import { Save, FileText, Pencil, X, AlertTriangle } from 'lucide-react';
import { Client, Covenant_DB, CustomField, FinancialStatement_DB, Transaction, db } from '../../db/index';
import { AISettings } from '../../services/ai';
import { evaluateCovenantAuto, standardRatios } from '../../lib/financialMetrics';
import WorkingOverlay from '../common/WorkingOverlay';

interface Props {
  client: Client;
  transactions: Transaction[];
  statements: FinancialStatement_DB[];
  covenants: Covenant_DB[];
  customFields: CustomField[];
  aiSettings: AISettings;
  onClientUpdate?: (updates: Partial<Client>) => Promise<void>;
  onCustomFieldsChange?: (fields: CustomField[]) => void;
}

function getField(fields: CustomField[], names: RegExp[]) {
  return fields.find(f => names.some(re => re.test(f.label)))?.value || '';
}

function fmtCurrency(value: number | null | undefined, currency: string): string {
  if (value == null || !Number.isFinite(value)) return 'Sin dato';
  const prefix = currency === 'MXN' ? '$' : currency === 'USD' ? 'USD ' : currency === 'EUR' ? 'EUR ' : `${currency} `;
  if (Math.abs(value) >= 1_000_000) return `${prefix}${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `${prefix}${(value / 1_000).toFixed(1)}K`;
  return `${prefix}${value.toLocaleString('es-MX')}`;
}

function fmtDate(value?: string | null) {
  if (!value) return 'Sin dato';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: '2-digit' });
}

function fmtNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return 'Sin dato';
  return value.toLocaleString('es-MX', { maximumFractionDigits: 2 });
}

// Un texto de 1-2 caracteres sin dígitos ("e", "x", "-") casi siempre es basura capturada por error.
function looksLikeJunk(value: unknown): boolean {
  const v = String(value ?? '').trim();
  return v.length > 0 && v.length <= 2 && !/\d/.test(v);
}

const OverviewField: React.FC<{ label: string; value: React.ReactNode; emphasis?: boolean; computed?: boolean; flag?: string }> = ({ label, value, emphasis = false, computed = false, flag }) => (
  <div className="min-w-0 border-b border-slate-100 py-3">
    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}{computed && <span className="ml-1 normal-case tracking-normal font-bold text-slate-300">· calculado</span>}</p>
    <p className={`mt-1 truncate ${emphasis ? 'text-lg font-black text-slate-950' : 'text-sm font-bold text-slate-800'}`}>{value || 'Sin dato'}</p>
    {flag && <p className="mt-0.5 flex items-center gap-1 text-[10px] font-bold text-amber-600"><AlertTriangle className="w-3 h-3" />{flag}</p>}
  </div>
);

const EditField: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="min-w-0 border-b border-slate-100 py-2 block">
    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</span>
    <div className="mt-1">{children}</div>
  </label>
);

const editInput = 'w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-400';

type Draft = {
  industry: string; taxId: string; status: string; analystName: string; totalCreditValue: string; currency: string;
  creditType: string; contractName: string; location: string; start: string; reportDate: string; frequency: string;
  lastPeriod: string; aforoRequerido: string; maxDefaultDays: string; maxDefaultAmount: string; defaultFrequency12m: string; currentDue: string;
};

const CompanyOverviewPanel: React.FC<Props> = ({ client, transactions, statements, covenants, customFields, aiSettings, onClientUpdate, onCustomFieldsChange }) => {
  const key = `finmonitor_company_overview_${client.id}`;
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    db.getClientSetting<string>(client.id, key, '').then(setText);
  }, [client.id, key]);

  const latest = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate)).at(-1);
  const ratios = latest ? standardRatios(latest, statements) : [];
  const location = getField(customFields, [/ubic/i, /local/i, /geograf/i, /estado/i, /ciudad/i, /pais/i, /país/i]) || 'Sin dato';
  const start = getField(customFields, [/inicio.*oper/i, /fecha.*inicio/i, /start/i, /fundaci/i]) || 'Sin dato';
  const financialCovenants = covenants.filter(c => c.type === 'financial');
  const affirmativeCovenants = covenants.filter(c => c.type === 'hacer');
  const negativeCovenants = covenants.filter(c => c.type === 'noHacer');
  const pendingDocs = (client.documentation || []).filter(doc => !doc.isCompliant);
  const totalTransactionAmount = transactions.reduce((sum, tx) => sum + (Number.isFinite(tx.originalAmount) ? tx.originalAmount : 0), 0);
  const transactionNames = transactions.slice(0, 3).map(tx => tx.name || tx.creditType || 'Facility sin nombre').join(', ');
  const latestFinancialRows = latest ? [
    ['Ingresos', fmtCurrency(latest.mappedData.revenue, client.currency)],
    ['EBITDA', fmtCurrency(latest.mappedData.ebitda, client.currency)],
    ['Utilidad neta', fmtCurrency(latest.mappedData.netIncome, client.currency)],
    ['Deuda total', fmtCurrency(latest.mappedData.totalDebt, client.currency)],
    ['Activos totales', fmtCurrency(latest.mappedData.totalAssets, client.currency)],
    ['Capital contable', fmtCurrency(latest.mappedData.equity, client.currency)],
  ] : [];
  const keyRatios = ratios.filter(r => r.value !== null).slice(0, 6);
  const visibleCustomFields = customFields.filter(field => String(field.value || '').trim()).slice(0, 10);

  const locationField = customFields.find(f => [/ubic/i, /local/i, /geograf/i, /estado/i, /ciudad/i, /pais/i, /país/i].some(re => re.test(f.label)));
  const startField = customFields.find(f => [/inicio.*oper/i, /fecha.*inicio/i, /start/i, /fundaci/i].some(re => re.test(f.label)));
  const numText = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '' : String(v));

  const startEdit = () => setDraft({
    industry: client.industry || '', taxId: client.taxId || '', status: client.status || 'activo', analystName: client.analystName || '',
    totalCreditValue: numText(client.totalCreditValue), currency: client.currency || 'MXN', creditType: (client.creditType || []).join(', '),
    contractName: client.contractName || '', location: locationField?.value || '', start: startField?.value || '',
    reportDate: client.reportDate || '', frequency: client.frequency || 'mensual', lastPeriod: client.lastPeriod || '',
    aforoRequerido: client.aforoRequerido || '', maxDefaultDays: numText(client.maxDefaultDays), maxDefaultAmount: numText(client.maxDefaultAmount),
    defaultFrequency12m: numText(client.defaultFrequency12m), currentDue: numText(client.currentDue),
  });

  const saveEdit = async () => {
    if (!draft || !onClientUpdate) return;
    const num = (v: string) => { const n = Number(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
    setSaving(true);
    try {
      await onClientUpdate({
        industry: draft.industry.trim(), taxId: draft.taxId.trim(), status: draft.status as Client['status'], analystName: draft.analystName.trim(),
        totalCreditValue: num(draft.totalCreditValue), currency: draft.currency.trim() || 'MXN',
        creditType: draft.creditType.split(',').map(t => t.trim()).filter(Boolean), contractName: draft.contractName.trim(),
        reportDate: draft.reportDate, frequency: draft.frequency as Client['frequency'], lastPeriod: draft.lastPeriod.trim(),
        aforoRequerido: draft.aforoRequerido.trim(), maxDefaultDays: num(draft.maxDefaultDays), maxDefaultAmount: num(draft.maxDefaultAmount),
        defaultFrequency12m: num(draft.defaultFrequency12m), currentDue: num(draft.currentDue),
      });
      // Ubicación / inicio de operación viven en campos personalizados: se actualizan (o crean) ahí.
      const upsert = (fields: CustomField[], existing: CustomField | undefined, label: string, value: string) => {
        if (existing) return fields.map(f => (f.id === existing.id ? { ...f, value } : f));
        return value.trim() ? [...fields, { id: crypto.randomUUID(), clientId: client.id, label, value, fieldType: 'text' } as CustomField] : fields;
      };
      let nextFields = upsert(customFields, locationField, 'Ubicación', draft.location);
      nextFields = upsert(nextFields, startField, 'Inicio de operación', draft.start);
      if (nextFields !== customFields && (draft.location !== (locationField?.value || '') || draft.start !== (startField?.value || ''))) {
        await db.setCustomFields(client.id, nextFields);
        onCustomFieldsChange?.(nextFields);
      }
      setDraft(null);
    } catch (e: any) {
      alert(`No se pudo guardar: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  const localDraft = () => {
    const covenantSummary = covenants.filter(c => c.type === 'financial').slice(0, 5).map(c => {
      const r = evaluateCovenantAuto(c, statements);
      return `${c.name}: ${r.value === null ? 'N/A' : r.value.toLocaleString('es-MX', { maximumFractionDigits: 4 })}`;
    }).join('; ');
    const ratioSummary = ratios.slice(0, 6).map(r => `${r.label}: ${r.value === null ? 'N/A' : r.value.toLocaleString('es-MX', { maximumFractionDigits: 4 })}`).join('; ');
    return `${client.name} participa en el sector ${client.industry || 'sin industria capturada'}, con tipo de crédito ${client.creditType?.join(', ') || 'sin dato'} y exposición total de ${client.totalCreditValue.toLocaleString('es-MX')} ${client.currency}. Ubicación geográfica: ${location}. Inicio de operación: ${start}. Analista responsable: ${client.analystName || 'sin dato'}.\n\nCuenta con ${transactions.length} facility/facilities registradas por ${fmtCurrency(totalTransactionAmount, client.currency)} y ${financialCovenants.length} covenant(s) financiero(s). Documentos pendientes o no cumplidos: ${pendingDocs.length}.\n\nCon base en la información financiera cargada${latest ? ` al periodo ${latest.period}` : ''}, los indicadores principales observados son: ${ratioSummary || 'sin razones calculables todavía'}.\n\nIndicadores financieros monitoreados: ${covenantSummary || 'sin indicadores financieros configurados'}. Este apartado puede ajustarse manualmente para reflejar historia operativa, mercado, administración, fortalezas, riesgos y consideraciones específicas del crédito.`;
  };

  // Borrador determinístico con los datos ya calculados (sin IA): la narrativa la ajusta el analista.
  const generate = () => setText(localDraft());

  const save = async () => {
    setSaving(true);
    try {
      await db.setClientSetting(client.id, key, text);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <WorkingOverlay show={saving} title="Guardando overview" />
      <div className="bg-white border border-slate-200 rounded-2xl p-6">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <h2 className="text-lg font-black text-slate-900">Company Overview</h2>
            <p className="text-sm text-slate-500 mt-1">Datos generales del cliente. Los marcados como "calculado" salen de otras pestañas (facilities, EEFF, covenants).</p>
          </div>
          <div className="flex gap-2">
            {onClientUpdate && (draft ? (
              <>
                <button onClick={() => setDraft(null)} disabled={saving} className="flex items-center gap-2 bg-white border border-slate-200 text-slate-700 px-4 py-2.5 rounded-xl text-sm font-black disabled:opacity-50"><X className="w-4 h-4" /> Cancelar</button>
                <button onClick={saveEdit} disabled={saving} className="flex items-center gap-2 bg-emerald-600 text-white px-4 py-2.5 rounded-xl text-sm font-black disabled:opacity-50"><Save className="w-4 h-4" /> Guardar datos</button>
              </>
            ) : (
              <button onClick={startEdit} className="flex items-center gap-2 bg-white border border-slate-200 text-slate-800 px-4 py-2.5 rounded-xl text-sm font-black hover:border-indigo-300"><Pencil className="w-4 h-4" /> Editar datos</button>
            ))}
            <button onClick={generate} disabled={saving} className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2.5 rounded-xl text-sm font-black disabled:opacity-50">
              <FileText className="w-4 h-4" /> Borrador con datos
            </button>
            <button onClick={save} disabled={saving} className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2.5 rounded-xl text-sm font-black disabled:opacity-50">
              <Save className="w-4 h-4" /> Guardar
            </button>
          </div>
        </div>
        {draft && (
          <div className="mb-6 grid grid-cols-2 gap-x-5 md:grid-cols-4 xl:grid-cols-6 rounded-xl bg-indigo-50/40 px-3">
            <EditField label="Industria"><input className={editInput} value={draft.industry} onChange={e => setDraft({ ...draft, industry: e.target.value })} /></EditField>
            <EditField label="RFC / Tax ID"><input className={editInput} value={draft.taxId} onChange={e => setDraft({ ...draft, taxId: e.target.value })} /></EditField>
            <EditField label="Estatus">
              <select className={editInput} value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value })}>
                <option value="activo">activo</option><option value="dormant">dormant</option><option value="cerrado">cerrado</option>
              </select>
            </EditField>
            <EditField label="Analista"><input className={editInput} value={draft.analystName} onChange={e => setDraft({ ...draft, analystName: e.target.value })} /></EditField>
            <EditField label="Línea total"><input className={editInput} inputMode="decimal" value={draft.totalCreditValue} onChange={e => setDraft({ ...draft, totalCreditValue: e.target.value })} /></EditField>
            <EditField label="Moneda"><input className={editInput} value={draft.currency} onChange={e => setDraft({ ...draft, currency: e.target.value })} /></EditField>
            <EditField label="Tipo crédito (separa con coma)"><input className={editInput} value={draft.creditType} onChange={e => setDraft({ ...draft, creditType: e.target.value })} /></EditField>
            <EditField label="Nombre del contrato"><input className={editInput} value={draft.contractName} onChange={e => setDraft({ ...draft, contractName: e.target.value })} placeholder="ej. Contrato de crédito simple 2025" /></EditField>
            <EditField label="Ubicación"><input className={editInput} value={draft.location} onChange={e => setDraft({ ...draft, location: e.target.value })} /></EditField>
            <EditField label="Inicio operación"><input className={editInput} value={draft.start} onChange={e => setDraft({ ...draft, start: e.target.value })} /></EditField>
            <EditField label="Fecha reporte"><input type="date" className={editInput} value={draft.reportDate} onChange={e => setDraft({ ...draft, reportDate: e.target.value })} /></EditField>
            <EditField label="Frecuencia">
              <select className={editInput} value={draft.frequency} onChange={e => setDraft({ ...draft, frequency: e.target.value })}>
                <option value="mensual">mensual</option><option value="trimestral">trimestral</option>
              </select>
            </EditField>
            <EditField label="Último periodo"><input className={editInput} value={draft.lastPeriod} onChange={e => setDraft({ ...draft, lastPeriod: e.target.value })} /></EditField>
            <EditField label="Aforo requerido"><input className={editInput} value={draft.aforoRequerido} onChange={e => setDraft({ ...draft, aforoRequerido: e.target.value })} placeholder="ej. 1.3x" /></EditField>
            <EditField label="Días mora máx."><input className={editInput} inputMode="numeric" value={draft.maxDefaultDays} onChange={e => setDraft({ ...draft, maxDefaultDays: e.target.value })} /></EditField>
            <EditField label="Monto mora máx."><input className={editInput} inputMode="decimal" value={draft.maxDefaultAmount} onChange={e => setDraft({ ...draft, maxDefaultAmount: e.target.value })} /></EditField>
            <EditField label="Frecuencia mora 12m"><input className={editInput} inputMode="numeric" value={draft.defaultFrequency12m} onChange={e => setDraft({ ...draft, defaultFrequency12m: e.target.value })} /></EditField>
            <EditField label="Saldo vencido actual"><input className={editInput} inputMode="decimal" value={draft.currentDue} onChange={e => setDraft({ ...draft, currentDue: e.target.value })} /></EditField>
          </div>
        )}
        {!draft && (
        <div className="mb-6 grid grid-cols-2 gap-x-5 md:grid-cols-4 xl:grid-cols-6">
          <OverviewField label="Industria" value={client.industry || 'Sin dato'} />
          <OverviewField label="RFC / Tax ID" value={client.taxId || 'Sin dato'} />
          <OverviewField label="Estatus" value={client.status || 'activo'} />
          <OverviewField label="Analista" value={client.analystName || 'Sin dato'} />
          <OverviewField label="Línea total" value={fmtCurrency(client.totalCreditValue, client.currency)} emphasis />
          <OverviewField label="Moneda" value={client.currency} />
          <OverviewField label="Tipo crédito" value={client.creditType?.join(', ') || 'Sin dato'} />
          <OverviewField label="Nombre del contrato" value={client.contractName || 'Sin dato'} flag={looksLikeJunk(client.contractName) ? 'Valor sospechoso: edítalo' : undefined} />
          <OverviewField computed label="Facilities" value={transactions.length ? `${transactions.length}: ${transactionNames}${transactions.length > 3 ? '...' : ''}` : 'Sin dato'} />
          <OverviewField computed label="Monto facilities" value={fmtCurrency(totalTransactionAmount, client.currency)} />
          <OverviewField label="Ubicación" value={location} />
          <OverviewField label="Inicio operación" value={start} />
          <OverviewField label="Fecha reporte" value={fmtDate(client.reportDate)} />
          <OverviewField label="Frecuencia" value={client.frequency || 'Sin dato'} />
          <OverviewField label="Último periodo" value={client.lastPeriod || latest?.period || 'Sin dato'} />
          <OverviewField computed label="Último EEFF" value={latest ? `${latest.period} · ${fmtDate(latest.periodDate)}` : 'Sin dato'} />
          <OverviewField label="Aforo requerido" value={client.aforoRequerido || 'Sin dato'} />
          <OverviewField label="Días mora máx." value={fmtNumber(client.maxDefaultDays)} />
          <OverviewField label="Monto mora máx." value={fmtCurrency(client.maxDefaultAmount, client.currency)} />
          <OverviewField label="Frecuencia mora 12m" value={fmtNumber(client.defaultFrequency12m)} />
          <OverviewField label="Saldo vencido actual" value={fmtCurrency(client.currentDue, client.currency)} />
          <OverviewField computed label="Docs pendientes" value={pendingDocs.length} />
          <OverviewField computed label="Indicadores financieros" value={financialCovenants.length} />
          <OverviewField computed label="Hacer / No Hacer" value={`${affirmativeCovenants.length} / ${negativeCovenants.length}`} />
        </div>
        )}

        <div className="mb-6 grid grid-cols-1 gap-5 xl:grid-cols-3">
          <div className="rounded-xl border border-slate-200 p-4">
            <h3 className="mb-3 text-xs font-black uppercase tracking-widest text-slate-500">Últimos financieros</h3>
            {latestFinancialRows.length ? latestFinancialRows.map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-3 border-b border-slate-100 py-2 last:border-0">
                <span className="text-xs font-bold text-slate-500">{label}</span>
                <span className="truncate text-sm font-black text-slate-900">{value}</span>
              </div>
            )) : <p className="py-6 text-center text-sm font-semibold text-slate-400">Sin EEFF cargados</p>}
          </div>

          <div className="rounded-xl border border-slate-200 p-4">
            <h3 className="mb-3 text-xs font-black uppercase tracking-widest text-slate-500">Ratios clave</h3>
            {keyRatios.length ? keyRatios.map(ratio => (
              <div key={ratio.key} className="flex items-center justify-between gap-3 border-b border-slate-100 py-2 last:border-0">
                <span className="truncate text-xs font-bold text-slate-500">{ratio.label}</span>
                <span className="text-sm font-black text-slate-900">{ratio.value === null ? 'N/A' : ratio.value.toLocaleString('es-MX', { maximumFractionDigits: 4 })}</span>
              </div>
            )) : <p className="py-6 text-center text-sm font-semibold text-slate-400">Sin ratios calculables</p>}
          </div>

          <div className="rounded-xl border border-slate-200 p-4">
            <h3 className="mb-3 text-xs font-black uppercase tracking-widest text-slate-500">Campos personalizados</h3>
            {visibleCustomFields.length ? visibleCustomFields.map(field => (
              <div key={field.id} className="border-b border-slate-100 py-2 last:border-0">
                <p className="truncate text-[10px] font-black uppercase tracking-widest text-slate-400">{field.label}</p>
                <p className="mt-0.5 truncate text-sm font-bold text-slate-800">{field.value}</p>
              </div>
            )) : <p className="py-6 text-center text-sm font-semibold text-slate-400">Sin campos personalizados</p>}
          </div>
        </div>

        {client.opinion && (
          <div className="mb-6 rounded-xl border border-slate-200 p-4">
            <h3 className="mb-2 text-xs font-black uppercase tracking-widest text-slate-500">Opinión del analista</h3>
            <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">{client.opinion}</p>
          </div>
        )}

        <h3 className="mb-1 text-xs font-black uppercase tracking-widest text-slate-500">Descripción de la empresa (texto libre)</h3>
        <p className="mb-2 text-xs text-slate-400">Notas narrativas del analista sobre la empresa: historia, administración, mercado, riesgos. Se guardan con el botón "Guardar". "Borrador con datos" arma un texto inicial con lo ya capturado.</p>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={16}
          placeholder="Ej. Tim Leasing es una SOFOM enfocada en arrendamiento puro a PyMEs..."
          className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm text-slate-800 leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
      </div>
    </div>
  );
};

export default CompanyOverviewPanel;
