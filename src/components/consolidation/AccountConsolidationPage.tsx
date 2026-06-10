import React, { useEffect, useMemo, useState } from 'react';
import { db, Client, Covenant_DB, FinancialStatement_DB } from '../../db/index';
import { AISettings, suggestAccountConsolidation } from '../../services/ai';
import {
  AccountConsolidationRule,
  ConsolidationMetric,
  GlobalCovenantTemplate,
  METRIC_LABELS,
  cleanText,
  inferMetricForAccount,
  loadConsolidationRules,
  loadGlobalCovenantTemplates,
  loadOrgConsolidationRules,
  saveConsolidationRules,
  saveGlobalCovenantTemplates,
  templatesFromExistingCovenants,
  upsertCovenantTemplates,
} from '../../lib/accountConsolidation';
import WorkingOverlay from '../common/WorkingOverlay';
import { Brain, Check, Library, Plus, Save, Trash2, Wand2 } from 'lucide-react';
import { Session } from '../../services/auth';

interface Props {
  aiSettings: AISettings;
  session: Session;
}

const metrics = Object.entries(METRIC_LABELS) as Array<[ConsolidationMetric, string]>;

const AccountConsolidationPage: React.FC<Props> = ({ aiSettings, session }) => {
  const [clients, setClients] = useState<Client[]>([]);
  const [statements, setStatements] = useState<FinancialStatement_DB[]>([]);
  const [covenants, setCovenants] = useState<Covenant_DB[]>([]);
  const [rules, setRules] = useState<AccountConsolidationRule[]>(loadConsolidationRules);
  const [templates, setTemplates] = useState<GlobalCovenantTemplate[]>(() => loadGlobalCovenantTemplates());
  const [draftAliases, setDraftAliases] = useState('');
  const [draftMetric, setDraftMetric] = useState<ConsolidationMetric>('totalDebt');
  const [running, setRunning] = useState(false);

  const load = async () => {
    setRunning(true);
    try {
      const loadedClients = await db.getClients();
      const bundles = await Promise.all(loadedClients.map(async client => {
        const [stmts, covs] = await Promise.all([db.getStatements(client.id), db.getCovenants(client.id)]);
        return { client, stmts, covs };
      }));
      setClients(loadedClients);
      setStatements(bundles.flatMap(b => b.stmts));
      setCovenants(bundles.flatMap(b => b.covs));
      const [sharedRules, mergedTemplates] = await Promise.all([
        loadOrgConsolidationRules(session.userId),
        upsertCovenantTemplates(session.userId, templatesFromExistingCovenants(bundles.flatMap(b => b.covs))),
      ]);
      setRules(sharedRules);
      setTemplates(mergedTemplates);
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => { load(); }, [session.userId]);

  const accounts = useMemo(() => {
    const seen = new Set<string>();
    return statements.flatMap(stmt => stmt.rawLineItems.map(item => ({
      key: `${stmt.clientId}:${item.statementType || 'otro'}:${item.name}`,
      clientName: clients.find(c => c.id === stmt.clientId)?.name || '',
      name: item.name,
      statementType: item.statementType || 'otro',
      currentMetric: inferMetricForAccount(item.name, item.statementType),
    }))).filter(row => {
      const key = `${row.statementType}:${cleanText(row.name)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => (a.statementType || '').localeCompare(b.statementType || '') || a.name.localeCompare(b.name));
  }, [statements, clients, rules]);

  const persistRules = async (next: AccountConsolidationRule[]) => {
    setRules(next);
    await saveConsolidationRules(session.userId, next);
  };

  const addRule = async (metric: ConsolidationMetric, aliases: string[], source: AccountConsolidationRule['source'] = 'manual') => {
    const cleanAliases = aliases.map(a => a.trim()).filter(Boolean);
    if (cleanAliases.length === 0) return;
    const next = [
      ...rules.filter(r => r.source !== 'system'),
      {
        id: `${source}-${metric}-${Date.now()}`,
        metric,
        label: METRIC_LABELS[metric],
        aliases: cleanAliases,
        statementType: 'any' as const,
        source,
        updatedAt: new Date().toISOString(),
      },
    ];
    await persistRules(next);
  };

  const setAccountMetric = async (accountName: string, statementType: string, metric: ConsolidationMetric | '') => {
    const custom = rules.filter(r => r.source !== 'system');
    const without = custom.map(rule => ({ ...rule, aliases: rule.aliases.filter(a => cleanText(a) !== cleanText(accountName)) })).filter(r => r.aliases.length > 0);
    if (!metric) return persistRules(without);
    await persistRules([
      ...without,
      {
        id: `manual-${metric}-${Date.now()}`,
        metric,
        label: METRIC_LABELS[metric],
        aliases: [accountName],
        statementType: statementType as any,
        source: 'manual',
        updatedAt: new Date().toISOString(),
      },
    ]);
  };

  const runAI = async () => {
    if (!aiSettings.apiKey) { alert('Configura API key en Configuración.'); return; }
    setRunning(true);
    try {
      const result = await suggestAccountConsolidation(
        aiSettings,
        accounts.map(a => ({ name: a.name, statementType: a.statementType, clientName: a.clientName })),
        covenants.map(c => ({ name: c.name, formula: c.formula, description: c.description }))
      );
      const nextRules = [
        ...rules.filter(r => r.source !== 'system'),
        ...result.mappings
          .filter(m => metrics.some(([key]) => key === m.metric) && m.confidence >= 0.65)
          .map(m => ({
            id: `ai-${m.metric}-${cleanText(m.accountName)}-${Date.now()}`,
            metric: m.metric as ConsolidationMetric,
            label: METRIC_LABELS[m.metric as ConsolidationMetric],
            aliases: [m.accountName],
            statementType: (m.statementType || 'any') as any,
            source: 'ai' as const,
            updatedAt: new Date().toISOString(),
          })),
      ];
      await persistRules(nextRules);
      const aiTemplates = result.covenantTemplates.map(t => ({
        id: `ai-${cleanText(t.name + t.formula)}-${Date.now()}`,
        name: t.name,
        formula: t.formula,
        description: t.description,
        operator: t.operator || 'none',
        threshold: t.threshold || '',
        source: 'ai' as const,
        active: false,
        seenCount: 1,
        updatedAt: new Date().toISOString(),
      }));
      setTemplates(await upsertCovenantTemplates(session.userId, aiTemplates));
    } catch (err: any) {
      alert(err.message || 'Error AI');
    } finally {
      setRunning(false);
    }
  };

  const persistTemplates = async (next: GlobalCovenantTemplate[]) => {
    setTemplates(next);
    await saveGlobalCovenantTemplates(session.userId, next);
  };

  return (
    <div className="flex-1 bg-slate-50 min-h-screen p-8 space-y-6">
      <WorkingOverlay show={running} title="Consolidando cuentas" messages={['Leyendo cuentas extraídas...', 'Comparando nombres similares...', 'Armando plantillas globales...', 'Almost there...']} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight">Consolidación de Cuentas</h1>
          <p className="text-slate-500 text-sm mt-1">Mapeo global de cuentas similares y biblioteca de covenants sugeridos.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={runAI} disabled={running} className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2.5 rounded-xl text-sm font-black disabled:opacity-50">
            <Brain className="w-4 h-4" />AI leer cuentas
          </button>
          <button onClick={load} className="flex items-center gap-2 bg-white border border-slate-200 text-slate-700 px-4 py-2.5 rounded-xl text-sm font-black">
            <Wand2 className="w-4 h-4" />Releer data
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="bg-white border border-slate-200 rounded-2xl p-4"><p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Clientes</p><p className="text-2xl font-black text-slate-900">{clients.length}</p></div>
        <div className="bg-white border border-slate-200 rounded-2xl p-4"><p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Cuentas únicas</p><p className="text-2xl font-black text-slate-900">{accounts.length}</p></div>
        <div className="bg-white border border-slate-200 rounded-2xl p-4"><p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Mapeos activos</p><p className="text-2xl font-black text-slate-900">{rules.filter(r => r.source !== 'system').length}</p></div>
        <div className="bg-white border border-slate-200 rounded-2xl p-4"><p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Plantillas</p><p className="text-2xl font-black text-slate-900">{templates.length}</p></div>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-5">
        <h2 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-4">Agregar alias manual</h2>
        <div className="grid grid-cols-1 md:grid-cols-[220px_1fr_auto] gap-3">
          <select value={draftMetric} onChange={e => setDraftMetric(e.target.value as ConsolidationMetric)} className="bg-white border border-slate-200 rounded-xl px-3 py-2.5 text-sm font-bold">
            {metrics.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <input value={draftAliases} onChange={e => setDraftAliases(e.target.value)} placeholder="Ej: Provisión seguro social, acreedores diversos, bancos" className="bg-white border border-slate-200 rounded-xl px-3 py-2.5 text-sm" />
          <button onClick={() => { addRule(draftMetric, draftAliases.split(',')); setDraftAliases(''); }} className="flex items-center gap-2 bg-indigo-600 text-white rounded-xl px-4 py-2.5 text-sm font-black"><Plus className="w-4 h-4" />Agregar</button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.4fr_.8fr] gap-6">
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100">
            <h2 className="text-sm font-black text-slate-900 uppercase tracking-widest">Cuentas detectadas</h2>
          </div>
          <div className="overflow-auto max-h-[680px]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50">
                <tr>
                  <th className="text-left px-4 py-2 font-black text-slate-500 uppercase">Cuenta</th>
                  <th className="text-left px-4 py-2 font-black text-slate-500 uppercase">Estado</th>
                  <th className="text-left px-4 py-2 font-black text-slate-500 uppercase">Consolidar como</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map(account => (
                  <tr key={account.key} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-bold text-slate-800">{account.name}<p className="text-[10px] text-slate-400">{account.clientName}</p></td>
                    <td className="px-4 py-2 text-slate-500">{account.statementType}</td>
                    <td className="px-4 py-2">
                      <select value={account.currentMetric} onChange={e => setAccountMetric(account.name, account.statementType, e.target.value as ConsolidationMetric | '')} className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5 font-bold">
                        <option value="">Sin mapear</option>
                        {metrics.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-2xl p-5">
            <h2 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-4">Mapeos guardados</h2>
            <div className="space-y-2 max-h-80 overflow-auto">
              {rules.filter(r => r.source !== 'system').map(rule => (
                <div key={rule.id} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-black text-slate-800">{METRIC_LABELS[rule.metric]}</p>
                      <p className="text-xs text-slate-500 mt-1">{rule.aliases.join(', ')}</p>
                      <p className="text-[10px] text-slate-400 uppercase mt-1">{rule.source}</p>
                    </div>
                    <button onClick={() => persistRules(rules.filter(r => r.id !== rule.id))} className="text-slate-300 hover:text-rose-500"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
              ))}
              {rules.filter(r => r.source !== 'system').length === 0 && <p className="text-sm text-slate-400 text-center py-6">Sin mapeos manuales todavía.</p>}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-5">
            <h2 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-4 flex items-center gap-2"><Library className="w-4 h-4" />Covenants globales sugeridos</h2>
            <div className="space-y-2 max-h-96 overflow-auto">
              {templates.map(template => (
                <div key={template.id} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-black text-slate-800">{template.name}</p>
                      <p className="text-[11px] font-mono text-slate-500 mt-1">{template.formula}</p>
                      <p className="text-[10px] text-slate-400 mt-1">{template.source} · visto {template.seenCount}</p>
                    </div>
                    <button onClick={() => persistTemplates(templates.map(t => t.id === template.id ? { ...t, active: !t.active } : t))} className={`rounded-lg px-2 py-1 text-[10px] font-black border ${template.active ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-50 text-slate-500 border-slate-200'}`}>
                      {template.active ? <Check className="w-3 h-3" /> : 'OFF'}
                    </button>
                  </div>
                </div>
              ))}
              {templates.length === 0 && <p className="text-sm text-slate-400 text-center py-6">Sin plantillas todavía.</p>}
            </div>
            <button onClick={() => persistTemplates(templates)} className="mt-4 w-full flex items-center justify-center gap-2 bg-slate-900 text-white rounded-xl px-4 py-2.5 text-sm font-black"><Save className="w-4 h-4" />Guardar biblioteca</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AccountConsolidationPage;
