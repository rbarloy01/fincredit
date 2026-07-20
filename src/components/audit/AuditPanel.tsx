import React, { useEffect, useMemo, useState } from 'react';
import { db, FinancialStatement_DB } from '../../db/index';
import { classifyAccount } from '../../lib/accountClassification';
import { loadExportModule } from '../../lib/exportLoader';
import type { StatementReconciliation } from '../../lib/export';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';

type StatementType = 'balance_general' | 'estado_resultados' | 'flujo_efectivo' | 'otro';
type Segment = 'ACTIVO' | 'PASIVO' | 'CAPITAL' | 'Estado de Resultados' | 'Flujo de Efectivo' | 'Otros';

interface Props {
  clientId: string;
  statements: FinancialStatement_DB[];
  onStatementsChange: (statements: FinancialStatement_DB[]) => void;
}

const segmentToType = (segment: Segment): StatementType => {
  if (segment === 'Estado de Resultados') return 'estado_resultados';
  if (segment === 'Flujo de Efectivo') return 'flujo_efectivo';
  if (segment === 'Otros') return 'otro';
  return 'balance_general';
};

const pathFor = (segment: Segment) => {
  if (segment === 'ACTIVO') return 'Manual Auditoría > ACTIVO';
  if (segment === 'PASIVO') return 'Manual Auditoría > PASIVO';
  if (segment === 'CAPITAL') return 'Manual Auditoría > CAPITAL';
  if (segment === 'Estado de Resultados') return 'Manual Auditoría > Estado de Resultados';
  if (segment === 'Flujo de Efectivo') return 'Manual Auditoría > Flujo de Efectivo';
  return 'Manual Auditoría > Otros';
};

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

  const rows = statements.flatMap(stmt => stmt.rawLineItems.map((item, idx) => {
    const key = `${stmt.id}::${idx}`;
    const current = classifyAccount(item.statementType || 'otro', item.name, item.sectionPath);
    return { key, stmt, idx, item, current };
  }));

  const update = async (stmt: FinancialStatement_DB, idx: number, segment: Segment) => {
    setSaving(`${stmt.id}::${idx}`);
    const rawLineItems = stmt.rawLineItems.map((item, i) => i === idx
      ? { ...item, statementType: segmentToType(segment), sectionPath: pathFor(segment) }
      : item);
    await db.updateStatement(stmt.id, { rawLineItems });
    const next = statements.map(s => s.id === stmt.id ? { ...s, rawLineItems } : s);
    onStatementsChange(next);
    setSaving(null);
  };

  const clearPath = async (stmt: FinancialStatement_DB, idx: number) => {
    setSaving(`${stmt.id}::${idx}`);
    const rawLineItems = stmt.rawLineItems.map((item, i) => i === idx
      ? { ...item, sectionPath: null }
      : item);
    await db.updateStatement(stmt.id, { rawLineItems });
    const next = statements.map(s => s.id === stmt.id ? { ...s, rawLineItems } : s);
    onStatementsChange(next);
    setSaving(null);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-black text-slate-900">Auditoría de Cuentas</h2>
        <p className="text-sm text-slate-500 mt-1">Reclasifica cualquier cuenta extraída. Esto modifica el entendimiento usado por análisis y export Excel.</p>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-5">
          <div>
            <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">Reconciliación: Extraído vs. Sumado</h3>
            <p className="text-xs text-slate-500 font-bold mt-1">
              Compara el total reportado por el EFF de origen contra la suma en vivo de las cuentas detalle que quedaron clasificadas en cada sección, para el periodo seleccionado.
            </p>
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
                      <td className={`px-4 py-3 text-right font-mono font-black ${section.trustworthy ? 'text-emerald-700' : 'text-rose-700'}`}>
                        {section.gap === null ? 'N/A' : money(section.gap)}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {section.computedSum === null ? (
                          <span className="text-[10px] font-black uppercase text-slate-400">Sin cuentas detalle</span>
                        ) : section.trustworthy ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" />Coincide</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase text-rose-700"><AlertTriangle className="w-3.5 h-3.5" />Divergencia</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

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

      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto max-h-[70vh]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-900 text-white z-10">
              <tr>
                <th className="text-left px-4 py-3 font-black uppercase tracking-wider">Periodo</th>
                <th className="text-left px-4 py-3 font-black uppercase tracking-wider">Cuenta</th>
                <th className="text-left px-4 py-3 font-black uppercase tracking-wider">Ruta detectada</th>
                <th className="text-left px-4 py-3 font-black uppercase tracking-wider">Clasificación</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.key} className="border-t border-slate-100">
                  <td className="px-4 py-2 font-bold text-slate-500 whitespace-nowrap">{row.stmt.period}</td>
                  <td className="px-4 py-2 font-semibold text-slate-900">{row.item.name}</td>
                  <td className="px-4 py-2 text-slate-500">
                    <span className={row.item.sectionPath?.includes('Manual Auditoría') ? 'font-bold text-indigo-600' : ''}>
                      {row.item.sectionPath || 'Sin ruta visual'}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <select
                      disabled={saving === row.key}
                      value={row.current === 'Balance General sin clasificar' ? 'Otros' : row.current}
                      onChange={e => update(row.stmt, row.idx, e.target.value as Segment)}
                      className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 w-56 disabled:opacity-50"
                    >
                      <option value="ACTIVO">ACTIVO</option>
                      <option value="PASIVO">PASIVO</option>
                      <option value="CAPITAL">CAPITAL</option>
                      <option value="Estado de Resultados">Estado de Resultados</option>
                      <option value="Flujo de Efectivo">Flujo de Efectivo</option>
                      <option value="Otros">Otros</option>
                    </select>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => clearPath(row.stmt, row.idx)}
                      disabled={saving === row.key || !row.item.sectionPath}
                      className="inline-flex items-center gap-1 text-[11px] font-black text-slate-400 hover:text-rose-600 disabled:opacity-30"
                      title="Quitar ruta detectada"
                    >
                      <X className="w-3.5 h-3.5" />
                      Quitar ruta
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default AuditPanel;
