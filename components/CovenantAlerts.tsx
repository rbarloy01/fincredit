
import React from 'react';
import { Company, FinancialStatement, Covenant } from '../types';
import { evaluateFormula } from '../utils/financialFormula';

interface CovenantAlertsProps {
  company: Company;
  statement: FinancialStatement;
}

const CovenantAlerts: React.FC<CovenantAlertsProps> = ({ company, statement }) => {
  const calculateValue = (covenant: Covenant, data: FinancialStatement['data']) => {
    return evaluateFormula(covenant.formula, data).value;
  };

  const parseValue = (val: string | number): number => {
    if (typeof val === 'number') return val;
    const cleaned = val.replace('%', '').trim();
    const num = parseFloat(cleaned);
    if (val.includes('%')) return num / 100;
    return num;
  };

  const isPassing = (covenant: Covenant, value: number) => {
    const threshold = parseValue(covenant.threshold);
    switch (covenant.operator) {
      case 'gt': return value > threshold;
      case 'lt': return value < threshold;
      case 'gte': return value >= threshold;
      case 'lte': return value <= threshold;
      default: return false;
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      {company.covenants.map((covenant) => {
        const val = calculateValue(covenant, statement.data);
        const pass = val !== null && isPassing(covenant, val);
        return (
          <div key={covenant.id} className={`p-6 rounded-2xl border ${pass ? 'border-emerald-200 bg-emerald-50/30' : 'border-rose-200 bg-rose-50/30'} flex flex-col`}>
            <div className="flex justify-between items-start mb-4">
              <div>
                <h4 className="font-bold text-slate-800">{covenant.name}</h4>
                <p className="text-xs text-slate-500">{covenant.description}</p>
              </div>
              <div className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${pass ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                {pass ? 'Compliant' : 'Breach'}
              </div>
            </div>
            <div className="flex items-end justify-between mt-auto">
              <div>
                <span className="text-3xl font-black text-slate-900 font-mono">{val === null ? 'N/D' : val.toFixed(2)}</span>
                <span className="text-slate-400 text-sm ml-1 font-medium">Actual</span>
              </div>
              <div className="text-right">
                <span className="block text-xs text-slate-400 font-medium uppercase">Threshold</span>
                <span className="text-sm font-bold text-slate-700">{covenant.operator.toUpperCase()} {covenant.threshold}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default CovenantAlerts;
