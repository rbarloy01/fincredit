import React, { useEffect, useState } from 'react';
import { Save, FileText } from 'lucide-react';
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

const OverviewField: React.FC<{ label: string; value: React.ReactNode; emphasis?: boolean }> = ({ label, value, emphasis = false }) => (
  <div className="min-w-0 border-b border-slate-100 py-3">
    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
    <p className={`mt-1 truncate ${emphasis ? 'text-lg font-black text-slate-950' : 'text-sm font-bold text-slate-800'}`}>{value || 'Sin dato'}</p>
  </div>
);

const CompanyOverviewPanel: React.FC<Props> = ({ client, transactions, statements, covenants, customFields, aiSettings }) => {
  const key = `finmonitor_company_overview_${client.id}`;
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

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
            <p className="text-sm text-slate-500 mt-1">Perfil narrativo editable para reportes, análisis preliminar y contexto de benchmarking.</p>
          </div>
          <div className="flex gap-2">
            <button onClick={generate} disabled={saving} className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2.5 rounded-xl text-sm font-black disabled:opacity-50">
              <FileText className="w-4 h-4" /> Borrador con datos
            </button>
            <button onClick={save} disabled={saving} className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2.5 rounded-xl text-sm font-black disabled:opacity-50">
              <Save className="w-4 h-4" /> Guardar
            </button>
          </div>
        </div>
        <div className="mb-6 grid grid-cols-2 gap-x-5 md:grid-cols-4 xl:grid-cols-6">
          <OverviewField label="Industria" value={client.industry || 'Sin dato'} />
          <OverviewField label="RFC / Tax ID" value={client.taxId || 'Sin dato'} />
          <OverviewField label="Estatus" value={client.status || 'activo'} />
          <OverviewField label="Analista" value={client.analystName || 'Sin dato'} />
          <OverviewField label="Línea total" value={fmtCurrency(client.totalCreditValue, client.currency)} emphasis />
          <OverviewField label="Moneda" value={client.currency} />
          <OverviewField label="Tipo crédito" value={client.creditType?.join(', ') || 'Sin dato'} />
          <OverviewField label="Contrato" value={client.contractName || 'Sin dato'} />
          <OverviewField label="Facilities" value={transactions.length ? `${transactions.length}: ${transactionNames}${transactions.length > 3 ? '...' : ''}` : 'Sin dato'} />
          <OverviewField label="Monto facilities" value={fmtCurrency(totalTransactionAmount, client.currency)} />
          <OverviewField label="Ubicación" value={location} />
          <OverviewField label="Inicio operación" value={start} />
          <OverviewField label="Fecha reporte" value={fmtDate(client.reportDate)} />
          <OverviewField label="Frecuencia" value={client.frequency || 'Sin dato'} />
          <OverviewField label="Último periodo" value={client.lastPeriod || latest?.period || 'Sin dato'} />
          <OverviewField label="Último EEFF" value={latest ? `${latest.period} · ${fmtDate(latest.periodDate)}` : 'Sin dato'} />
          <OverviewField label="Aforo requerido" value={client.aforoRequerido || 'Sin dato'} />
          <OverviewField label="Días mora máx." value={fmtNumber(client.maxDefaultDays)} />
          <OverviewField label="Monto mora máx." value={fmtCurrency(client.maxDefaultAmount, client.currency)} />
          <OverviewField label="Frecuencia mora 12m" value={fmtNumber(client.defaultFrequency12m)} />
          <OverviewField label="Saldo vencido actual" value={fmtCurrency(client.currentDue, client.currency)} />
          <OverviewField label="Docs pendientes" value={pendingDocs.length} />
          <OverviewField label="Indicadores financieros" value={financialCovenants.length} />
          <OverviewField label="Hacer / No Hacer" value={`${affirmativeCovenants.length} / ${negativeCovenants.length}`} />
        </div>

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

        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={16}
          placeholder="Escribe o genera el overview de la compañía..."
          className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm text-slate-800 leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
      </div>
    </div>
  );
};

export default CompanyOverviewPanel;
