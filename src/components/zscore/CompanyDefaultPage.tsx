import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Search, ShieldAlert } from 'lucide-react';
import { db, Client, CompanyDefaultAssessment_DB } from '../../db/index';
import WorkingOverlay from '../common/WorkingOverlay';

type RowState = {
  zScore: string;
  classification: string;
  isDefault: boolean;
  defaultDate: string;
  notes: string;
};

function toRowState(assessment?: CompanyDefaultAssessment_DB): RowState {
  return {
    zScore: assessment?.zScore === null || assessment?.zScore === undefined ? '' : String(assessment.zScore),
    classification: assessment?.classification || '',
    isDefault: assessment?.isDefault || false,
    defaultDate: assessment?.defaultDate || '',
    notes: assessment?.notes || '',
  };
}

const CompanyDefaultPage: React.FC = () => {
  const [clients, setClients] = useState<Client[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [schemaReady, setSchemaReady] = useState<boolean | null>(null);
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const clientList = await db.getClients();
      const clientIds = clientList.map(c => c.id);
      const [assessments, ready] = await Promise.all([
        db.getCompanyDefaultAssessments(clientIds),
        db.checkCompanyDefaultAssessmentsSchema(),
      ]);
      setClients(clientList);
      setSchemaReady(ready);
      setRows(Object.fromEntries(clientList.map(c => [c.id, toRowState(assessments[c.id])])));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filteredClients = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter(c => c.name.toLowerCase().includes(q));
  }, [clients, search]);

  const defaultCount = useMemo(() => (Object.values(rows) as RowState[]).filter(r => r.isDefault).length, [rows]);
  const withZScoreCount = useMemo(() => (Object.values(rows) as RowState[]).filter(r => r.zScore.trim() !== '').length, [rows]);

  const updateRow = (clientId: string, patch: Partial<RowState>) => {
    setRows(prev => ({ ...prev, [clientId]: { ...prev[clientId], ...patch } }));
  };

  const saveRow = async (clientId: string) => {
    if (schemaReady === false) return;
    const row = rows[clientId];
    if (!row) return;
    setSaving(clientId);
    try {
      const zScoreNumber = row.zScore.trim() === '' ? null : Number(row.zScore);
      await db.upsertCompanyDefaultAssessment(clientId, {
        zScore: Number.isFinite(zScoreNumber as number) ? zScoreNumber : null,
        classification: row.classification.trim() || undefined,
        isDefault: row.isDefault,
        defaultDate: row.defaultDate || undefined,
        notes: row.notes.trim() || undefined,
      });
    } catch (e: any) {
      alert(`Error al guardar: ${e?.message || e}`);
    } finally {
      setSaving(null);
    }
  };

  const toggleDefault = async (clientId: string) => {
    const row = rows[clientId];
    const nextIsDefault = !row.isDefault;
    updateRow(clientId, { isDefault: nextIsDefault, defaultDate: nextIsDefault && !row.defaultDate ? new Date().toISOString().slice(0, 10) : row.defaultDate });
    if (schemaReady === false) return;
    setSaving(clientId);
    try {
      await db.upsertCompanyDefaultAssessment(clientId, {
        isDefault: nextIsDefault,
        defaultDate: nextIsDefault ? (row.defaultDate || new Date().toISOString().slice(0, 10)) : row.defaultDate || undefined,
      });
    } catch (e: any) {
      alert(`Error al guardar: ${e?.message || e}`);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="p-8 space-y-6">
      <WorkingOverlay show={loading} title="Cargando" />
      <div>
        <h2 className="text-lg font-black text-slate-900 flex items-center gap-2">
          <ShieldAlert className="w-5 h-5 text-indigo-600" /> Z-Score
        </h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Clasificación de riesgo de default a nivel empresa (no por facility). Marca aquí si un cliente entró en default.
        </p>
      </div>

      <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-900 text-xs font-semibold px-4 py-3.5 rounded-xl">
        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <div>
          <p className="font-black">El cálculo del Z-Score aún no está definido</p>
          <p className="mt-1 opacity-90">
            Por ahora el Z-Score y la clasificación se capturan manualmente. En cuanto se defina la fórmula, se calculará automáticamente aquí.
          </p>
        </div>
      </div>

      {schemaReady === false && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 text-amber-900 text-xs font-semibold px-4 py-3.5 rounded-xl">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-black">Falta aplicar una migración en Supabase</p>
            <p className="mt-1 opacity-90">
              La tabla <code className="font-mono bg-amber-100 px-1 rounded">company_default_assessments</code> todavía no existe en la base de datos.
              Corre <code className="font-mono bg-amber-100 px-1 rounded">database/20260718_company_default_assessments.sql</code> en el editor SQL de Supabase y vuelve a cargar esta página para poder guardar cambios.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <p className="text-[11px] font-black text-slate-400 uppercase">Clientes</p>
          <p className="text-xl font-black text-slate-900 mt-1">{clients.length}</p>
        </div>
        <div className="bg-white rounded-2xl border border-rose-200 p-4">
          <p className="text-[11px] font-black text-rose-500 uppercase">En Default</p>
          <p className="text-xl font-black text-rose-700 mt-1">{defaultCount}</p>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <p className="text-[11px] font-black text-slate-400 uppercase">Con Z-Score capturado</p>
          <p className="text-xl font-black text-slate-900 mt-1">{withZScoreCount}</p>
        </div>
      </div>

      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar cliente..."
          className="w-full pl-11 pr-4 py-3 rounded-2xl border border-slate-200 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-200"
        />
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left">
              <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs">Cliente</th>
              <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs">Z-Score</th>
              <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs">Clasificación</th>
              <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs text-center">En Default</th>
              <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs">Fecha Default</th>
              <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs">Notas</th>
            </tr>
          </thead>
          <tbody>
            {filteredClients.map(client => {
              const row = rows[client.id] || toRowState();
              return (
                <tr key={client.id} className={`border-t border-slate-100 ${row.isDefault ? 'bg-rose-50/60' : ''}`}>
                  <td className="px-4 py-3 font-bold text-slate-800 whitespace-nowrap">{client.name}</td>
                  <td className="px-4 py-3">
                    <input
                      type="number"
                      value={row.zScore}
                      disabled={schemaReady === false}
                      onChange={e => updateRow(client.id, { zScore: e.target.value })}
                      onBlur={() => saveRow(client.id)}
                      className="input w-24"
                      placeholder="—"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="text"
                      value={row.classification}
                      disabled={schemaReady === false}
                      onChange={e => updateRow(client.id, { classification: e.target.value })}
                      onBlur={() => saveRow(client.id)}
                      className="input w-40"
                      placeholder="Sin clasificar"
                    />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => toggleDefault(client.id)}
                      disabled={schemaReady === false || saving === client.id}
                      className={`text-[10px] font-black uppercase rounded-full px-3 py-1.5 border transition-colors disabled:opacity-40 ${
                        row.isDefault ? 'bg-rose-600 text-white border-rose-700' : 'bg-slate-50 text-slate-500 border-slate-200 hover:border-rose-300'
                      }`}
                    >
                      {row.isDefault ? 'En default' : 'Marcar default'}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="date"
                      value={row.defaultDate}
                      disabled={schemaReady === false || !row.isDefault}
                      onChange={e => updateRow(client.id, { defaultDate: e.target.value })}
                      onBlur={() => saveRow(client.id)}
                      className="input w-40 disabled:opacity-40"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="text"
                      value={row.notes}
                      disabled={schemaReady === false}
                      onChange={e => updateRow(client.id, { notes: e.target.value })}
                      onBlur={() => saveRow(client.id)}
                      className="input w-48"
                      placeholder="Notas"
                    />
                  </td>
                </tr>
              );
            })}
            {!loading && !filteredClients.length && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm font-bold text-slate-400">Sin clientes que coincidan con la búsqueda.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <style>{`.input { border: 1px solid #e2e8f0; border-radius: 0.75rem; padding: 0.5rem 0.75rem; font-size: 0.875rem; font-weight: 600; }`}</style>
    </div>
  );
};

export default CompanyDefaultPage;
