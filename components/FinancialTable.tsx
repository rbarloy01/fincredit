
import React from 'react';
import { FinancialStatement } from '../types';

interface FinancialTableProps {
  data: FinancialStatement['data'];
  onUpdate: (field: keyof FinancialStatement['data'], value: number) => void;
}

const FinancialTable: React.FC<FinancialTableProps> = ({ data, onUpdate }) => {
  const fields: { key: keyof FinancialStatement['data']; label: string; group: string }[] = [
    { key: 'revenue', label: 'Total Revenue', group: 'Income Statement' },
    { key: 'cogs', label: 'COGS', group: 'Income Statement' },
    { key: 'operatingExpenses', label: 'Op. Expenses', group: 'Income Statement' },
    { key: 'ebitda', label: 'EBITDA', group: 'Income Statement' },
    { key: 'interestExpense', label: 'Interest Expense', group: 'Income Statement' },
    { key: 'netIncome', label: 'Net Income', group: 'Income Statement' },
    { key: 'currentAssets', label: 'Current Assets', group: 'Balance Sheet' },
    { key: 'currentLiabilities', label: 'Current Liabilities', group: 'Balance Sheet' },
    { key: 'totalDebt', label: 'Total Debt', group: 'Balance Sheet' },
    { key: 'totalAssets', label: 'Total Assets', group: 'Balance Sheet' },
    { key: 'equity', label: 'Total Equity', group: 'Balance Sheet' },
  ];

  const grouped = fields.reduce((acc, field) => {
    if (!acc[field.group]) acc[field.group] = [];
    acc[field.group].push(field);
    return acc;
  }, {} as Record<string, typeof fields>);

  const formatCurrency = (val: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);

  return (
    <div className="space-y-6">
      {Object.entries(grouped).map(([group, groupFields]) => (
        <div key={group} className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
          <div className="bg-slate-50 px-6 py-3 border-b border-slate-200">
            <h4 className="text-sm font-bold text-slate-700 uppercase tracking-wider">{group}</h4>
          </div>
          <div className="divide-y divide-slate-100">
            {groupFields.map((field) => (
              <div key={field.key} className="flex items-center justify-between px-6 py-4 hover:bg-slate-50/50 transition-colors">
                <span className="text-slate-600 font-medium">{field.label}</span>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-slate-400 font-mono">{formatCurrency(data[field.key])}</span>
                  <input
                    type="number"
                    value={data[field.key] ?? 0}
                    onChange={(e) => onUpdate(field.key, Number(e.target.value))}
                    className="w-32 px-3 py-1.5 border border-slate-200 rounded-lg text-right font-mono focus:ring-2 focus:ring-bluebonnet focus:border-bluebonnet outline-none"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

export default FinancialTable;
