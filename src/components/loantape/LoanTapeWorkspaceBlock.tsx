import React from 'react';
import {
  BarChart3,
  LineChart as LineChartIcon,
  PieChart as PieChartIcon,
  Sparkles,
  Table2,
  Trash2,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  LoanTapeBlockColumn,
  LoanTapeBlockType,
  LoanTapeWorkspaceBlock,
} from '../../lib/loanTapeWorkspace';

interface Props {
  item: LoanTapeWorkspaceBlock;
  onDelete: () => void;
  onTypeChange: (type: LoanTapeBlockType) => void;
}

const CHART_COLORS = ['#6366f1', '#06b6d4', '#f59e0b', '#f43f5e', '#10b981', '#8b5cf6'];

const fmtMoney = (value: number) => new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  maximumFractionDigits: 0,
}).format(value || 0);

function formatBlockValue(value: any, format?: string) {
  if (format === 'money') return fmtMoney(Number(value) || 0);
  if (format === 'pct') return `${((Number(value) || 0) * 100).toFixed(1)}%`;
  if (format === 'number') return new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 }).format(Number(value) || 0);
  return String(value ?? '—');
}

const LoanTapeWorkspaceBlockView: React.FC<Props> = ({ item, onDelete, onTypeChange }) => {
  const series = item.series || [];
  const tableColumns: LoanTapeBlockColumn[] = item.columns
    || Object.keys(item.data[0] || {}).map(key => ({ key, label: key }));
  const chartTypes: Array<{ type: LoanTapeBlockType; icon: React.ReactNode }> = [
    { type: 'table', icon: <Table2 className="w-3.5 h-3.5" /> },
    { type: 'bar', icon: <BarChart3 className="w-3.5 h-3.5" /> },
    { type: 'line', icon: <LineChartIcon className="w-3.5 h-3.5" /> },
    { type: 'pie', icon: <PieChartIcon className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
      <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-indigo-500" />
            <h4 className="font-black text-slate-900">{item.title}</h4>
          </div>
          <p className="text-xs text-slate-500 mt-1">{item.description}</p>
          <p className="text-[10px] font-bold text-indigo-500 mt-2">“{item.prompt}”</p>
        </div>
        <div className="flex items-center gap-1">
          {item.type !== 'kpi' && chartTypes.map(option => (
            <button
              key={option.type}
              onClick={() => onTypeChange(option.type)}
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${item.type === option.type ? 'bg-indigo-100 text-indigo-700' : 'text-slate-400 hover:bg-slate-100'}`}
              title={`Ver como ${option.type}`}
            >
              {option.icon}
            </button>
          ))}
          <button onClick={onDelete} className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-300 hover:bg-rose-50 hover:text-rose-500">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="p-5">
        {item.type === 'kpi' && (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            {item.data.map((metric, index) => (
              <div key={index} className="bg-slate-50 rounded-xl p-4">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">{metric.label}</p>
                <p className="text-lg font-black text-slate-900 mt-1">{formatBlockValue(metric.value, metric.format)}</p>
              </div>
            ))}
          </div>
        )}
        {item.type === 'table' && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="bg-slate-50">
                {tableColumns.map(column => (
                  <th key={column.key} className="text-left px-3 py-2 font-black uppercase tracking-wider text-slate-600">{column.label}</th>
                ))}
              </tr></thead>
              <tbody>{item.data.slice(0, 20).map((row, index) => (
                <tr key={index} className="border-t border-slate-100">
                  {tableColumns.map(column => (
                    <td key={column.key} className="px-3 py-2.5 font-semibold text-slate-700">{formatBlockValue(row[column.key], column.format)}</td>
                  ))}
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {(item.type === 'bar' || item.type === 'line') && (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              {item.type === 'bar' ? (
                <BarChart data={item.data} margin={{ top: 10, right: 10, left: 10, bottom: 35 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey={item.xKey || 'name'} angle={-20} textAnchor="end" height={65} tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={value => series[0]?.format === 'money' ? `${Math.round(value / 1000)}k` : String(value)} />
                  <Tooltip formatter={(value: any, name: any) => [formatBlockValue(value, series.find(s => s.key === name)?.format), series.find(s => s.key === name)?.label || name]} />
                  <Legend />
                  {series.map(s => <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[5, 5, 0, 0]} />)}
                </BarChart>
              ) : (
                <LineChart data={item.data} margin={{ top: 10, right: 10, left: 10, bottom: 15 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey={item.xKey || 'name'} tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(value: any, name: any) => [formatBlockValue(value, series.find(s => s.key === name)?.format), series.find(s => s.key === name)?.label || name]} />
                  <Legend />
                  {series.map(s => <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={3} dot={{ r: 3 }} />)}
                </LineChart>
              )}
            </ResponsiveContainer>
          </div>
        )}
        {item.type === 'pie' && (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={item.data} dataKey={series[0]?.key || 'balance'} nameKey={item.xKey || 'name'} innerRadius={55} outerRadius={105} paddingAngle={2}>
                  {item.data.map((_, index) => <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(value: any) => formatBlockValue(value, series[0]?.format)} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
};

export default LoanTapeWorkspaceBlockView;
