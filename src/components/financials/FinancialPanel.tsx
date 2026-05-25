import React, { useState, useEffect, useRef } from 'react';
import { db, FinancialStatement_DB, Covenant_DB } from '../../db/index';
import { Session } from '../../services/auth';
import { AISettings, extractFinancials } from '../../services/ai';
import { Upload, Trash2, Download, Plus, X, TrendingUp, Edit2, Check, FileText } from 'lucide-react';
import * as XLSX from 'xlsx';
import { exportEstadosFinancieros } from '../../lib/export';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { standardRatios } from '../../lib/financialMetrics';

interface Props {
  clientId: string;
  clientName: string;
  session: Session;
  aiSettings: AISettings;
  covenants: Covenant_DB[];
  onStatementsChange: (stmts: FinancialStatement_DB[]) => void;
}

type StatementType = 'balance_general' | 'estado_resultados' | 'flujo_efectivo' | 'otro';

interface RawItem { name: string; value: number; statementType?: StatementType; }

interface ReviewStatement {
  period: string;
  periodDate: string;
  items: RawItem[];
}

interface ReviewState {
  companyName?: string;
  documentType?: string;
  fileName: string;
  statements: ReviewStatement[];
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function fmtNum(n: number): string {
  if (n === 0) return '—';
  return n.toLocaleString('es-MX', { maximumFractionDigits: 6 });
}

function normalizeName(value?: string): string {
  return (value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

const typeLabel: Record<StatementType, string> = {
  balance_general: 'Balance General',
  estado_resultados: 'Estado de Resultados',
  flujo_efectivo: 'Flujo de Efectivo',
  otro: 'Otro',
};

const EMPTY_MAPPED = {
  revenue: 0, cogs: 0, operatingExpenses: 0, ebitda: 0,
  interestExpense: 0, netIncome: 0, currentAssets: 0,
  currentLiabilities: 0, totalDebt: 0, totalAssets: 0, equity: 0,
};

const FinancialPanel: React.FC<Props> = ({ clientId, clientName, session, aiSettings, covenants, onStatementsChange }) => {
  const [statements, setStatements] = useState<FinancialStatement_DB[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [editingCell, setEditingCell] = useState<{ stmtId: string; itemIdx: number; field: 'name' | 'value' } | null>(null);
  const [editingRow, setEditingRow] = useState<{ key: string; name: string; statementType: StatementType } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [exporting, setExporting] = useState<'excel' | 'pdf' | null>(null);
  const [sectionFilter, setSectionFilter] = useState<StatementType | 'all'>('all');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const loadStatements = async () => {
    const stmts = await db.getStatements(clientId);
    stmts.sort((a, b) => a.periodDate.localeCompare(b.periodDate));
    setStatements(stmts);
    onStatementsChange(stmts);
    setLoading(false);
  };

  const commitRowEdit = async () => {
    if (!editingRow) return;
    for (const stmt of statements) {
      const updated = stmt.rawLineItems.map(item => {
        const key = `${item.statementType || 'otro'}||${item.name}`;
        if (key !== editingRow.key) return item;
        return { ...item, name: editingRow.name, statementType: editingRow.statementType };
      });
      await db.updateStatement(stmt.id, { rawLineItems: updated });
    }
    setEditingRow(null);
    await loadStatements();
  };

  useEffect(() => { loadStatements(); }, [clientId]);

  const handleFileSelect = async (file: File) => {
    if (!aiSettings.apiKey) { alert('Configure la API Key en Configuración'); return; }
    setUploading(true);
    try {
      let result;
      if (file.type.startsWith('image/') || file.type === 'application/pdf') {
        const base64 = await toBase64(file);
        result = await extractFinancials(aiSettings, { base64, mimeType: file.type }, clientName);
      } else {
        let text = '';
        if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
          const buffer = await file.arrayBuffer();
          const workbook = XLSX.read(buffer, { type: 'array' });
          text = workbook.SheetNames.map(sheetName => {
            const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true });
            return `SHEET: ${sheetName}\n${JSON.stringify(rows)}`;
          }).join('\n\n');
        } else {
          text = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsText(file);
          });
        }
        result = await extractFinancials(aiSettings, text, clientName);
      }

      setReview({
        companyName: result.companyName,
        documentType: result.documentType,
        fileName: file.name,
        statements: (result.statements || [result]).map(statement => ({
          period: statement.period,
          periodDate: statement.periodDate,
          items: statement.rawLineItems.map(i => ({
            name: i.name,
            value: i.value,
            statementType: (i.statementType || 'otro') as StatementType,
          })),
        })),
      });
    } catch (err: any) {
      alert(`Error al extraer datos: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  const handleSaveReview = async () => {
    if (!review) return;
    try {
      for (const statement of review.statements) {
        await db.createStatement({
          clientId,
          sourceCompanyName: review.companyName,
          documentType: review.documentType,
          period: statement.period,
          periodDate: statement.periodDate,
          fileName: review.fileName,
          rawLineItems: statement.items,
          mappedData: EMPTY_MAPPED,
          extraAccounts: [],
        });
      }
      setReview(null);
      await loadStatements();
    } catch (err: any) {
      alert(`Error al guardar: ${err.message}`);
    }
  };

  const handleDeleteStatement = async (id: string) => {
    if (!confirm('¿Eliminar este estado financiero?')) return;
    await db.deleteStatement(id);
    await loadStatements();
  };

  // Inline edit a raw item in an already-saved statement
  const commitEdit = async (stmtId: string, itemIdx: number, field: 'name' | 'value') => {
    const stmt = statements.find(s => s.id === stmtId);
    if (!stmt) return;
    const updated = stmt.rawLineItems.map((item, i) => {
      if (i !== itemIdx) return item;
      if (field === 'name') return { ...item, name: editValue };
      return { ...item, value: parseFloat(editValue) || 0 };
    });
    await db.updateStatement(stmtId, { rawLineItems: updated });
    setEditingCell(null);
    await loadStatements();
  };

  const handleExport = async (format: 'excel' | 'pdf') => {
    setExporting(format);
    try {
      await exportEstadosFinancieros(statements, clientName, format, format === 'pdf' ? panelRef.current ?? undefined : undefined);
    } finally {
      setExporting(null);
    }
  };

  // Build pivot table: all unique names × periods
  const allNames: string[] = [];
  const nameSet = new Set<string>();
  for (const stmt of statements) {
    for (const item of stmt.rawLineItems) {
      const key = `${item.statementType || 'otro'}||${item.name}`;
      if (!nameSet.has(key)) { nameSet.add(key); allNames.push(key); }
    }
  }
  const visibleNames = sectionFilter === 'all' ? allNames : allNames.filter(k => k.startsWith(`${sectionFilter}||`));
  const latest = statements.at(-1);
  const latestRatios = latest ? standardRatios(latest) : [];
  const chartData = statements.map(stmt => {
    const ratios = standardRatios(stmt);
    return {
      period: stmt.period,
      ingresos: ratios.find(r => r.key === 'revenue')?.value ?? null,
      ebitda: ratios.find(r => r.key === 'ebitda')?.value ?? null,
      deudaEbitda: ratios.find(r => r.key === 'debt_ebitda')?.value ?? null,
      corriente: ratios.find(r => r.key === 'current_ratio')?.value ?? null,
    };
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <svg className="animate-spin h-6 w-6 text-indigo-500" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
      </div>
    );
  }

  return (
    <div ref={panelRef} className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-black text-slate-900">Estados Financieros</h2>
          <p className="text-slate-500 text-sm mt-0.5">{statements.length} período{statements.length !== 1 ? 's' : ''} cargado{statements.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex gap-3">
          {statements.length > 0 && (
            <>
              <button
                onClick={() => handleExport('excel')}
                disabled={!!exporting}
                className="flex items-center gap-1.5 bg-white border border-slate-200 text-slate-600 font-bold px-3 py-2 rounded-xl text-xs hover:bg-slate-50 disabled:opacity-50 transition-all"
              >
                {exporting === 'excel' ? <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg> : <Download className="w-3.5 h-3.5" />}
                Excel
              </button>
              <button
                onClick={() => handleExport('pdf')}
                disabled={!!exporting}
                className="flex items-center gap-1.5 bg-white border border-slate-200 text-slate-600 font-bold px-3 py-2 rounded-xl text-xs hover:bg-slate-50 disabled:opacity-50 transition-all"
              >
                {exporting === 'pdf' ? <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg> : <FileText className="w-3.5 h-3.5" />}
                PDF
              </button>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls,.csv,.txt"
            className="hidden"
            onChange={e => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-400 text-white font-bold px-4 py-2.5 rounded-xl text-sm transition-all"
          >
            <Upload className="w-4 h-4" />
            {uploading ? 'Procesando...' : 'Subir EFF'}
          </button>
        </div>
      </div>

      {/* Multi-period pivot table */}
      {statements.length > 0 && (
        <>
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">Ratios automáticos</h3>
              <p className="text-xs text-slate-400 mt-1">Calculados del último periodo con cuentas extraídas; no inventa cuentas faltantes.</p>
            </div>
            <span className="text-xs font-mono text-slate-400">{latest?.period || ''}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {latestRatios.map(r => (
              <div key={r.key} className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">{r.label}</p>
                <p className="text-lg font-black text-slate-900 font-mono mt-1">{r.value === null ? 'N/A' : r.value.toLocaleString('es-MX', { maximumFractionDigits: 4 })}</p>
              </div>
            ))}
          </div>
          {statements.length > 1 && (
            <div className="h-64 mt-6">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="ingresos" name="Ingresos" stroke="#2563eb" dot={false} />
                  <Line type="monotone" dataKey="ebitda" name="EBITDA" stroke="#059669" dot={false} />
                  <Line type="monotone" dataKey="deudaEbitda" name="Deuda/EBITDA" stroke="#dc2626" dot={false} />
                  <Line type="monotone" dataKey="corriente" name="Razón Corriente" stroke="#d97706" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="flex gap-2 flex-wrap">
          {(['all', 'balance_general', 'estado_resultados', 'flujo_efectivo', 'otro'] as const).map(t => (
            <button key={t} onClick={() => setSectionFilter(t)} className={`px-3 py-2 rounded-xl text-xs font-black border ${sectionFilter === t ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200'}`}>
              {t === 'all' ? 'Todo' : typeLabel[t]}
            </button>
          ))}
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-900 text-white">
                  <th className="text-left px-5 py-3 text-xs font-black uppercase tracking-wider sticky left-0 bg-slate-900 min-w-[220px]">Cuenta</th>
                  {statements.map(s => (
                    <th key={s.id} className="text-right px-4 py-3 text-xs font-black uppercase tracking-wider whitespace-nowrap min-w-[120px]">
                      <div className="flex items-center justify-end gap-2">
                        <span>{s.period}</span>
                        <button
                          onClick={() => handleDeleteStatement(s.id)}
                          className="text-slate-400 hover:text-rose-400 transition-colors"
                          title="Eliminar período"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="text-[10px] font-normal text-slate-400 mt-0.5">{s.fileName}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleNames.map((key, rowIdx) => {
                  const [statementType, name] = key.split('||');
                  return (
                  <tr key={key} className={rowIdx % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                    <td className="px-5 py-2.5 text-xs font-semibold text-slate-700 sticky left-0 bg-inherit">
                      {editingRow?.key === key ? (
                        <div className="space-y-1">
                          <select
                            value={editingRow.statementType}
                            onChange={e => setEditingRow({ ...editingRow, statementType: e.target.value as StatementType })}
                            className="w-full bg-white border border-indigo-200 rounded px-2 py-1 text-[10px] font-bold"
                          >
                            <option value="balance_general">Balance General</option>
                            <option value="estado_resultados">Estado de Resultados</option>
                            <option value="flujo_efectivo">Flujo de Efectivo</option>
                            <option value="otro">Otro</option>
                          </select>
                          <div className="flex gap-1">
                            <input
                              value={editingRow.name}
                              onChange={e => setEditingRow({ ...editingRow, name: e.target.value })}
                              onKeyDown={e => { if (e.key === 'Enter') commitRowEdit(); if (e.key === 'Escape') setEditingRow(null); }}
                              className="flex-1 bg-white border border-indigo-200 rounded px-2 py-1 text-xs"
                              autoFocus
                            />
                            <button onClick={commitRowEdit} className="text-emerald-600"><Check className="w-3.5 h-3.5" /></button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setEditingRow({ key, name, statementType: (statementType as StatementType) || 'otro' })}
                          className="text-left w-full hover:text-indigo-600"
                          title="Editar sección / cuenta"
                        >
                          <span className="block text-[9px] font-black uppercase tracking-wider text-indigo-500">{typeLabel[(statementType as StatementType) || 'otro'] || statementType}</span>
                          {name}
                          <Edit2 className="inline-block ml-1 w-2.5 h-2.5 opacity-40" />
                        </button>
                      )}
                    </td>
                    {statements.map(s => {
                      const found = s.rawLineItems.find(i => `${i.statementType || 'otro'}||${i.name}` === key);
                      const itemIdx = s.rawLineItems.findIndex(i => `${i.statementType || 'otro'}||${i.name}` === key);
                      const isEditing = editingCell?.stmtId === s.id && editingCell?.itemIdx === itemIdx && editingCell?.field === 'value';
                      return (
                        <td key={s.id} className="px-4 py-2.5 text-right font-mono text-xs text-slate-800">
                          {found === undefined ? (
                            <span className="text-slate-300">—</span>
                          ) : isEditing ? (
                            <div className="flex items-center justify-end gap-1">
                              <input
                                type="number"
                                value={editValue}
                                onChange={e => setEditValue(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') commitEdit(s.id, itemIdx, 'value'); if (e.key === 'Escape') setEditingCell(null); }}
                                autoFocus
                                className="w-28 bg-white border border-indigo-400 rounded px-2 py-1 text-xs font-mono text-right focus:outline-none"
                              />
                              <button onClick={() => commitEdit(s.id, itemIdx, 'value')} className="text-emerald-600 hover:text-emerald-700">
                                <Check className="w-3 h-3" />
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => { setEditingCell({ stmtId: s.id, itemIdx, field: 'value' }); setEditValue(String(found.value)); }}
                              className="group flex items-center justify-end gap-1 w-full hover:text-indigo-600"
                              title="Clic para editar"
                            >
                              {fmtNum(found.value)}
                              <Edit2 className="w-2.5 h-2.5 opacity-0 group-hover:opacity-40 transition-opacity" />
                            </button>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                )})}
                {visibleNames.length === 0 && (
                  <tr>
                    <td colSpan={statements.length + 1} className="px-5 py-8 text-center text-slate-400 text-sm">
                      Sin cuentas en estos estados financieros
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="px-5 py-2.5 bg-slate-50 border-t border-slate-100">
            <p className="text-xs text-slate-400">Haz clic en cualquier valor para editarlo · Los nombres de cuentas se muestran tal como fueron extraídos</p>
          </div>
        </div>
        </>
      )}

      {/* Empty state */}
      {statements.length === 0 && !uploading && (
        <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center">
          <TrendingUp className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 font-semibold">Sin estados financieros</p>
          <p className="text-slate-400 text-sm mt-1">Sube un EFF en PDF, imagen, Excel o texto para comenzar</p>
        </div>
      )}

      {/* Review modal */}
      {review && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-8">
            <div className="flex items-center justify-between p-6 border-b border-slate-100">
              <div>
                <h3 className="font-black text-slate-900">Revisar Extracción</h3>
                <p className="text-slate-500 text-sm mt-0.5">
                  {review.statements.length} periodo(s), {review.statements.reduce((sum, s) => sum + s.items.length, 0)} cuentas extraídas — verifica antes de guardar
                </p>
              </div>
              <button onClick={() => setReview(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-black text-slate-600 uppercase tracking-widest mb-1">Entidad detectada</p>
                <p className="text-sm font-bold text-slate-900">{review.companyName || 'No detectada'}</p>
                {review.companyName && normalizeName(review.companyName) !== normalizeName(clientName) && (
                  <p className="mt-2 text-xs font-bold text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                    Revisar: el documento dice "{review.companyName}" y el cliente abierto es "{clientName}".
                  </p>
                )}
                {review.documentType && (
                  <p className="text-xs text-slate-400 mt-1">Tipo: {review.documentType}</p>
                )}
              </div>

              {review.statements.map((statement, statementIndex) => (
                <div key={statementIndex} className="border border-slate-200 rounded-xl overflow-hidden">
                  <div className="bg-slate-100 p-4 grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Período</label>
                      <input
                        value={statement.period}
                        onChange={e => setReview(prev => {
                          if (!prev) return null;
                          const statements = [...prev.statements];
                          statements[statementIndex] = { ...statements[statementIndex], period: e.target.value };
                          return { ...prev, statements };
                        })}
                        className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Fecha de cierre</label>
                      <input
                        type="date"
                        value={statement.periodDate}
                        onChange={e => setReview(prev => {
                          if (!prev) return null;
                          const statements = [...prev.statements];
                          statements[statementIndex] = { ...statements[statementIndex], periodDate: e.target.value };
                          return { ...prev, statements };
                        })}
                        className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between px-4 py-3 bg-white">
                    <p className="text-xs font-black text-slate-700 uppercase tracking-widest">Cuentas Extraídas</p>
                    <button
                      onClick={() => setReview(prev => {
                        if (!prev) return null;
                        const statements = [...prev.statements];
                        statements[statementIndex] = { ...statements[statementIndex], items: [...statements[statementIndex].items, { statementType: 'otro', name: '', value: 0 }] };
                        return { ...prev, statements };
                      })}
                      className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-700 font-bold"
                    >
                      <Plus className="w-3.5 h-3.5" /> Agregar fila
                    </button>
                  </div>
                  <div className="bg-slate-50 max-h-80 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-slate-100">
                        <tr>
                          <th className="text-left px-4 py-2 text-xs font-black text-slate-600 uppercase tracking-wider w-44">Sección</th>
                          <th className="text-left px-4 py-2 text-xs font-black text-slate-600 uppercase tracking-wider">Cuenta</th>
                          <th className="text-right px-4 py-2 text-xs font-black text-slate-600 uppercase tracking-wider w-36">Valor</th>
                          <th className="w-8" />
                        </tr>
                      </thead>
                      <tbody>
                        {statement.items.map((item, itemIndex) => (
                          <tr key={itemIndex} className={itemIndex % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}>
                            <td className="px-4 py-1.5">
                              <select
                                value={item.statementType || 'otro'}
                                onChange={e => setReview(prev => {
                                  if (!prev) return null;
                                  const statements = [...prev.statements];
                                  const items = [...statements[statementIndex].items];
                                  items[itemIndex] = { ...items[itemIndex], statementType: e.target.value as StatementType };
                                  statements[statementIndex] = { ...statements[statementIndex], items };
                                  return { ...prev, statements };
                                })}
                                className="w-full bg-transparent text-xs text-slate-700 focus:outline-none focus:bg-white focus:ring-1 focus:ring-indigo-300 rounded px-1 py-0.5"
                              >
                                <option value="balance_general">Balance General</option>
                                <option value="estado_resultados">Estado de Resultados</option>
                                <option value="flujo_efectivo">Flujo de Efectivo</option>
                                <option value="otro">Otro</option>
                              </select>
                            </td>
                            <td className="px-4 py-1.5">
                              <input
                                value={item.name}
                                onChange={e => setReview(prev => {
                                  if (!prev) return null;
                                  const statements = [...prev.statements];
                                  const items = [...statements[statementIndex].items];
                                  items[itemIndex] = { ...items[itemIndex], name: e.target.value };
                                  statements[statementIndex] = { ...statements[statementIndex], items };
                                  return { ...prev, statements };
                                })}
                                className="w-full bg-transparent text-xs text-slate-800 focus:outline-none focus:bg-white focus:ring-1 focus:ring-indigo-300 rounded px-1 py-0.5"
                              />
                            </td>
                            <td className="px-4 py-1.5">
                              <input
                                type="number"
                                value={item.value}
                                onChange={e => setReview(prev => {
                                  if (!prev) return null;
                                  const statements = [...prev.statements];
                                  const items = [...statements[statementIndex].items];
                                  items[itemIndex] = { ...items[itemIndex], value: parseFloat(e.target.value) || 0 };
                                  statements[statementIndex] = { ...statements[statementIndex], items };
                                  return { ...prev, statements };
                                })}
                                className="w-full bg-transparent text-xs font-mono text-right text-slate-800 focus:outline-none focus:bg-white focus:ring-1 focus:ring-indigo-300 rounded px-1 py-0.5"
                              />
                            </td>
                            <td className="px-2">
                              <button
                                onClick={() => setReview(prev => {
                                  if (!prev) return null;
                                  const statements = [...prev.statements];
                                  statements[statementIndex] = { ...statements[statementIndex], items: statements[statementIndex].items.filter((_, i) => i !== itemIndex) };
                                  return { ...prev, statements };
                                })}
                                className="text-slate-300 hover:text-rose-500 transition-colors"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex gap-3 p-6 border-t border-slate-100">
              <button
                onClick={() => setReview(null)}
                className="flex-1 py-3 rounded-xl border border-slate-200 text-slate-700 text-sm font-bold hover:bg-slate-50 transition-all"
              >
                Cancelar
              </button>
              <button
                onClick={handleSaveReview}
                disabled={review.statements.some(s => !s.period)}
                className="flex-1 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-black transition-all"
              >
                Guardar {review.statements.length} periodo(s)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FinancialPanel;
