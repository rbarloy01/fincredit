import React, { useState } from 'react';
import { db, FinancialStatement_DB } from '../../db/index';
import { classifyAccount } from '../../lib/accountClassification';
import { X } from 'lucide-react';

type StatementType = 'balance_general' | 'estado_resultados' | 'flujo_efectivo' | 'otro';
type Segment = 'ACTIVO' | 'PASIVO' | 'CAPITAL' | 'Estado de Resultados' | 'Flujo de Efectivo' | 'Otros';

interface Props {
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

const AuditPanel: React.FC<Props> = ({ statements, onStatementsChange }) => {
  const [saving, setSaving] = useState<string | null>(null);
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
