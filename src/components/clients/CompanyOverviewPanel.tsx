import React, { useEffect, useState } from 'react';
import { Save, Sparkles } from 'lucide-react';
import { Client, Covenant_DB, CustomField, FinancialStatement_DB, db } from '../../db/index';
import { AISettings, generateOpinion } from '../../services/ai';
import { evaluateCovenantAuto, standardRatios } from '../../lib/financialMetrics';
import WorkingOverlay from '../common/WorkingOverlay';

interface Props {
  client: Client;
  statements: FinancialStatement_DB[];
  covenants: Covenant_DB[];
  customFields: CustomField[];
  aiSettings: AISettings;
}

function getField(fields: CustomField[], names: RegExp[]) {
  return fields.find(f => names.some(re => re.test(f.label)))?.value || '';
}

const CompanyOverviewPanel: React.FC<Props> = ({ client, statements, covenants, customFields, aiSettings }) => {
  const key = `finmonitor_company_overview_${client.id}`;
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    db.getClientSetting<string>(client.id, key, '').then(setText);
  }, [client.id, key]);

  const latest = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate)).at(-1);
  const ratios = latest ? standardRatios(latest) : [];
  const location = getField(customFields, [/ubic/i, /local/i, /geograf/i, /estado/i, /ciudad/i, /pais/i, /país/i]) || 'Sin dato';
  const start = getField(customFields, [/inicio.*oper/i, /fecha.*inicio/i, /start/i, /fundaci/i]) || 'Sin dato';

  const localDraft = () => {
    const covenantSummary = covenants.filter(c => c.type === 'financial').slice(0, 5).map(c => {
      const r = evaluateCovenantAuto(c, statements);
      return `${c.name}: ${r.value === null ? 'N/A' : r.value.toLocaleString('es-MX', { maximumFractionDigits: 4 })}`;
    }).join('; ');
    const ratioSummary = ratios.slice(0, 6).map(r => `${r.label}: ${r.value === null ? 'N/A' : r.value.toLocaleString('es-MX', { maximumFractionDigits: 4 })}`).join('; ');
    return `${client.name} participa en el sector ${client.industry || 'sin industria capturada'}, con tipo de crédito ${client.creditType?.join(', ') || 'sin dato'} y exposición total de ${client.totalCreditValue.toLocaleString('es-MX')} ${client.currency}. Ubicación geográfica: ${location}. Inicio de operación: ${start}.\n\nCon base en la información financiera cargada${latest ? ` al periodo ${latest.period}` : ''}, los indicadores principales observados son: ${ratioSummary || 'sin razones calculables todavía'}.\n\nCovenants financieros monitoreados: ${covenantSummary || 'sin covenants financieros configurados'}. Este apartado puede ajustarse manualmente para reflejar historia operativa, mercado, administración, fortalezas, riesgos y consideraciones específicas del crédito.`;
  };

  const generate = async () => {
    setGenerating(true);
    try {
      if (aiSettings.apiKey && latest) {
        const covData = covenants.filter(c => c.type === 'financial').map(c => {
          const r = evaluateCovenantAuto(c, statements);
          return { name: c.name, threshold: c.threshold, value: r.value?.toString(), status: r.status };
        });
        const aiText = await generateOpinion(aiSettings, client.name, latest.period, covData, `Ubicación: ${location}. Inicio operación: ${start}. Sector: ${client.industry}. Tipo crédito: ${client.creditType?.join(', ')}.`);
        setText(aiText);
      } else {
        setText(localDraft());
      }
    } catch {
      setText(localDraft());
    } finally {
      setGenerating(false);
    }
  };

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
      <WorkingOverlay show={saving || generating} title={generating ? 'Generando overview' : 'Guardando overview'} />
      <div className="bg-white border border-slate-200 rounded-2xl p-6">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <h2 className="text-lg font-black text-slate-900">Company Overview</h2>
            <p className="text-sm text-slate-500 mt-1">Perfil narrativo editable para reportes, análisis preliminar y contexto de benchmarking.</p>
          </div>
          <div className="flex gap-2">
            <button onClick={generate} disabled={generating || saving} className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2.5 rounded-xl text-sm font-black disabled:opacity-50">
              <Sparkles className="w-4 h-4" /> Generar
            </button>
            <button onClick={save} disabled={generating || saving} className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2.5 rounded-xl text-sm font-black disabled:opacity-50">
              <Save className="w-4 h-4" /> Guardar
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <div className="bg-slate-50 rounded-xl p-3"><p className="text-[10px] font-black text-slate-400 uppercase">Industria</p><p className="text-sm font-bold text-slate-900 mt-1">{client.industry || 'Sin dato'}</p></div>
          <div className="bg-slate-50 rounded-xl p-3"><p className="text-[10px] font-black text-slate-400 uppercase">Ubicación</p><p className="text-sm font-bold text-slate-900 mt-1">{location}</p></div>
          <div className="bg-slate-50 rounded-xl p-3"><p className="text-[10px] font-black text-slate-400 uppercase">Inicio operación</p><p className="text-sm font-bold text-slate-900 mt-1">{start}</p></div>
          <div className="bg-slate-50 rounded-xl p-3"><p className="text-[10px] font-black text-slate-400 uppercase">Tipo crédito</p><p className="text-sm font-bold text-slate-900 mt-1">{client.creditType?.join(', ') || 'Sin dato'}</p></div>
        </div>
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
