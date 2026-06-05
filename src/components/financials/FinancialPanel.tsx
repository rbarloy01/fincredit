import React, { useState, useEffect, useRef } from 'react';
import { db, FinancialStatement_DB, Covenant_DB } from '../../db/index';
import { Session } from '../../services/auth';
import { AISettings, extractFinancials } from '../../services/ai';
import { Upload, Trash2, Download, Plus, X, TrendingUp, Edit2, Check, FileText } from 'lucide-react';
import * as XLSX from 'xlsx';
import { DefinedConcept, exportEstadosFinancieros, VerticalBaseConfig } from '../../lib/export';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { evaluateFormula, formulaLabel, standardRatios } from '../../lib/financialMetrics';
import WorkingOverlay from '../common/WorkingOverlay';

interface Props {
  clientId: string;
  clientName: string;
  session: Session;
  aiSettings: AISettings;
  covenants: Covenant_DB[];
  onStatementsChange: (stmts: FinancialStatement_DB[]) => void;
  onCovenantsChange: (covenants: Covenant_DB[]) => void;
}

type StatementType = 'balance_general' | 'estado_resultados' | 'flujo_efectivo' | 'otro';

interface RawItem { name: string; value: number; sectionPath?: string | null; statementType?: StatementType; }

interface ReviewStatement {
  period: string;
  periodDate: string;
  fileName: string;
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

export function classifyAccount(statementType: string, name: string, sectionPath?: string | null): string {
  const path = normalizeName(sectionPath || '');
  if (path.includes('estadoresultado')) return 'Estado de Resultados';
  if (path.includes('flujoefectivo')) return 'Flujo de Efectivo';
  const n = normalizeName(name);
  if (statementType === 'estado_resultados') return 'Estado de Resultados';
  if (statementType === 'flujo_efectivo') return 'Flujo de Efectivo';
  if (statementType !== 'balance_general') return 'Otros';
  if (/(capital|patrimonio|resultadoacumulado|utilidadretenida|capitalcontable|resultadodelejercicio)/.test(n)) return 'CAPITAL';
  if (/(pasivo|proveedor|acreedor|deuda|obligacion|prestamo|impuesto|seguro|social|imss|isr|iva|ptu|provision|cuentaporpagar|cxp)/.test(n)) return 'PASIVO';
  if (/(activo|caja|banco|efectivo|cliente|cuentaporcobrar|inventario|propiedad|equipo|intangible)/.test(n)) return 'ACTIVO';
  if (path.includes('pasivo') && !path.includes('capital') && !path.includes('patrimonio')) return 'PASIVO';
  if (path.includes('capital') || path.includes('patrimonio')) return 'CAPITAL';
  if (path.includes('activo')) return 'ACTIVO';
  if (/(capital|patrimonio|resultadoacumulado|utilidadretenida)/.test(n)) return 'CAPITAL';
  if (/(pasivo|proveedor|acreedor|deuda|obligacion|prestamo)/.test(n)) return 'PASIVO';
  if (/(activo|caja|banco|efectivo|cliente|cuentaporcobrar|inventario|propiedad|equipo|intangible)/.test(n)) return 'ACTIVO';
  return 'Balance General sin clasificar';
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

const MAPPED_FIELDS = [
  ['revenue', 'Ingresos'],
  ['cogs', 'Costo de ventas'],
  ['operatingExpenses', 'Gastos operativos'],
  ['ebitda', 'EBITDA / Utilidad operativa'],
  ['interestExpense', 'Gasto financiero'],
  ['netIncome', 'Utilidad neta'],
  ['currentAssets', 'Activo corriente'],
  ['currentLiabilities', 'Pasivo corriente'],
  ['totalDebt', 'Deuda total'],
  ['totalAssets', 'Total activo'],
  ['equity', 'Total capital'],
] as const;

type MappedField = typeof MAPPED_FIELDS[number][0];

const FinancialPanel: React.FC<Props> = ({ clientId, clientName, session, aiSettings, covenants, onStatementsChange, onCovenantsChange }) => {
  const [statements, setStatements] = useState<FinancialStatement_DB[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [editingCell, setEditingCell] = useState<{ stmtId: string; itemIdx: number; field: 'name' | 'value' } | null>(null);
  const [editingRow, setEditingRow] = useState<{ key: string; name: string; statementType: StatementType } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [exporting, setExporting] = useState<'excel' | 'pdf' | null>(null);
  const [sectionFilter, setSectionFilter] = useState<StatementType | 'all'>('all');
  const [accountMappings, setAccountMappings] = useState<Record<string, MappedField | ''>>({});
  const [verticalBaseOverrides, setVerticalBaseOverrides] = useState<VerticalBaseConfig>({});
  const [concepts, setConcepts] = useState<DefinedConcept[]>([]);
  const [conceptName, setConceptName] = useState('');
  const [conceptTokens, setConceptTokens] = useState<string[]>([]);
  const [selectedConceptAccount, setSelectedConceptAccount] = useState('');
  const [conceptNumber, setConceptNumber] = useState('');
  const [hiddenPeriodIds, setHiddenPeriodIds] = useState<Record<string, boolean>>({});
  const [chartMetrics, setChartMetrics] = useState<Record<string, boolean>>({
    revenue: true,
    current_ratio: true,
    roa: true,
    roe: true,
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const mappingStorageKey = `finmonitor_eff_mappings_${clientId}`;
  const verticalBaseStorageKey = `finmonitor_vertical_bases_${clientId}`;
  const conceptsStorageKey = `finmonitor_defined_concepts_${clientId}`;

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
  useEffect(() => {
    db.getClientSetting<Record<string, MappedField | ''>>(clientId, mappingStorageKey, {}).then(setAccountMappings);
  }, [clientId, mappingStorageKey]);
  useEffect(() => {
    db.getClientSetting<VerticalBaseConfig>(clientId, verticalBaseStorageKey, {}).then(setVerticalBaseOverrides);
  }, [clientId, verticalBaseStorageKey]);
  useEffect(() => {
    db.getClientSetting<DefinedConcept[]>(clientId, conceptsStorageKey, []).then(setConcepts);
  }, [clientId, conceptsStorageKey]);

  const saveMapping = (key: string, field: MappedField | '') => {
    const next = { ...accountMappings, [key]: field };
    if (!field) delete next[key];
    setAccountMappings(next);
    void db.setClientSetting(clientId, mappingStorageKey, next);
  };

  const mappedForStatement = (stmt: FinancialStatement_DB) => {
    const next: FinancialStatement_DB['mappedData'] = { ...EMPTY_MAPPED };
    stmt.rawLineItems.forEach(item => {
      const key = `${item.statementType || 'otro'}||${item.name}`;
      const field = accountMappings[key];
      if (field) next[field] = (next[field] || 0) + (Number(item.value) || 0);
    });
    if (!next.ebitda && (next.revenue || next.cogs || next.operatingExpenses)) {
      next.ebitda = next.revenue - next.cogs - next.operatingExpenses;
    }
    return next;
  };

  const applyMappings = async () => {
    for (const stmt of statements) {
      await db.updateStatement(stmt.id, {
        mappedData: mappedForStatement(stmt),
        extraAccounts: Object.entries(accountMappings).filter(([, field]) => field).map(([key, field]) => ({ key, label: String(field), value: 0 })),
      });
    }
    await loadStatements();
  };

  const saveVerticalBase = (segment: string, key: string) => {
    const next = { ...verticalBaseOverrides, [segment]: key };
    if (!key) delete next[segment];
    setVerticalBaseOverrides(next);
    void db.setClientSetting(clientId, verticalBaseStorageKey, next);
  };

  const persistConcepts = (next: DefinedConcept[]) => {
    setConcepts(next);
    void db.setClientSetting(clientId, conceptsStorageKey, next);
  };

  const addConcept = () => {
    if (!conceptName.trim() || conceptTokens.length === 0) return;
    persistConcepts([...concepts, { id: crypto.randomUUID(), name: conceptName.trim(), tokens: conceptTokens }]);
    setConceptName('');
    setConceptTokens([]);
  };

  const extractFile = async (file: File) => {
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

    return {
      companyName: result.companyName,
      documentType: result.documentType,
      fileName: file.name,
      statements: (result.statements || [result]).map(statement => ({
        period: statement.period,
        periodDate: statement.periodDate,
        fileName: file.name,
        items: statement.rawLineItems.map(i => ({
          name: i.name,
          value: i.value,
          sectionPath: i.sectionPath || null,
          statementType: (i.statementType || 'otro') as StatementType,
        })),
      })),
    };
  };

  const handleFilesSelect = async (files: FileList | File[]) => {
    if (!aiSettings.apiKey) { alert('Configure la API Key en Configuración'); return; }
    const selected = Array.from(files);
    if (selected.length === 0) return;
    setUploading(true);
    try {
      const extracted = [];
      for (const file of selected) extracted.push(await extractFile(file));
      const first = extracted[0];
      setReview({
        companyName: first.companyName,
        documentType: selected.length === 1 ? first.documentType : `${selected.length} archivos`,
        fileName: selected.length === 1 ? first.fileName : `${selected.length} archivos`,
        statements: extracted.flatMap(item => item.statements),
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
          fileName: statement.fileName || review.fileName,
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
      await exportEstadosFinancieros(
        statements,
        clientName,
        format,
        format === 'pdf' ? panelRef.current ?? undefined : undefined,
        covenants,
        verticalBaseOverrides,
        concepts,
      );
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
  const visibleStatements = statements.filter(s => !hiddenPeriodIds[s.id]);
  const latest = visibleStatements.at(-1) || statements.at(-1);
  const latestRatios = latest ? standardRatios(latest) : [];
  const uploadedFiles = new Set(statements.map(s => s.fileName).filter(Boolean));
  const conceptLabels: Record<string, string> = {};
  allNames.forEach(key => {
    const [statementType, name] = key.split('||');
    conceptLabels[`account:${statementType}::${name}`] = name;
  });
  const conceptFormula = conceptTokens.length ? `expr:${JSON.stringify(conceptTokens)}` : '';
  const chartMetricDefs = [
    ['revenue', 'Ingresos', '#2563eb'],
    ['ebitda', 'EBITDA', '#059669'],
    ['debt_ebitda', 'Deuda/EBITDA', '#dc2626'],
    ['dscr', 'DSCR', '#7c3aed'],
    ['current_ratio', 'Razón Corriente', '#d97706'],
    ['leverage', 'Deuda/Capital', '#0f766e'],
    ['roa', 'ROA', '#e11d48'],
    ['roe', 'ROE', '#4338ca'],
  ] as const;
  const chartData = visibleStatements.map(stmt => {
    const ratios = standardRatios(stmt);
    const row: Record<string, string | number | null> = { period: stmt.period };
    chartMetricDefs.forEach(([key]) => { row[key] = ratios.find(r => r.key === key)?.value ?? null; });
    return row;
  });
  const previous = visibleStatements.length > 1 ? visibleStatements.at(-2) : undefined;
  const valueFor = (stmt: FinancialStatement_DB | undefined, key: string) => {
    if (!stmt) return null;
    const item = stmt.rawLineItems.find(i => `${i.statementType || 'otro'}||${i.name}` === key);
    return item?.value ?? null;
  };
  const verticalBaseSegments = ['ACTIVO', 'PASIVO', 'CAPITAL', 'Estado de Resultados'] as const;
  const verticalBaseDefaultLabel: Record<string, string> = {
    ACTIVO: 'Auto: Total Activo',
    PASIVO: 'Auto: Total Pasivo',
    CAPITAL: 'Auto: Total Capital',
    'Estado de Resultados': 'Auto: Ingresos / Ventas',
  };
  const segmentForKey = (key: string) => {
    const [statementType, name] = key.split('||');
    const sample = statements.flatMap(s => s.rawLineItems).find(i => `${i.statementType || 'otro'}||${i.name}` === key);
    return classifyAccount(statementType, name, sample?.sectionPath);
  };
  const verticalBase = (stmt: FinancialStatement_DB | undefined, statementType: string, segment?: string) => {
    if (!stmt) return null;
    const customKey = segment ? verticalBaseOverrides[segment] : '';
    if (customKey) {
      const custom = customKey.startsWith('concept:')
        ? evaluateFormula(`expr:${JSON.stringify(concepts.find(c => c.id === customKey.slice('concept:'.length))?.tokens || [])}`, stmt)
        : valueFor(stmt, customKey);
      if (custom !== null) return custom;
    }
    const find = (names: string[]) => stmt.rawLineItems.find(i => {
      const n = normalizeName(i.name);
      return names.some(name => n.includes(normalizeName(name)));
    })?.value ?? null;
    if (segment === 'ACTIVO') return find(['suma del activo', 'total activo', 'activos totales']);
    if (segment === 'PASIVO') return find(['suma del pasivo', 'total pasivo', 'pasivos totales']);
    if (segment === 'CAPITAL') return find(['suma del capital', 'total capital', 'capital contable', 'patrimonio']);
    if (segment === 'Estado de Resultados') return find(['total ingresos', 'ingresos', 'ventas']);
    if (statementType === 'balance_general') return find(['suma del activo', 'total activo', 'activos totales']);
    if (statementType === 'estado_resultados') return find(['total ingresos', 'ingresos', 'ventas']);
    return null;
  };
  const analysisRows = visibleNames
    .map(key => {
      const [statementType, name] = key.split('||');
      const latestValue = valueFor(latest, key);
      const previousValue = valueFor(previous, key);
      const sample = statements.flatMap(s => s.rawLineItems).find(i => `${i.statementType || 'otro'}||${i.name}` === key);
      const segment = classifyAccount(statementType, name, sample?.sectionPath);
      const base = verticalBase(latest, statementType, segment);
      const vertical = latestValue !== null && base ? latestValue / base : null;
      const horizontal = latestValue !== null && previousValue !== null && previousValue !== 0 ? (latestValue - previousValue) / Math.abs(previousValue) : null;
      return { key, statementType, name, segment, latestValue, previousValue, vertical, horizontal };
    })
    .filter(r => visibleStatements.some(s => valueFor(s, r.key) !== null));
  const segmentOrder = ['ACTIVO', 'PASIVO', 'CAPITAL', 'Estado de Resultados', 'Flujo de Efectivo', 'Balance General sin clasificar', 'Otros'];
  const groupedAnalysisRows = segmentOrder
    .map(segment => ({ segment, rows: analysisRows.filter(r => r.segment === segment) }))
    .filter(group => group.rows.length > 0);

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
      <WorkingOverlay
        show={uploading || !!exporting}
        title={exporting ? 'Exportando' : 'Procesando EFF'}
        messages={[
          'Almost there...',
          'Working on it...',
          'Still moving...',
          'One more pass...',
          exporting ? 'Construyendo archivo...' : 'Leyendo estados financieros...',
          exporting ? 'Aplicando formato...' : 'Extrayendo cuentas y periodos...',
          exporting ? 'Preparando descarga...' : 'Preparando revisión...',
          exporting ? 'Acomodando hojas...' : 'Separando balance y resultados...',
          exporting ? 'Revisando fórmulas...' : 'Validando cuentas detectadas...',
          exporting ? 'Casi queda...' : 'Casi terminamos...',
        ]}
      />
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-black text-slate-900">Estados Financieros</h2>
          <p className="text-slate-500 text-sm mt-0.5">
            {uploadedFiles.size} archivo{uploadedFiles.size !== 1 ? 's' : ''} · {statements.length} período{statements.length !== 1 ? 's' : ''} cargado{statements.length !== 1 ? 's' : ''}
          </p>
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
            multiple
            accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls,.csv,.txt"
            className="hidden"
            onChange={e => {
              if (e.target.files?.length) handleFilesSelect(e.target.files);
              e.currentTarget.value = '';
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-400 text-white font-bold px-4 py-2.5 rounded-xl text-sm transition-all"
          >
            <Upload className="w-4 h-4" />
            {uploading ? 'Procesando...' : 'Subir EFF(s)'}
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
                <p className="text-[10px] text-slate-400 mt-1">{r.formula}</p>
                {r.missing.length > 0 && (
                  <p className="text-[10px] font-bold text-amber-700 mt-1">Falta: {r.missing.join(', ')}</p>
                )}
              </div>
            ))}
          </div>
          {statements.length > 1 && (
            <>
              <div className="mt-5">
                <p className="text-xs font-black text-slate-600 uppercase tracking-widest mb-2">¿Qué quieres ver en la gráfica?</p>
                <div className="flex flex-wrap gap-2">
                  {chartMetricDefs.map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setChartMetrics(p => ({ ...p, [key]: !p[key] }))}
                      className={`px-3 py-1.5 rounded-lg text-xs font-black border ${chartMetrics[key] ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-500 border-slate-200'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="h-64 mt-4">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend />
                    {chartMetricDefs.filter(([key]) => chartMetrics[key]).map(([key, label, color]) => (
                      <Line key={key} type="monotone" dataKey={key} name={label} stroke={color} dot={false} connectNulls />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </div>

        <div className="flex gap-2 flex-wrap">
          {(['all', 'balance_general', 'estado_resultados', 'flujo_efectivo', 'otro'] as const).map(t => (
            <button key={t} onClick={() => setSectionFilter(t)} className={`px-3 py-2 rounded-xl text-xs font-black border ${sectionFilter === t ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200'}`}>
              {t === 'all' ? 'Todo' : typeLabel[t]}
            </button>
          ))}
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-xs font-black text-slate-600 uppercase tracking-widest mb-3">Mostrar / ocultar periodos</p>
          <div className="flex flex-wrap gap-2">
            {statements.map(s => (
              <button
                key={s.id}
                onClick={() => setHiddenPeriodIds(p => ({ ...p, [s.id]: !p[s.id] }))}
                className={`px-3 py-2 rounded-xl text-xs font-black border ${hiddenPeriodIds[s.id] ? 'bg-slate-100 text-slate-400 border-slate-200' : 'bg-indigo-50 text-indigo-700 border-indigo-200'}`}
              >
                {hiddenPeriodIds[s.id] ? 'Oculto: ' : ''}{s.period}
              </button>
            ))}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <div className="mb-4">
            <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">Bases de análisis vertical</h3>
            <p className="text-xs text-slate-400 mt-1">Recomendado automático; cambia la cuenta base si no te gusta.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {verticalBaseSegments.map(segment => {
              const options = allNames.filter(key => segmentForKey(key) === segment);
              return (
                <div key={segment}>
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-1.5">{segment}</label>
                  <select
                    value={verticalBaseOverrides[segment] || ''}
                    onChange={e => saveVerticalBase(segment, e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  >
                    <option value="">{verticalBaseDefaultLabel[segment]}</option>
                    {concepts.map(concept => <option key={concept.id} value={`concept:${concept.id}`}>Concepto: {concept.name}</option>)}
                    {options.map(key => {
                      const [, name] = key.split('||');
                      return <option key={key} value={key}>{name}</option>;
                    })}
                  </select>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">Conceptos definidos</h3>
              <p className="text-xs text-slate-400 mt-1">Crea conceptos con cuentas extraídas: suma, resta, división, multiplicación, potencia y paréntesis.</p>
            </div>
            <button
              onClick={addConcept}
              disabled={!conceptName.trim() || conceptTokens.length === 0}
              className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-black px-3 py-2 rounded-xl text-xs"
            >
              <Plus className="w-3.5 h-3.5" /> Guardar
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-3 mb-4">
            <input
              value={conceptName}
              onChange={e => setConceptName(e.target.value)}
              placeholder="Nombre del concepto"
              className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
            <div className="flex flex-wrap gap-2">
              <select
                value={selectedConceptAccount}
                onChange={e => setSelectedConceptAccount(e.target.value)}
                className="min-w-[260px] bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold text-slate-700"
              >
                <option value="">Seleccionar cuenta extraída</option>
                {allNames.map(key => {
                  const [statementType, name] = key.split('||');
                  return <option key={key} value={`ref:account:${statementType}::${name}`}>{typeLabel[(statementType as StatementType) || 'otro']} / {name}</option>;
                })}
              </select>
              <button
                onClick={() => {
                  if (!selectedConceptAccount) return;
                  setConceptTokens(t => [...t, selectedConceptAccount]);
                  setSelectedConceptAccount('');
                }}
                className="px-3 py-2 rounded-xl text-xs font-black bg-slate-900 text-white"
              >
                Cuenta
              </button>
              {['+', '-', '*', '/', '^', '(', ')'].map(op => (
                <button key={op} onClick={() => setConceptTokens(t => [...t, op])} className="w-9 py-2 rounded-xl text-xs font-black bg-slate-100 text-slate-700 border border-slate-200">
                  {op}
                </button>
              ))}
              <input
                type="number"
                value={conceptNumber}
                onChange={e => setConceptNumber(e.target.value)}
                placeholder="Número"
                className="w-24 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold"
              />
              <button
                onClick={() => {
                  const n = Number(conceptNumber);
                  if (!Number.isFinite(n)) return;
                  setConceptTokens(t => [...t, `num:${conceptNumber}`]);
                  setConceptNumber('');
                }}
                className="px-3 py-2 rounded-xl text-xs font-black bg-slate-100 text-slate-700 border border-slate-200"
              >
                Número
              </button>
              <button onClick={() => setConceptTokens(t => t.slice(0, -1))} className="px-3 py-2 rounded-xl text-xs font-black bg-white text-slate-500 border border-slate-200">
                Borrar último
              </button>
            </div>
          </div>

          <div className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2 text-xs font-mono text-slate-700 mb-4 min-h-10">
            {conceptFormula ? formulaLabel(conceptFormula, conceptLabels) : 'Fórmula vacía'}
          </div>

          {concepts.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50">
                    <th className="text-left px-4 py-2 font-black text-slate-600 uppercase tracking-wider">Concepto</th>
                    <th className="text-left px-4 py-2 font-black text-slate-600 uppercase tracking-wider">Fórmula</th>
                    {visibleStatements.map(s => <th key={s.id} className="text-right px-4 py-2 font-black text-slate-600 uppercase tracking-wider">{s.period}</th>)}
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {concepts.map(concept => {
                    const formula = `expr:${JSON.stringify(concept.tokens)}`;
                    return (
                      <tr key={concept.id} className="border-t border-slate-100">
                        <td className="px-4 py-2 font-black text-slate-800">{concept.name}</td>
                        <td className="px-4 py-2 font-mono text-slate-500">{formulaLabel(formula, conceptLabels)}</td>
                        {visibleStatements.map(s => {
                          const value = evaluateFormula(formula, s);
                          return <td key={s.id} className="px-4 py-2 text-right font-mono text-slate-800">{value === null ? 'N/A' : fmtNum(value)}</td>;
                        })}
                        <td className="px-2 py-2 text-right">
                          <button onClick={() => persistConcepts(concepts.filter(c => c.id !== concept.id))} className="text-slate-300 hover:text-rose-500">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {latest && groupedAnalysisRows.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100">
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">Análisis vertical y horizontal</h3>
              <p className="text-xs text-slate-400 mt-1">Vertical por cada periodo; horizontal entre cada par consecutivo visible.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50">
                    <th className="text-left px-4 py-2 font-black text-slate-600 uppercase tracking-wider">Cuenta</th>
                    {visibleStatements.map(s => (
                      <React.Fragment key={s.id}>
                        <th className="text-right px-4 py-2 font-black text-slate-600 uppercase tracking-wider">{s.period}</th>
                        <th className="text-right px-4 py-2 font-black text-slate-600 uppercase tracking-wider">%V</th>
                      </React.Fragment>
                    ))}
                    {visibleStatements.slice(1).map(s => <th key={`${s.id}-h`} className="text-right px-4 py-2 font-black text-slate-600 uppercase tracking-wider">Δ% {s.period}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {groupedAnalysisRows.map(group => (
                    <React.Fragment key={group.segment}>
                      <tr className="bg-indigo-50">
                        <td colSpan={1 + visibleStatements.length * 2 + Math.max(0, visibleStatements.length - 1)} className="px-4 py-2 text-[11px] font-black text-indigo-900 uppercase tracking-widest">
                          {group.segment}
                        </td>
                      </tr>
                      {group.rows.map((row, i) => (
                        <tr key={row.key} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}>
                          <td className="px-4 py-2 font-semibold text-slate-700">
                            <span className="block text-[9px] font-black uppercase tracking-wider text-indigo-500">{typeLabel[(row.statementType as StatementType) || 'otro'] || row.statementType}</span>
                            {row.name}
                          </td>
                          {visibleStatements.map(s => {
                            const value = valueFor(s, row.key);
                            const base = verticalBase(s, row.statementType, row.segment);
                            const vertical = value !== null && base ? value / base : null;
                            return (
                              <React.Fragment key={s.id}>
                                <td className="px-4 py-2 text-right font-mono text-slate-900">{value === null ? '—' : fmtNum(value)}</td>
                                <td className="px-4 py-2 text-right font-mono text-slate-700">{vertical === null ? 'N/A' : `${(vertical * 100).toFixed(2)}%`}</td>
                              </React.Fragment>
                            );
                          })}
                          {visibleStatements.slice(1).map((s, idx) => {
                            const value = valueFor(s, row.key);
                            const prev = valueFor(visibleStatements[idx], row.key);
                            const horizontal = value !== null && prev !== null && prev !== 0 ? (value - prev) / Math.abs(prev) : null;
                            return <td key={`${s.id}-horiz`} className={`px-4 py-2 text-right font-mono ${horizontal === null ? 'text-slate-400' : horizontal >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{horizontal === null ? 'N/A' : `${(horizontal * 100).toFixed(2)}%`}</td>;
                          })}
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-900 text-white">
                  <th className="text-left px-5 py-3 text-xs font-black uppercase tracking-wider sticky left-0 bg-slate-900 min-w-[220px]">Cuenta</th>
                  {visibleStatements.map(s => (
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
                    {visibleStatements.map(s => {
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
                    <td colSpan={visibleStatements.length + 1} className="px-5 py-8 text-center text-slate-400 text-sm">
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
                    <div>
                      <p className="text-xs font-black text-slate-700 uppercase tracking-widest">Cuentas Extraídas</p>
                      <p className="text-[11px] font-semibold text-slate-400 mt-0.5">{statement.fileName}</p>
                    </div>
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
