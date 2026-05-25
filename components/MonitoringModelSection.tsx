import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { Company } from '../types';
import { GeminiService, MonitoreoExtraction } from '../services/geminiService';
import { Download, FileSpreadsheet } from 'lucide-react';
import { accountLabels, evaluateFormula, formatNumber } from '../utils/financialFormula';

interface MonitoringModelSectionProps {
  company: Company;
  gemini: GeminiService;
  onUpdateCompany: (updates: Partial<Company>) => void;
}

function fmt(value: number | null | undefined, pct = false) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/D';
  if (pct) return `${(value * 100).toFixed(2)}%`;
  return value.toLocaleString('es-MX', { maximumFractionDigits: 2 });
}

const MonitoringModelSection: React.FC<MonitoringModelSectionProps> = ({ company, gemini, onUpdateCompany }) => {
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState('');
  const [selectedStatementId, setSelectedStatementId] = useState(company.statements[0]?.id ?? '');

  const monitoreo = (company as any).monitoreoData as MonitoreoExtraction | undefined;
  const selectedStatement = useMemo(
    () => company.statements.find(s => s.id === selectedStatementId) || company.statements[0],
    [company.statements, selectedStatementId]
  );

  const periodMetrics = selectedStatement
    ? company.covenants.map(covenant => {
      const result = evaluateFormula(covenant.formula, selectedStatement.data);
      return {
        name: covenant.name,
        formula: covenant.formula,
        threshold: `${covenant.operator.toUpperCase()} ${covenant.threshold}`,
        value: result.value,
        source: result.missing.length ? `Falta: ${result.missing.join(', ')}` : 'Estado financiero del periodo seleccionado',
      };
    })
    : [];

  const hasContractBase =
    company.covenants.length > 0 ||
    company.condicionesHacer.length > 0 ||
    company.condicionesNoHacer.length > 0;
  const canExport = Boolean(selectedStatement && hasContractBase);

  const loadTemplate = async () => {
    const response = await fetch('/templates/modelo-monitoreo-template.xlsx');
    if (!response.ok) throw new Error('No se encontró el template de monitoreo.');
    return response.arrayBuffer();
  };

  useEffect(() => {
    if (monitoreo) return;
    loadTemplate()
      .then(buffer => {
        const extraction = gemini.parseMonitoreoExcel(buffer);
        onUpdateCompany({ monitoreoData: extraction } as any);
      })
      .catch(error => setError(error?.message || 'No se pudo cargar el template interno.'));
  }, []);

  const exportWorkbook = async () => {
    if (!selectedStatement) return;
    setIsExporting(true);
    setError('');
    try {

    const wb = XLSX.read(await loadTemplate(), { type: 'array', cellFormula: true, cellStyles: true });
    const accounts = Object.entries(selectedStatement.data).map(([key, value]) => [
      accountLabels[key] || key,
      value,
      selectedStatement.period,
      'Extraído del estado financiero y aprobado por usuario',
    ]);

    wb.Sheets['Periodo Seleccionado'] = XLSX.utils.aoa_to_sheet([
      ['Cuenta', 'Valor', 'Periodo', 'Fuente'],
      ...accounts,
      [],
      ['Línea cruda', 'Valor', 'Fuente'],
      ...(selectedStatement.rawLineItems || []).map(item => [item.name, item.value, item.source || selectedStatement.period]),
      [],
      ['Covenant', 'Fórmula', 'Umbral', 'Resultado', 'Fuente'],
      ...periodMetrics.map(m => [m.name, m.formula, m.threshold, fmt(m.value), m.source]),
    ]);
    if (!wb.SheetNames.includes('Periodo Seleccionado')) {
      wb.SheetNames.unshift('Periodo Seleccionado');
    }

    XLSX.writeFile(wb, `Modelo de Monitoreo - ${company.name} - ${selectedStatement.period}.xlsx`);
    } catch (error: any) {
      setError(error?.message || 'No se pudo exportar el modelo.');
    }
    setIsExporting(false);
  };

  return (
    <div className="space-y-8 pb-20">
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <p className="text-[10px] font-black text-bluebonnet uppercase tracking-widest">Modelo de Monitoreo</p>
          <h1 className="text-4xl font-black text-slate-900 tracking-tight">{company.name}</h1>
          <p className="text-sm text-slate-500 font-bold mt-1">Cálculo por periodo seleccionado. Sin cuentas inventadas.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={exportWorkbook} disabled={!canExport || isExporting} className="flex items-center gap-2 bg-bluebonnet text-white px-4 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest disabled:opacity-40">
            <Download className="w-4 h-4" />
            {isExporting ? 'Exportando...' : 'Exportar Excel'}
          </button>
        </div>
      </header>

      {error && (
        <div className="bg-rose-50 border border-rose-100 rounded-2xl px-4 py-3 text-xs font-bold text-rose-700">
          {error}
        </div>
      )}

      <section className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6">
          <div>
            <h2 className="text-xl font-black text-slate-900">Periodo de trabajo</h2>
            <p className="text-xs text-slate-500 font-bold mt-1">Las razones se calculan solo con la información de este periodo.</p>
            {!hasContractBase && (
              <p className="text-xs text-rose-600 font-black mt-2">Falta cargar contrato / covenants antes de exportar.</p>
            )}
          </div>
          <select
            value={selectedStatement?.id || ''}
            onChange={event => setSelectedStatementId(event.target.value)}
            className="bg-slate-50 border border-slate-200 px-4 py-3 rounded-xl font-bold outline-none focus:ring-2 focus:ring-bluebonnet"
          >
            {company.statements.length === 0 && <option value="">Sin estados financieros</option>}
            {company.statements.map(statement => (
              <option key={statement.id} value={statement.id}>{statement.period}</option>
            ))}
          </select>
        </div>

        {!selectedStatement ? (
          <div className="py-16 text-center border-2 border-dashed border-slate-200 rounded-2xl">
            <FileSpreadsheet className="w-8 h-8 text-slate-300 mx-auto mb-3" />
            <p className="text-sm font-black text-slate-400 uppercase tracking-widest">Sube un estado financiero primero</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div className="border border-slate-100 rounded-2xl overflow-hidden">
              <div className="bg-slate-50 px-5 py-4">
                <h3 className="font-black text-slate-900">Variables aprobadas</h3>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {Object.entries(selectedStatement.data).map(([key, value]) => (
                    <tr key={key} className="border-t border-slate-100">
                      <td className="p-3 font-bold text-slate-700">{accountLabels[key] || key}</td>
                      <td className="p-3 text-right font-mono">{formatNumber(value as number)}</td>
                      <td className="p-3 text-[11px] text-slate-400">Periodo {selectedStatement.period}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="border border-slate-100 rounded-2xl overflow-hidden">
              <div className="bg-slate-50 px-5 py-4">
                <h3 className="font-black text-slate-900">Covenants del periodo</h3>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {periodMetrics.map(metric => (
                    <tr key={metric.name} className="border-t border-slate-100">
                      <td className="p-3">
                        <p className="font-black text-bluebonnet">{metric.name}</p>
                        <p className="text-[11px] text-slate-500 font-mono">{metric.formula}</p>
                        <p className="text-[10px] text-slate-400">{metric.source}</p>
                      </td>
                      <td className="p-3 text-right">
                        <p className="font-mono font-black">{fmt(metric.value)}</p>
                        <p className="text-[10px] text-slate-400">{metric.threshold}</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {(selectedStatement.rawLineItems || []).length > 0 && (
              <div className="xl:col-span-2 border border-slate-100 rounded-2xl overflow-hidden">
                <div className="bg-slate-50 px-5 py-4">
                  <h3 className="font-black text-slate-900">Líneas crudas extraídas</h3>
                </div>
                <table className="w-full text-sm">
                  <tbody>
                    {(selectedStatement.rawLineItems || []).map((item, index) => (
                      <tr key={`${item.name}-${index}`} className="border-t border-slate-100">
                        <td className="p-3 font-bold text-slate-700">{item.name}</td>
                        <td className="p-3 text-right font-mono">{formatNumber(item.value)}</td>
                        <td className="p-3 text-[11px] text-slate-400">{item.source || selectedStatement.period}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>

      {monitoreo && (
        <section className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm">
          <h2 className="text-xl font-black text-slate-900 mb-2">Template de monitoreo interno</h2>
          <p className="text-xs text-slate-500 font-bold mb-6">{monitoreo.rows.length} filas detectadas / {monitoreo.periods.length} periodos.</p>
          <div className="overflow-x-auto border border-slate-100 rounded-2xl max-h-[520px]">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 sticky top-0">
                <tr>
                  <th className="text-left p-3 min-w-[280px]">Covenant / Métrica</th>
                  {monitoreo.periods.map(period => <th key={period} className="p-3 text-right">{period}</th>)}
                </tr>
              </thead>
              <tbody>
                {monitoreo.rows.map((row, index) => (
                  <tr key={`${row.covenantName}-${index}`} className="border-t border-slate-100">
                    <td className="p-3 font-semibold text-slate-700">{row.covenantName}</td>
                    {monitoreo.periods.map(period => <td key={period} className="p-3 text-right font-mono">{row.values[period] || '-'}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
};

export default MonitoringModelSection;
