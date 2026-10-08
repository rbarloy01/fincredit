import React, { useEffect, useMemo, useState } from 'react';
import { db, FinancialStatement_DB } from '../../db/index';
import { MANUAL_PATH_PREFIX, manualSegmentPath, segmentToStatementType, type AccountSegment } from '../../lib/accountClassification';
import { loadExportModule } from '../../lib/exportLoader';
import type { StatementReconciliation } from '../../lib/export';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';

interface Props {
  clientId: string;
  statements: FinancialStatement_DB[];
  onStatementsChange: (statements: FinancialStatement_DB[]) => void;
}

function money(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'N/A';
  return value.toLocaleString('es-MX', { maximumFractionDigits: 0 });
}

function readClientSetting<T>(clientId: string, key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${key}_${clientId}`);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

const AuditPanel: React.FC<Props> = ({ clientId, statements, onStatementsChange }) => {
  const [saving, setSaving] = useState<string | null>(null);
  const [reconciliations, setReconciliations] = useState<StatementReconciliation[]>([]);
  const [reconciliationLoading, setReconciliationLoading] = useState(true);
  const [selectedStatementId, setSelectedStatementId] = useState<string>('');

  const sortedStatements = useMemo(
    () => [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate)),
    [statements],
  );

  useEffect(() => {
    let active = true;
    const run = async () => {
      setReconciliationLoading(true);
      try {
        const mod = await loadExportModule();
        const bases = readClientSetting(clientId, 'finmonitor_vertical_bases', {});
        const concepts = readClientSetting(clientId, 'finmonitor_defined_concepts', []);
        const results = sortedStatements.map(stmt => mod.computeStatementReconciliation(stmt, bases, concepts));
        if (active) {
          setReconciliations(results);
          setSelectedStatementId(prev => prev && results.some(r => r.statementId === prev) ? prev : (results.at(-1)?.statementId || ''));
        }
      } finally {
        if (active) setReconciliationLoading(false);
      }
    };
    void run();
    return () => { active = false; };
  }, [clientId, sortedStatements]);

  const selectedReconciliation = reconciliations.find(r => r.statementId === selectedStatementId);

  const manualMoves = useMemo(() => {
    const map = new Map<string, { key: string; name: string; statementType: string; segment: string; periods: number }>();
    statements.forEach(stmt => stmt.rawLineItems.forEach(item => {
      if (!item.sectionPath?.startsWith(MANUAL_PATH_PREFIX)) return;
      const key = `${item.statementType || 'otro'}||${item.name}`;
      const cur = map.get(key) || { key, name: item.name, statementType: item.statementType || 'otro', segment: item.sectionPath!.split('>').pop()!.trim(), periods: 0 };
      cur.periods += 1;
      map.set(key, cur);
    }));
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [statements]);

  const revertManual = async (statementType: string, name: string) => {
    setSaving(`${statementType}||${name}`);
    const next: FinancialStatement_DB[] = [];
    for (const stmt of statements) {
      if (!stmt.rawLineItems.some(i => (i.statementType || 'otro') === statementType && i.name === name && i.sectionPath?.startsWith(MANUAL_PATH_PREFIX))) { next.push(stmt); continue; }
      const rawLineItems = stmt.rawLineItems.map(i => ((i.statementType || 'otro') === statementType && i.name === name && i.sectionPath?.startsWith(MANUAL_PATH_PREFIX)) ? { ...i, sectionPath: null } : i);
      await db.updateStatement(stmt.id, { rawLineItems });
      next.push({ ...stmt, rawLineItems });
    }
    onStatementsChange(next);
    setSaving(null);
  };

  const applySuggestion = async (sg: StatementReconciliation['suggestions'][number]) => {
    const stmt = statements.find(st => st.id === selectedStatementId);
    if (!stmt) return;
    let rawLineItems = stmt.rawLineItems;
    for (const account of sg.accounts) {
      rawLineItems = rawLineItems.map(item => (item.name === account.name && (item.statementType || 'otro') === account.statementType)
        ? { ...item, statementType: segmentToStatementType(sg.to as AccountSegment), sectionPath: manualSegmentPath(sg.to as AccountSegment) }
        : item);
    }
    setSaving(`${stmt.id}::suggestion`);
    await db.updateStatement(stmt.id, { rawLineItems });
    onStatementsChange(statements.map(st => (st.id === stmt.id ? { ...st, rawLineItems } : st)));
    setSaving(null);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-black text-slate-900">Conciliación</h2>
        <p className="text-sm text-slate-500 mt-1">Control de cuadre de los estados financieros (solo lectura). Para mover una cuenta de sección usa Estados Financieros: ahí el cambio afecta el dato real.</p>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-5">
          <div>
            <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">Reconciliación: Extraído vs. Sumado</h3>
            <p className="text-xs text-slate-500 font-bold mt-1">
              Reglas de cuadre: (1) una cuenta vive en una sola sección (la del encabezado más específico del estado); (2) el total de cada sección sale de la identidad Activo = Pasivo + Capital; (3) los subtotales se detectan por valor y no se suman dos veces; (4) si hay diferencia, se muestra cuánto falta o sobra y, cuando una cuenta mal ubicada la explica, se propone moverla.</p>
          </div>
          {sortedStatements.length > 0 && (
            <select
              value={selectedStatementId}
              onChange={e => setSelectedStatementId(e.target.value)}
              className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold"
            >
              {sortedStatements.map(stmt => (
                <option key={stmt.id} value={stmt.id}>{stmt.period}</option>
              ))}
            </select>
          )}
        </div>

        {reconciliationLoading ? (
          <p className="text-sm text-slate-400 font-bold text-center py-8">Cargando reconciliación...</p>
        ) : !selectedReconciliation ? (
          <p className="text-sm text-slate-400 font-bold text-center py-8">Sin estados financieros cargados para este cliente.</p>
        ) : (
          <>
            <div className="overflow-x-auto border border-slate-100 rounded-xl mb-4">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="text-left px-4 py-3 text-[10px] font-black text-slate-500 uppercase tracking-widest">Sección</th>
                    <th className="text-right px-4 py-3 text-[10px] font-black text-slate-500 uppercase tracking-widest">Total Extraído (fuente)</th>
                    <th className="text-right px-4 py-3 text-[10px] font-black text-slate-500 uppercase tracking-widest">Suma Calculada (detalle)</th>
                    <th className="text-right px-4 py-3 text-[10px] font-black text-slate-500 uppercase tracking-widest">Diferencia</th>
                    <th className="text-center px-4 py-3 text-[10px] font-black text-slate-500 uppercase tracking-widest">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedReconciliation.sections.map(section => (
                    <tr key={section.section} className="border-t border-slate-100">
                      <td className="px-4 py-3 font-black text-slate-800">{section.section}</td>
                      <td className="px-4 py-3 text-right font-mono font-black text-slate-900">{money(section.extractedTotal)}</td>
                      <td className="px-4 py-3 text-right font-mono font-black text-slate-700">{section.computedSum === null ? 'Sin detalle' : money(section.computedSum)}</td>
                      <td className={`px-4 py-3 text-right font-mono font-black ${section.status === 'ok' ? 'text-emerald-700' : section.status === 'divergence' ? 'text-rose-700' : 'text-amber-700'}`}>
                        {section.gap === null ? 'N/A' : money(section.gap)}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {section.computedSum === null ? (
                          <span className="text-[10px] font-black uppercase text-slate-400">Sin cuentas detalle</span>
                        ) : section.status === 'ok' ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" />Coincide</span>
                        ) : section.status === 'unverifiable' ? (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-black uppercase text-amber-700"
                            title={section.gap !== null && section.gap > 0 ? 'Faltan cuentas del detalle (o hay cuentas en otra sección) por este monto.' : 'Sobran cuentas en el detalle (subtotales o duplicados) por este monto.'}
                          >
                            <AlertTriangle className="w-3.5 h-3.5" />{section.gap !== null && section.gap > 0 ? 'Faltan' : 'Sobran'} {money(Math.abs(section.gap ?? 0))}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase text-rose-700"><AlertTriangle className="w-3.5 h-3.5" />Divergencia</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {selectedReconciliation.suggestions.length > 0 && (
              <div className="mb-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
                <p className="text-[11px] font-black uppercase tracking-widest text-indigo-700">La diferencia se explica por cuentas mal ubicadas</p>
                {selectedReconciliation.suggestions.map((sg, i) => (
                  <div key={i} className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-700">
                    <span>Mover <b>{sg.accounts.map(a => `${a.name} (${money(a.value)})`).join(' + ')}</b> de <b>{sg.from}</b> a <b>{sg.to}</b> — {money(sg.amount)}</span>
                    <button
                      onClick={() => applySuggestion(sg)}
                      disabled={!!saving}
                      className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-black text-white hover:bg-indigo-500 disabled:opacity-50"
                    >Aplicar reclasificación</button>
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="rounded-xl bg-slate-50 p-4">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Total Activo</p>
                <p className="text-lg font-black text-slate-900 mt-1">{money(selectedReconciliation.balanceCheck.totalActivo)}</p>
              </div>
              <div className="rounded-xl bg-slate-50 p-4">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Total Pasivo + Capital</p>
                <p className="text-lg font-black text-slate-900 mt-1">{money(selectedReconciliation.balanceCheck.totalPasivoMasCapital)}</p>
              </div>
              <div className={`rounded-xl p-4 ${selectedReconciliation.balanceCheck.diferencia !== null && Math.abs(selectedReconciliation.balanceCheck.diferencia) > 1000 ? 'bg-rose-50' : 'bg-emerald-50'}`}>
                <p className={`text-[10px] font-black uppercase tracking-widest ${selectedReconciliation.balanceCheck.diferencia !== null && Math.abs(selectedReconciliation.balanceCheck.diferencia) > 1000 ? 'text-rose-600' : 'text-emerald-600'}`}>Diferencia (Activo − Pasivo − Capital)</p>
                <p className={`text-lg font-black mt-1 ${selectedReconciliation.balanceCheck.diferencia !== null && Math.abs(selectedReconciliation.balanceCheck.diferencia) > 1000 ? 'text-rose-700' : 'text-emerald-700'}`}>{money(selectedReconciliation.balanceCheck.diferencia)}</p>
              </div>
            </div>
          </>
        )}
      </div>

      {manualMoves.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6">
          <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">Cuentas reclasificadas a mano</h3>
          <p className="text-xs text-slate-500 font-bold mt-1 mb-3">Quedan registradas aquí para que el cuadre sea trazable. Revertir devuelve la cuenta a la clasificación automática.</p>
          <table className="w-full text-xs">
            <thead><tr className="text-left text-slate-500"><th className="py-1.5 font-black uppercase">Cuenta</th><th className="py-1.5 font-black uppercase">Sección</th><th className="py-1.5 font-black uppercase">Periodos</th><th /></tr></thead>
            <tbody>
              {manualMoves.map(m => (
                <tr key={m.key} className="border-t border-slate-100">
                  <td className="py-1.5 font-semibold text-slate-800">{m.name}</td>
                  <td className="py-1.5 text-indigo-700 font-bold">{m.segment}</td>
                  <td className="py-1.5 text-slate-500">{m.periods}</td>
                  <td className="py-1.5 text-right"><button onClick={() => revertManual(m.statementType, m.name)} disabled={!!saving} className="text-[11px] font-black text-slate-400 hover:text-rose-600 disabled:opacity-40">Revertir</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default AuditPanel;
