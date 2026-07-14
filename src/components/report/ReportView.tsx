import React, { useRef, useState, useEffect } from 'react';
import { db, Client, FinancialStatement_DB, Covenant_DB, LoanTape_DB, CustomField, Transaction } from '../../db/index';
import { StructuredLoanTapeAnalysis } from '../../services/ai';
import { Download, ChevronDown, ChevronRight, MessageSquare, FileSpreadsheet, Upload, Trash2, ImageDown, ArrowUp, ArrowDown, Save, LayoutGrid } from 'lucide-react';
import {
  evaluateCovenantAuto,
  getMetric,
  prioritizedLatestCovenantPerformance,
} from '../../lib/financialMetrics';
import { canUseLegacyFacilityFallback, facilityDisplayName, matchesFacilityFilter } from '../../lib/facilityHistory';
import { parseFinancialNumber } from '../../lib/numberParsing';

interface Props {
  client: Client;
  statements: FinancialStatement_DB[];
  covenants: Covenant_DB[];
  loanTapes: LoanTape_DB[];
  transactions?: Transaction[];
  customFields?: CustomField[];
  onCustomFieldsChange?: (fields: CustomField[]) => void;
  onClientUpdate: (updates: Partial<Client>) => void;
  onClose: () => void;
}

// ── Inline style helpers (survive html2canvas) ─────────────────────────────────
const vc: React.CSSProperties = { display: 'flex', alignItems: 'center' };
const vcc: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center' };
const vccCol: React.CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' };
const tdV: React.CSSProperties = { verticalAlign: 'middle' };
const tdVC: React.CSSProperties = { verticalAlign: 'middle', textAlign: 'center' };

const sanitizeColors = (clonedDoc: Document) => {
  Array.from(clonedDoc.getElementsByTagName('style')).forEach(tag => {
    try {
      tag.innerHTML = tag.innerHTML
        .replace(/oklch\([^)]+\)/g, '#000000')
        .replace(/oklab\([^)]+\)/g, '#000000')
        .replace(/color-mix\([^)]+\)/g, '#000000');
    } catch (e) {}
  });
  const style = clonedDoc.createElement('style');
  style.innerHTML = `
    * {
      color-scheme: light !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      box-sizing: border-box !important;
      transform: none !important;
      transition: none !important;
      animation: none !important;
    }
    body { margin: 0 !important; padding: 0 !important; background: #ffffff !important; }
    .pdf-page, .pdf-page * {
      font-family: Arial, Helvetica, sans-serif !important;
      -webkit-font-smoothing: antialiased !important;
    }
    .pdf-page * {
      line-height: 1.25 !important;
    }
    table td, table th {
      vertical-align: middle !important;
      line-height: 1.2 !important;
    }
    .shadow-2xl, .shadow-sm, .shadow-lg, .shadow-xl { box-shadow: none !important; }
    .bg-emerald-500 { background-color: #10b981 !important; }
    .bg-rose-500 { background-color: #f43f5e !important; }
  `;
  clonedDoc.head.appendChild(style);
  Array.from(clonedDoc.getElementsByTagName('*')).forEach((el: any) => {
    const s = el.getAttribute?.('style') || '';
    if (s.includes('oklch') || s.includes('oklab') || s.includes('color-mix')) {
      el.setAttribute('style', s
        .replace(/oklch\([^)]+\)/g, '#000000')
        .replace(/oklab\([^)]+\)/g, '#000000')
        .replace(/color-mix\([^)]+\)/g, '#000000'));
    }
  });
};

const TH = (props: React.ThHTMLAttributes<HTMLTableCellElement>) => (
  <th {...props} style={{ ...tdV, backgroundColor: '#0018E6', color: '#ffffff', padding: '7px 9px', fontSize: 8, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.06em', border: '1px solid #0018E6', ...props.style }} />
);
const TD = (props: React.TdHTMLAttributes<HTMLTableCellElement>) => (
  <td {...props} style={{ ...tdV, padding: '7px 9px', fontSize: 9, borderBottom: '1px solid #f1f5f9', ...props.style }} />
);

const Check = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ display: 'block' }}>
    <path d="M2 6L5 9L10 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const Cross = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ display: 'block' }}>
    <path d="M3 3L9 9M9 3L3 9" stroke="white" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const StatusCircle = ({ status }: { status?: string }) => (
  <div style={{ ...vcc, width: 22, height: 22, minWidth: 22, borderRadius: '50%', backgroundColor: status === 'paid' ? '#10b981' : status === 'unpaid' ? '#f43f5e' : '#e2e8f0', margin: '0 auto' }}>
    {status === 'paid' && <Check />}
    {status === 'unpaid' && <Cross />}
  </div>
);

const BoolCircle = ({ val }: { val: boolean }) => (
  <div style={{ ...vcc, width: 20, height: 20, minWidth: 20, borderRadius: '50%', backgroundColor: val ? '#059669' : '#e11d48', margin: '0 auto' }}>
    {val ? <Check /> : <Cross />}
  </div>
);

const AforoCircle = ({ status }: { status: 'good' | 'warning' | 'bad' }) => {
  const color = status === 'good' ? '#059669' : status === 'warning' ? '#d97706' : '#e11d48';
  return (
    <div style={{ ...vcc, width: 20, height: 20, minWidth: 20, borderRadius: '50%', backgroundColor: color, margin: '0 auto', color: 'white', fontSize: 12, fontWeight: 900 }}>
      {status === 'good' ? <Check /> : status === 'warning' ? '!' : <Cross />}
    </div>
  );
};

const fmtMoney = (value: unknown, currency = 'MXN') => {
  const n = parseFinancialNumber(value, Number.NaN);
  if (!Number.isFinite(n)) return typeof value === 'string' && value.trim() ? value : '—';
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: currency || 'MXN',
    currencySign: 'accounting',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(n);
};

const normalizeText = (value: string) =>
  value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const covenantLooksPercent = (cov: Covenant_DB) => {
  const text = normalizeText(`${cov.name} ${cov.formula} ${cov.description} ${cov.threshold}`);
  if (/%/.test(cov.threshold)) return true;
  if (/(dscr|deuda\s*\/\s*ebitda|debt\s*\/\s*ebitda|deuda\s*\/\s*capital|debt\s*\/\s*equity|razon corriente|razón corriente|current ratio|liquidez inmediata)/i.test(text)) return false;
  return /(margen|rentabilidad|eficiencia|apalanc|capitalizacion|capitalización|icap|roa|roe|cartera vencida|cobertura|fondeo|yield|spread|totalassets|managedportfolio|corebusinessincome|equity\/totalassets|netincome\/|pastdue|portfolio|assets)/i.test(text);
};

const fmtPercent = (value: number, scaleFraction = true) => {
  const display = scaleFraction && Math.abs(value) <= 1 ? value * 100 : value;
  return `${display.toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 2 })}%`;
};

const fmtCovenantValue = (cov: Covenant_DB, value: number | null) => {
  if (value === null) return 'NA';
  if (covenantLooksPercent(cov)) return fmtPercent(value, true);
  return `${value.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}x`;
};

const fmtCovenantThreshold = (cov: Covenant_DB) => {
  if (!cov.threshold) return 'N/A';
  if (/[%$€£¥]|MXN|USD|EUR|x\b/i.test(cov.threshold)) return cov.threshold;
  const value = parseFinancialNumber(cov.threshold, Number.NaN);
  if (!Number.isFinite(value)) return cov.threshold;
  if (covenantLooksPercent(cov)) return fmtPercent(value, true);
  return `${value.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}x`;
};

const fmtAforoValue = (value?: string) => {
  if (!value) return '—';
  if (/[%$€£¥]|MXN|USD|EUR|x\b/i.test(value)) return value;
  const n = parseFinancialNumber(value, Number.NaN);
  if (!Number.isFinite(n)) return value;
  return `${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}x`;
};

const fmtDate = (d?: string) => {
  if (!d) return '—';
  if (/^\d{4}-\d{2}$/.test(d)) {
    const [y, m] = d.split('-');
    const months = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
    return `${months[parseInt(m) - 1]} ${y.substring(2)}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d.toUpperCase();
  const [y, m] = d.split('-');
  const months = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
  return `${months[parseInt(m) - 1]} ${y.substring(2)}`;
};

const monthKey = (value?: string) => {
  if (!value) return '';
  const match = value.match(/^(\d{4})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}`;
  return value.trim();
};

const addMonths = (month: string, delta: number) => {
  const key = monthKey(month);
  if (!/^\d{4}-\d{2}$/.test(key)) return month;
  const [year, monthIndex] = key.split('-').map(Number);
  const date = new Date(year, monthIndex - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

const monitoringWindow = (monitoringPeriod: string) => {
  const key = monthKey(monitoringPeriod);
  if (!/^\d{4}-\d{2}$/.test(key)) return key ? [key] : [];
  return Array.from({ length: 6 }, (_, index) => addMonths(key, -index));
};

const firstValidMonth = (...values: Array<string | undefined>) => {
  for (const value of values) {
    const key = monthKey(value);
    if (/^\d{4}-\d{2}$/.test(key)) return key;
  }
  return '';
};

type CondStatus = 'CUMPLE' | 'INCUMPLE' | 'ALERTA';

const STATUS_STYLE: Record<CondStatus, { bg: string; color: string; label: string }> = {
  CUMPLE:   { bg: '#d1fae520', color: '#065f46', label: 'CUMPLE' },
  ALERTA:   { bg: '#fef9c320', color: '#92400e', label: 'ALERTA' },
  INCUMPLE: { bg: '#fee2e220', color: '#991b1b', label: 'INCUMPLE' },
};

function evaluateCovenant(cov: Covenant_DB, statements: FinancialStatement_DB[]): { value: number | null; status: CondStatus } {
  const result = evaluateCovenantAuto(cov, statements);
  return { value: result.value, status: result.status.toUpperCase() as CondStatus };
}

const TAPE_PLACEHOLDER = `Describe el estado de la cartera. Considera incluir:

• Estado general: calidad crediticia y nivel de riesgo respecto al período anterior
• Morosidad: evolución de la cartera vencida (>30, >60, >90 días) vs. límites contractuales
• Concentraciones: sectores, regiones o productos con mayor exposición
• Aforo: cumplimiento del mínimo requerido y tendencia
• Situaciones especiales: créditos en reestructura, litigio o monitoreo especial
• Perspectiva: expectativa para el siguiente período de reporte`;

type ReportBlockId = 'payment' | 'aforo' | 'financialCovenants' | 'loanTape' | 'documentation' | 'opinion';

interface ReportBlockConfig {
  id: ReportBlockId;
  label: string;
  visible: boolean;
  order: number;
}

interface ReportTemplate {
  name: string;
  blocks: ReportBlockConfig[];
}

const DEFAULT_BLOCKS: ReportBlockConfig[] = [
  { id: 'payment', label: 'Cobranza', visible: true, order: 10 },
  { id: 'aforo', label: 'Aforo', visible: true, order: 20 },
  { id: 'financialCovenants', label: 'Covenants Financieros', visible: true, order: 30 },
  { id: 'loanTape', label: 'Loan Tape', visible: true, order: 40 },
  { id: 'documentation', label: 'Documentación', visible: true, order: 50 },
  { id: 'opinion', label: 'Opinión del Analista', visible: true, order: 60 },
];

const layoutKey = (clientId: string) => `finmonitor_report_layout_${clientId}`;
const layoutMigrationKey = (clientId: string) => `finmonitor_report_layout_v2_${clientId}`;
const templatesKey = (clientId: string) => `finmonitor_report_templates_${clientId}`;
const contractFooterKey = (clientId: string) => `finmonitor_report_show_contract_${clientId}`;
const selectedReportTransactionKey = (clientId: string) => `finmonitor_report_selected_transaction_${clientId}`;
type CovenantMeasurementFrequency = 'mensual' | 'trimestral' | 'semestral' | 'anual';
interface CovenantMeasurementConfig {
  frequency: CovenantMeasurementFrequency;
  startPeriod: string;
}
type CovenantMeasurementConfigMap = Record<string, CovenantMeasurementConfig>;
const covenantMeasurementKey = (clientId: string) => `finmonitor_covenant_measurement_${clientId}`;
const frequencyLabels: Record<CovenantMeasurementFrequency, string> = {
  mensual: 'Mensual',
  trimestral: 'Trimestral',
  semestral: 'Semestral',
  anual: 'Anual',
};
const reportFrequencyStepMonths: Record<CovenantMeasurementFrequency, number> = {
  mensual: 1,
  trimestral: 2,
  semestral: 5,
  anual: 11,
};

const normalizeReportBlocks = (saved: unknown): ReportBlockConfig[] => {
  const byId = new Map(
    Array.isArray(saved)
      ? saved
          .filter((block): block is Partial<ReportBlockConfig> & { id: ReportBlockId } =>
            !!block && typeof block === 'object' && DEFAULT_BLOCKS.some(defaultBlock => defaultBlock.id === (block as any).id))
          .map(block => [block.id, block])
      : [],
  );
  return DEFAULT_BLOCKS.map(defaultBlock => {
    const savedBlock = byId.get(defaultBlock.id);
    return {
      ...defaultBlock,
      visible: typeof savedBlock?.visible === 'boolean' ? savedBlock.visible : defaultBlock.visible,
      order: typeof savedBlock?.order === 'number' ? savedBlock.order : defaultBlock.order,
    };
  });
};

const normalizeReportTemplates = (saved: unknown): ReportTemplate[] => {
  if (!Array.isArray(saved)) return [];
  return saved
    .filter((template): template is { name: string; blocks: unknown } =>
      !!template && typeof template === 'object' && typeof (template as any).name === 'string')
    .map(template => ({
      name: template.name.trim() || 'Plantilla',
      blocks: normalizeReportBlocks(template.blocks),
    }));
};

const ClientReportView: React.FC<Props> = ({ client, statements, covenants, loanTapes, transactions = [], customFields = [], onCustomFieldsChange, onClientUpdate, onClose }) => {
  const page1Ref = useRef<HTMLDivElement>(null);
  const condRef = useRef<HTMLDivElement>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [editOpen, setEditOpen] = useState(true);
  const [reportMode, setReportMode] = useState<'inv' | 'interno'>('inv');
  const [showAforo, setShowAforo] = useState(true);
  const [showCovenants, setShowCovenants] = useState(true);
  const [showDocs, setShowDocs] = useState(true);
  const [showLoanTape, setShowLoanTape] = useState(true);
  const [blocks, setBlocks] = useState<ReportBlockConfig[]>(DEFAULT_BLOCKS);
  const [templateName, setTemplateName] = useState('Mi plantilla');
  const [savedTemplates, setSavedTemplates] = useState<ReportTemplate[]>([]);
  const [showContractFooter, setShowContractFooter] = useState(true);
  const [selectedReportTransactionId, setSelectedReportTransactionId] = useState('');
  const [covenantMeasurementConfig, setCovenantMeasurementConfig] = useState<CovenantMeasurementConfigMap>({});
  const [reportSettingsLoaded, setReportSettingsLoaded] = useState(false);
  const commercialField = customFields.find(f => f.id === 'commercial_name' || f.label === 'Nombre comercial');
  const commercialName = commercialField?.value || client.name;

  // ── Comment state ────────────────────────────────────────────────────────────
  const [condStatuses, setCondStatuses] = useState<Record<string, CondStatus>>({});
  const [condComments, setCondComments] = useState<Record<string, string>>({});
  const [tapeComment, setTapeComment] = useState('');
  const [contractCovenantKeys, setContractCovenantKeys] = useState<string[]>([]);

  useEffect(() => {
    db.getClientSetting<string[]>(client.id, `finmonitor_contract_covs_${client.id}`, []).then(setContractCovenantKeys);
    db.getClientSetting<CovenantMeasurementConfigMap>(client.id, covenantMeasurementKey(client.id), {}).then(setCovenantMeasurementConfig);
  }, [client.id]);

  const sortedStatements = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate));
  const latest = sortedStatements.length > 0 ? sortedStatements[sortedStatements.length - 1] : null;
  const latestTape = loanTapes.length > 0 ? loanTapes[0] : null;
  const tapeAnalysis: StructuredLoanTapeAnalysis | null = latestTape?.extractedData?._analysis || null;

  const transactionName = (transactionId?: string) => transactions.find(tx => tx.id === transactionId)?.name || '';
  const scopedFacilityName = (record: { transactionId?: string }) => facilityDisplayName(transactionName(record.transactionId), record);
  const selectedReportTransaction = transactions.find(tx => tx.id === selectedReportTransactionId);
  const selectedContractLabel = selectedReportTransaction?.name || client.contractName || '—';
  const canUseSelectedLegacyFallback = canUseLegacyFacilityFallback(selectedReportTransactionId, transactions.length);
  const latestPeriodKey = firstValidMonth(client.lastPeriod, latest?.periodDate, latest?.period, client.reportDate);
  const monitoringPeriod = latestPeriodKey || monthKey(new Date().toISOString());
  const aforoPeriodKeys = monitoringWindow(monitoringPeriod);
  const periodLabel = (period: string) => fmtDate(period);
  const covenantsForReport = covenants.filter(c => matchesFacilityFilter(c, selectedReportTransactionId, transactions.length));
  const paymentHistory = aforoPeriodKeys.map((month, index) => {
    const byMonth = (client.paymentHistory || []).filter(item => monthKey(item.month) === month);
    const existing = selectedReportTransactionId
      ? byMonth.find(item => item.transactionId === selectedReportTransactionId) || (canUseSelectedLegacyFallback ? byMonth.find(item => !item.transactionId) : undefined)
      : byMonth[0] || client.paymentHistory?.[index];
    return existing
      ? { ...existing, month }
      : { month, principalStatus: 'none' as const, interestStatus: 'none' as const, transactionId: selectedReportTransactionId || undefined };
  });
  const aforoHistory = aforoPeriodKeys.map(month => {
    const byMonth = (client.aforoHistory || []).filter(item => monthKey(item.month) === month);
    const selected = selectedReportTransactionId
      ? byMonth.find(item => item.transactionId === selectedReportTransactionId) || (canUseSelectedLegacyFallback ? byMonth.find(item => !item.transactionId) : undefined)
      : byMonth.find(item => !item.transactionId) || byMonth[0];
    return selected
      ? { ...selected, month }
      : { month, value: '', status: 'warning' as const, transactionId: selectedReportTransactionId || undefined };
  });
  const reportPeriods = paymentHistory.map(p => p.month || '').filter(Boolean);
  const reportPeriod = monitoringPeriod || latest?.period || reportPeriods.at(-1) || '—';
  const financialCovenantBase = covenantsForReport.filter(c => c.type === 'financial');
  const covenantTrend = prioritizedLatestCovenantPerformance(financialCovenantBase, sortedStatements, contractCovenantKeys);
  const covenantTrendById = new Map(covenantTrend.map((row, index) => [row.covenantId, { ...row, index }]));
  const financialCovenants = [...financialCovenantBase]
    .sort((a, b) => (covenantTrendById.get(a.id)?.index ?? 999) - (covenantTrendById.get(b.id)?.index ?? 999));
  const measurementFor = (covenantId: string): CovenantMeasurementConfig => covenantMeasurementConfig[covenantId] || { frequency: 'mensual', startPeriod: '' };
  const latestStatementMonth = firstValidMonth(latest?.periodDate, latest?.period, client.lastPeriod, client.reportDate) || monitoringPeriod;
  const covenantPeriodsForFrequency = (frequency: CovenantMeasurementFrequency) => {
    const step = reportFrequencyStepMonths[frequency];
    return Array.from({ length: 6 }, (_, index) => addMonths(latestStatementMonth, -(step * index)));
  };
  const covenantFrequencyGroups = (['mensual', 'trimestral', 'semestral', 'anual'] as CovenantMeasurementFrequency[])
    .map(frequency => ({
      frequency,
      covenants: financialCovenants.filter(cov => measurementFor(cov.id).frequency === frequency),
      periods: covenantPeriodsForFrequency(frequency),
    }))
    .filter(group => group.covenants.length > 0);
  const statementForMonth = (period: string) => sortedStatements.find(statement => firstValidMonth(statement.periodDate, statement.period) === monthKey(period));
  const hacerCovenants = covenantsForReport.filter(c => c.type === 'hacer');
  const noHacerCovenants = covenantsForReport.filter(c => c.type === 'noHacer');
  const condCovenants = [...hacerCovenants, ...noHacerCovenants];

  const updateCommercialName = async (value: string) => {
    const next = [
      ...customFields.filter(f => f.id !== 'commercial_name' && f.label !== 'Nombre comercial'),
      { id: 'commercial_name', clientId: client.id, label: 'Nombre comercial', value, fieldType: 'text' as const },
    ];
    onCustomFieldsChange?.(next);
    await db.setCustomFields(client.id, next);
  };

  const updateShowContractFooter = async (value: boolean) => {
    setShowContractFooter(value);
    await db.setClientSetting(client.id, contractFooterKey(client.id), value);
  };

  const updateSelectedReportTransaction = async (transactionId: string) => {
    setSelectedReportTransactionId(transactionId);
    await db.setClientSetting(client.id, selectedReportTransactionKey(client.id), transactionId);
  };

  useEffect(() => {
    let cancelled = false;
    setReportSettingsLoaded(false);
    Promise.all([
      db.getClientSetting<ReportBlockConfig[]>(client.id, layoutKey(client.id), DEFAULT_BLOCKS),
      db.getClientSetting<ReportTemplate[]>(client.id, templatesKey(client.id), []),
      db.getClientSetting<boolean>(client.id, contractFooterKey(client.id), true),
      db.getClientSetting<boolean>(client.id, layoutMigrationKey(client.id), false),
      db.getClientSetting<string>(client.id, selectedReportTransactionKey(client.id), ''),
    ]).then(([savedBlocks, templates, showFooter, migratedLayout, savedTransactionId]) => {
      if (cancelled) return;
      const normalized = normalizeReportBlocks(savedBlocks);
      const recoveredBlocks = migratedLayout
        ? normalized
        : normalized.map(block => block.id === 'financialCovenants' ? { ...block, visible: true } : block);
      setBlocks(recoveredBlocks);
      setSavedTemplates(normalizeReportTemplates(templates));
      setShowContractFooter(showFooter !== false);
      setSelectedReportTransactionId(savedTransactionId && transactions.some(tx => tx.id === savedTransactionId) ? savedTransactionId : '');
      setReportSettingsLoaded(true);
      if (!migratedLayout) {
        void db.setClientSetting(client.id, layoutMigrationKey(client.id), true);
        void db.setClientSetting(client.id, layoutKey(client.id), recoveredBlocks);
      }
    });
    return () => { cancelled = true; };
  }, [client.id, transactions]);

  useEffect(() => {
    if (!reportSettingsLoaded) return;
    void db.setClientSetting(client.id, layoutKey(client.id), blocks);
  }, [client.id, blocks, reportSettingsLoaded]);

  const orderedBlocks = [...blocks].sort((a, b) => a.order - b.order);
  const reportCanvasBlocks = orderedBlocks;
  const block = (id: ReportBlockId) => blocks.find(b => b.id === id) || DEFAULT_BLOCKS.find(b => b.id === id)!;
  const blockVisible = (id: ReportBlockId) => block(id).visible;
  const blockStyle = (id: ReportBlockId): React.CSSProperties => ({ order: block(id).order, display: blockVisible(id) ? undefined : 'none' });
  const toggleBlock = (id: ReportBlockId) => setBlocks(prev => prev.map(b => b.id === id ? { ...b, visible: !b.visible } : b));
  const moveBlock = (id: ReportBlockId, dir: -1 | 1) => {
    setBlocks(prev => {
      const sorted = [...prev].sort((a, b) => a.order - b.order);
      const idx = sorted.findIndex(b => b.id === id);
      const swapIdx = idx + dir;
      if (idx < 0 || swapIdx < 0 || swapIdx >= sorted.length) return prev;
      const next = [...sorted];
      const currentOrder = next[idx].order;
      next[idx] = { ...next[idx], order: next[swapIdx].order };
      next[swapIdx] = { ...next[swapIdx], order: currentOrder };
      return next;
    });
  };
  const saveTemplate = () => {
    const name = templateName.trim() || 'Plantilla';
    const next = [...savedTemplates.filter(t => t.name !== name), { name, blocks }];
    setSavedTemplates(next);
    void db.setClientSetting(client.id, templatesKey(client.id), next);
  };
  const applyTemplate = (name: string) => {
    const template = savedTemplates.find(t => t.name === name);
    if (template) setBlocks(template.blocks);
  };

  // Load saved comments from DB
  useEffect(() => {
    if (latestTape?.extractedData?._reportComment) {
      setTapeComment(latestTape.extractedData._reportComment);
    }
    const loadAnnotations = async () => {
      const comments: Record<string, string> = {};
      const statuses: Record<string, CondStatus> = {};
      for (const cov of condCovenants) {
        const anns = await db.getAnnotations(cov.id);
        if (anns.length > 0) {
          const last = anns[anns.length - 1];
          // Annotations prefixed "STATUS:X|" carry a status override
          const match = last.text.match(/^STATUS:(CUMPLE|INCUMPLE|ALERTA)\|(.*)$/s);
          if (match) {
            statuses[cov.id] = match[1] as CondStatus;
            comments[cov.id] = match[2].trim();
          } else {
            comments[cov.id] = last.text;
          }
        }
      }
      setCondStatuses(statuses);
      setCondComments(comments);
    };
    loadAnnotations();
  }, [covenants, loanTapes]);

  // Save tape comment on blur
  const handleTapeCommentBlur = async () => {
    if (!latestTape) return;
    const updated = { ...(latestTape.extractedData || {}), _reportComment: tapeComment };
    await db.updateLoanTape(latestTape.id, { extractedData: updated });
  };

  // Save condition comment + status as annotation on blur
  const handleCondBlur = async (covId: string) => {
    const status = condStatuses[covId] || 'CUMPLE';
    const comment = condComments[covId] || '';
    if (!comment.trim()) return;
    await db.addAnnotation({
      covenantId: covId,
      userId: 'report',
      userName: client.analystName || 'Analista',
      text: `STATUS:${status}|${comment}`,
    });
  };

  const readImage = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>, side: 'left' | 'right') => {
    const file = e.target.files?.[0];
    if (!file) return;
    const dataUrl = await readImage(file);
    onClientUpdate(side === 'left' ? { logoLeft: dataUrl } : { logoRight: dataUrl });
    e.target.value = '';
  };

  const downloadDataUrl = (dataUrl: string, filename: string) => {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    a.click();
  };

  const exportReportPNG = async () => {
    if (!page1Ref.current) return;
    const { default: html2canvas } = await import('html2canvas');
    const width = Math.max(page1Ref.current.scrollWidth, page1Ref.current.offsetWidth, 794);
    const height = Math.max(page1Ref.current.scrollHeight, page1Ref.current.offsetHeight, 1123);
    const canvas = await html2canvas(page1Ref.current, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: '#ffffff',
      imageTimeout: 0,
      width,
      height,
      windowWidth: width,
      windowHeight: height,
      scrollX: 0,
      scrollY: 0,
      onclone: d => sanitizeColors(d),
    });
    downloadDataUrl(canvas.toDataURL('image/png'), `Reporte_Monitoreo_${client.name}.png`);
  };

  const updateMonitoringPeriod = (period: string) => {
    onClientUpdate({ lastPeriod: monthKey(period) });
  };

  const updatePaymentPeriod = (month: string, updates: Partial<Client['paymentHistory'][number]>) => {
    const next = [...(client.paymentHistory || [])];
    const targetTransactionId = selectedReportTransactionId || updates.transactionId || '';
    const idx = next.findIndex(item =>
      monthKey(item.month) === monthKey(month) &&
      ((targetTransactionId && item.transactionId === targetTransactionId) || (!targetTransactionId && !item.transactionId))
    );
    const base = idx >= 0 ? next[idx] : { month, principalStatus: 'none' as const, interestStatus: 'none' as const, transactionId: targetTransactionId || undefined };
    const value = {
      ...base,
      ...updates,
      month: updates.month || monthKey(month),
      transactionId: updates.transactionId !== undefined ? updates.transactionId : base.transactionId,
    };
    if (!value.transactionId) delete (value as any).transactionId;
    if (idx >= 0) next[idx] = value;
    else next.push(value);
    onClientUpdate({ paymentHistory: next });
  };

  const updateAforoPeriod = (month: string, updates: Partial<Client['aforoHistory'][number]>) => {
    const next = [...(client.aforoHistory || [])];
    const targetTransactionId = selectedReportTransactionId || updates.transactionId || '';
    const idx = next.findIndex(item =>
      monthKey(item.month) === monthKey(month) &&
      ((targetTransactionId && item.transactionId === targetTransactionId) || (!targetTransactionId && !item.transactionId))
    );
    const fallback = targetTransactionId && canUseSelectedLegacyFallback
      ? next.find(item => monthKey(item.month) === monthKey(month) && !item.transactionId)
      : undefined;
    const base = idx >= 0
      ? next[idx]
      : { ...(fallback || { month, value: '', status: 'warning' as const }), transactionId: targetTransactionId || undefined };
    const value = {
      ...base,
      ...updates,
      month: updates.month || monthKey(month),
      transactionId: updates.transactionId !== undefined ? updates.transactionId : base.transactionId,
    };
    if (!value.transactionId) delete (value as any).transactionId;
    if (idx >= 0) next[idx] = value;
    else next.push(value);
    onClientUpdate({ aforoHistory: next });
  };

  const addReportPeriod = () => {
    const month = addMonths(monitoringPeriod, 1);
    onClientUpdate({
      paymentHistory: [...(client.paymentHistory || []), { month, principalStatus: 'none', interestStatus: 'none', transactionId: selectedReportTransactionId || undefined }],
      aforoHistory: [...(client.aforoHistory || []), { month, value: '', status: 'warning', transactionId: selectedReportTransactionId || undefined }],
      lastPeriod: month,
    });
  };

  const renderPageToPDF = async (
    el: HTMLElement,
    pdf: { addPage: () => void; addImage: (...args: any[]) => void },
    html2canvas: typeof import('html2canvas').default,
    addNewPage = false,
  ) => {
    const PAGE_W = 210, PAGE_H = 297;
    const width = Math.max(el.scrollWidth, el.offsetWidth, el.getBoundingClientRect().width, 794);
    const height = Math.max(el.scrollHeight, el.offsetHeight, el.getBoundingClientRect().height, 1);
    const canvas = await html2canvas(el, {
      scale: 2, useCORS: true, logging: false, backgroundColor: '#ffffff',
      imageTimeout: 0,
      width,
      height,
      windowWidth: width,
      windowHeight: height,
      scrollX: 0, scrollY: 0, onclone: (d) => sanitizeColors(d),
    });
    const pagePxHeight = Math.floor((canvas.width * PAGE_H) / PAGE_W);
    let sourceY = 0;
    let firstSlice = true;

    while (sourceY < canvas.height) {
      const sliceHeight = Math.min(pagePxHeight, canvas.height - sourceY);
      if (sliceHeight <= 0) break;
      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = canvas.width;
      pageCanvas.height = sliceHeight;
      const ctx = pageCanvas.getContext('2d');
      if (!ctx) break;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
      ctx.drawImage(canvas, 0, sourceY, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);

      if (addNewPage || !firstSlice) pdf.addPage();
      const imgData = pageCanvas.toDataURL('image/jpeg', 0.95);
      const imgHeight = (sliceHeight * PAGE_W) / canvas.width;
      pdf.addImage(imgData, 'JPEG', 0, 0, PAGE_W, imgHeight);

      sourceY += sliceHeight;
      firstSlice = false;
    }
  };

  const exportPDF = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const [{ default: html2canvas }, { default: JsPDF }] = await Promise.all([
        import('html2canvas'),
        import('jspdf'),
      ]);
      const pdf = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
      if (page1Ref.current) await renderPageToPDF(page1Ref.current, pdf, html2canvas, false);
      if (condRef.current && (hacerCovenants.length > 0 || noHacerCovenants.length > 0)) {
        await renderPageToPDF(condRef.current, pdf, html2canvas, true);
      }
      const now = new Date();
      const ds = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
      pdf.save(`${ds} - Reporte Monitoreo - ${client.name}.pdf`);
    } catch (err) {
      console.error('PDF export error:', err);
      alert('Error al generar el PDF. Intente de nuevo.');
    } finally {
      setIsExporting(false);
    }
  };

  const exportExcel = async () => {
    try {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    type FormulaCell = { __formula: string; __resultType?: 'n' | 's' | 'b' };
    const fcell = (formula: string, resultType: FormulaCell['__resultType'] = 'n'): FormulaCell => ({
      __formula: formula.replace(/^=/, ''),
      __resultType: resultType,
    });
    const sheetFromRows = (rows: any[][]) => {
      const formulas: Array<{ r: number; c: number; formula: string; resultType: FormulaCell['__resultType'] }> = [];
      const plainRows = rows.map((row, r) => row.map((cell, c) => {
        if (cell && typeof cell === 'object' && '__formula' in cell) {
          formulas.push({ r, c, formula: cell.__formula, resultType: cell.__resultType });
          return null;
        }
        return cell;
      }));
      const ws = XLSX.utils.aoa_to_sheet(plainRows);
      formulas.forEach(({ r, c, formula, resultType }) => {
        const ref = XLSX.utils.encode_cell({ r, c });
        ws[ref] = { t: resultType || 'n', f: formula };
      });
      return ws;
    };
    const safeClientName = (client.name || 'Cliente')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Cliente';

    const resumen = [
      ['Cliente', client.name],
      ['RFC', client.taxId],
      ['Industria', client.industry],
      ...(showContractFooter ? [['Contrato', selectedContractLabel]] : []),
      ['Periodo de monitoreo', periodLabel(reportPeriod)],
      ['Analista', client.analystName || ''],
      ['Fecha reporte', client.reportDate || ''],
      ['Linea credito', fmtMoney(client.totalCreditValue, client.currency || 'MXN')],
      ['Moneda', client.currency],
    ];
    XLSX.utils.book_append_sheet(wb, sheetFromRows(resumen), 'Resumen');

    if (aforoHistory.length > 0) {
      const rows: (string | number)[][] = [
        ['Aforo requerido', ...aforoHistory.map(() => fmtAforoValue(client.aforoRequerido || ''))],
        ['Aforo observado', ...aforoHistory.map(a => fmtAforoValue(a.value))],
        ['Estado', ...aforoHistory.map(a => a.status)],
        ['Facility', ...aforoHistory.map(a => scopedFacilityName(a))],
      ];
      XLSX.utils.book_append_sheet(wb, sheetFromRows(rows), 'Aforo');
    }

    if (paymentHistory.length > 0) {
      const rows: (string | number)[][] = [
        ['Concepto', ...paymentHistory.map(item => periodLabel(item.month))],
        ['Capital estado', ...paymentHistory.map(item => item.principalStatus)],
        ['Capital monto', ...paymentHistory.map(item => item.principalAmount ? fmtMoney(item.principalAmount, client.currency || 'MXN') : '')],
        ['Intereses estado', ...paymentHistory.map(item => item.interestStatus)],
        ['Intereses monto', ...paymentHistory.map(item => item.interestAmount ? fmtMoney(item.interestAmount, client.currency || 'MXN') : '')],
        ['Facility', ...paymentHistory.map(item => scopedFacilityName(item))],
      ];
      XLSX.utils.book_append_sheet(wb, sheetFromRows(rows), 'Cobranza');
    }

    if (sortedStatements.length > 0) {
      const periods = sortedStatements.map(s => s.period);
      const xlCol = (n: number) => {
        let s = '';
        while (n > 0) {
          const m = (n - 1) % 26;
          s = String.fromCharCode(65 + m) + s;
          n = Math.floor((n - 1) / 26);
        }
        return s;
      };
      const keys: string[] = [];
      const seen = new Set<string>();
      sortedStatements.forEach(statement => {
        statement.rawLineItems.forEach(item => {
          const key = `${item.statementType || 'otro'}||${item.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            keys.push(key);
          }
        });
      });
      const rows = [['Estado financiero', 'Cuenta contable', ...periods]];
      const labels: Record<string, string> = {
        balance_general: 'Balance General',
        estado_resultados: 'Estado de Resultados',
        flujo_efectivo: 'Flujo de Efectivo',
        otro: 'Otro',
      };
      keys.forEach(key => {
        const [statementType, name] = key.split('||');
        rows.push([labels[statementType] || statementType, name, ...sortedStatements.map(statement => statement.rawLineItems.find(item => `${item.statementType || 'otro'}||${item.name}` === key)?.value ?? '')]);
      });
      XLSX.utils.book_append_sheet(wb, sheetFromRows(rows), 'Datos Fuente');

      const erAccounts: string[] = [];
      const erSeen = new Set<string>();
      sortedStatements.forEach(statement => {
        statement.rawLineItems.forEach(item => {
          if ((item.statementType || 'balance_general') !== 'estado_resultados') return;
          if (erSeen.has(item.name)) return;
          erSeen.add(item.name);
          erAccounts.push(item.name);
        });
      });
      if (erAccounts.length > 0) {
        const erKey = (value: string) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
        const erRowByKey = new Map<string, number>();
        erAccounts.forEach((account, index) => erRowByKey.set(erKey(account), 5 + index));
        const findErRow = (...patterns: RegExp[]) => {
          for (const [key, row] of erRowByKey.entries()) {
            if (patterns.some(pattern => pattern.test(key))) return row;
          }
          return null;
        };
        const erRowsByRole = {
          comisionesCobradas: findErRow(/comision.*cobrad|comisionescobradas/),
          comisionesPagadas: findErRow(/comision.*pagad|comisionespagadas/),
          pagadasVsCobradas: findErRow(/pagadas.*cobradas|pagadasvscobradas/),
          resultadoServicios: findErRow(/resultadoporservicio|resultado.*servicio/),
          ingresosIntereses: findErRow(/ingresos?.*interes|ingresosporintereses/),
          valuacion: findErRow(/valuacion|valorrazonable/),
          gastosIntereses: findErRow(/gastos?.*interes|gastosporintereses/),
          margenFinanciero: findErRow(/margenfinanciero/),
          otrosIngresos: findErRow(/otrosingresos|egresos.*operacion|operacion/),
          gastosAdmin: findErRow(/gastos.*administracion|administracion.*promocion/),
          impuestos: findErRow(/impuestos?.*utilidad|diferido/),
          resultadoNeto: findErRow(/resultadoneto|utilidadneta|perdidaneta/),
        };
        const baseErRow = erRowsByRole.comisionesCobradas || erRowsByRole.ingresosIntereses || 5;
        const erValueColForPeriod = (periodIndex: number) => xlCol(5 + periodIndex * 2);
        const erFormulaFor = (account: string, col: string, sourceRow: number, periodIndex: number) => {
          const row = erRowByKey.get(erKey(account));
          if (row === erRowsByRole.pagadasVsCobradas && erRowsByRole.comisionesPagadas && erRowsByRole.comisionesCobradas) {
            return `IFERROR(-${col}${erRowsByRole.comisionesPagadas}/${col}${erRowsByRole.comisionesCobradas},"")`;
          }
          if (row === erRowsByRole.resultadoServicios && erRowsByRole.comisionesCobradas && erRowsByRole.comisionesPagadas) {
            return `SUM(${col}${erRowsByRole.comisionesCobradas}:${col}${erRowsByRole.comisionesPagadas})`;
          }
          if (row === erRowsByRole.margenFinanciero && erRowsByRole.resultadoServicios && erRowsByRole.ingresosIntereses && erRowsByRole.valuacion && erRowsByRole.gastosIntereses) {
            return `SUM(${col}${erRowsByRole.resultadoServicios},${col}${erRowsByRole.ingresosIntereses}:${col}${erRowsByRole.gastosIntereses})`;
          }
          if (row === erRowsByRole.resultadoNeto && erRowsByRole.margenFinanciero && erRowsByRole.otrosIngresos && erRowsByRole.gastosAdmin && erRowsByRole.impuestos) {
            return `SUM(${col}${erRowsByRole.margenFinanciero},${col}${erRowsByRole.otrosIngresos}:${col}${erRowsByRole.impuestos})`;
          }
          return `'Datos Fuente'!${xlCol(3 + periodIndex)}${sourceRow}`;
        };
        const erRows: any[][] = [
          ['Estado de Resultados'],
          ['Cuentas en vertical, periodos en horizontal. Valor, % vertical, Δ y Δ% usan fórmulas con referencias directas de celda.'],
          [],
          [
            'Cuenta',
            'Sección',
            'Fuente',
            'Fórmula Excel visible',
            ...periods.flatMap(period => [period, `% Vertical ${period}`]),
            ...periods.slice(1).flatMap(period => [`Δ ${period}`, `Δ% ${period}`]),
          ],
        ];
        erAccounts.forEach((account, index) => {
          const sourceRow = keys.findIndex(key => key === `estado_resultados||${account}`) + 2;
          const currentRow = erRows.length + 1;
          const firstValueCol = erValueColForPeriod(0);
          const firstFormula = erFormulaFor(account, firstValueCol, sourceRow, 0);
          const valuesAndVertical = periods.flatMap((_, periodIndex) => {
            const valueCol = erValueColForPeriod(periodIndex);
            const valueFormula = erFormulaFor(account, valueCol, sourceRow, periodIndex);
            const verticalFormula = `IFERROR(${valueCol}${currentRow}/${valueCol}$${baseErRow},"")`;
            return [fcell(valueFormula), fcell(verticalFormula)];
          });
          const horizontal = periods.slice(1).flatMap((_, periodIndex) => {
            const prevValueCol = erValueColForPeriod(periodIndex);
            const valueCol = erValueColForPeriod(periodIndex + 1);
            return [
              fcell(`IFERROR(${valueCol}${currentRow}-${prevValueCol}${currentRow},"")`),
              fcell(`IFERROR((${valueCol}${currentRow}-${prevValueCol}${currentRow})/ABS(${prevValueCol}${currentRow}),"")`),
            ];
          });
          erRows.push([
            account,
            'Estado de Resultados',
            `Datos Fuente fila ${sourceRow}`,
            `=${firstFormula}`,
            ...valuesAndVertical,
            ...horizontal,
          ]);
        });
        const totalRow = erRows.length + 1;
        const totalValuesAndVertical = periods.flatMap((_, periodIndex) => {
          const valueCol = erValueColForPeriod(periodIndex);
          return [
            fcell(`SUM(${valueCol}5:${valueCol}${totalRow - 1})`),
            fcell(`IFERROR(${valueCol}${totalRow}/${valueCol}$${baseErRow},"")`),
          ];
        });
        const totalHorizontal = periods.slice(1).flatMap((_, periodIndex) => {
          const prevValueCol = erValueColForPeriod(periodIndex);
          const valueCol = erValueColForPeriod(periodIndex + 1);
          return [
            fcell(`IFERROR(${valueCol}${totalRow}-${prevValueCol}${totalRow},"")`),
            fcell(`IFERROR((${valueCol}${totalRow}-${prevValueCol}${totalRow})/ABS(${prevValueCol}${totalRow}),"")`),
          ];
        });
        erRows.push([
          'TOTAL / CHECK ER',
          'Check',
          'Suma de cuentas visibles',
          '=SUM(cuentas del ER por periodo)',
          ...totalValuesAndVertical,
          ...totalHorizontal,
        ]);
        erRows.push([
          'Fórmula visible del check',
          'Auditoría',
          'Texto',
          '=SUM(filas superiores)',
          ...periods.flatMap((_, periodIndex) => {
            const valueCol = erValueColForPeriod(periodIndex);
            return [
              `=SUM(${valueCol}5:${valueCol}${totalRow - 1})`,
              `=IFERROR(${valueCol}${totalRow}/${valueCol}$${baseErRow},"")`,
            ];
          }),
          ...periods.slice(1).flatMap((_, periodIndex) => {
            const prevValueCol = erValueColForPeriod(periodIndex);
            const valueCol = erValueColForPeriod(periodIndex + 1);
            return [
              `=${valueCol}${totalRow}-${prevValueCol}${totalRow}`,
              `=(${valueCol}${totalRow}-${prevValueCol}${totalRow})/ABS(${prevValueCol}${totalRow})`,
            ];
          }),
        ]);
        XLSX.utils.book_append_sheet(wb, sheetFromRows(erRows), 'Estado de Resultados');
      }
    }

    if (financialCovenants.length > 0) {
      const rows: (string | number)[][] = [];
      covenantFrequencyGroups.forEach(group => {
        if (rows.length > 0) rows.push([]);
        rows.push([frequencyLabels[group.frequency]]);
        rows.push(['Indicador', 'Facility', 'Requerido', ...group.periods.map(periodLabel)]);
        group.covenants.forEach(cov => {
          rows.push([
            cov.name,
            scopedFacilityName(cov),
            fmtCovenantThreshold(cov),
            ...group.periods.map(period => {
              const statement = statementForMonth(period);
              if (!statement) return 'NA';
              const result = evaluateCovenant(cov, [statement]);
              return fmtCovenantValue(cov, result.value);
            }),
          ]);
        });
      });
      XLSX.utils.book_append_sheet(wb, sheetFromRows(rows), 'Covenants');

      const xlCol = (n: number) => {
        let s = '';
        while (n > 0) {
          const m = (n - 1) % 26;
          s = String.fromCharCode(65 + m) + s;
          n = Math.floor((n - 1) / 26);
        }
        return s;
      };
      const opLabel = (op: Covenant_DB['operator']) =>
        op === 'gt' ? '>' : op === 'gte' ? '>=' : op === 'lt' ? '<' : op === 'lte' ? '<=' : '';
      const isMin = (op: Covenant_DB['operator']) => op === 'gt' || op === 'gte';
      const compareFormula = (actual: string, limit: string, op: Covenant_DB['operator']) => {
        const cmp =
          op === 'gt' ? `${actual}>${limit}` :
          op === 'gte' ? `${actual}>=${limit}` :
          op === 'lt' ? `${actual}<${limit}` :
          op === 'lte' ? `${actual}<=${limit}` :
          'TRUE';
        return `IF(OR(NOT(ISNUMBER(${actual})),NOT(ISNUMBER(${limit}))),"",IF(${cmp},"CUMPLE","INCUMPLE"))`;
      };
      const cushionFormula = (actual: string, limit: string, op: Covenant_DB['operator']) => {
        const calc = isMin(op) ? `${actual}-${limit}` : `${limit}-${actual}`;
        return `IF(OR(NOT(ISNUMBER(${actual})),NOT(ISNUMBER(${limit}))),"",${calc})`;
      };

      const allPeriods = covenantFrequencyGroups.flatMap(group => group.periods);
      const sourceRows: any[][] = [['Key', 'Covenant', 'Facility', 'Linea', 'Frecuencia', ...allPeriods.map(periodLabel)]];
      const metricRows: Record<string, number> = {};
      const metricDefs: Array<[string, string]> = [
        ['revenue', 'Ingresos'],
        ['interestIncome', 'Ingresos por intereses'],
        ['feeIncome', 'Ingresos por comisiones'],
        ['coreBusinessIncome', 'Ingresos core del negocio'],
        ['adjustedFinancialMargin', 'Margen financiero ajustado'],
        ['adjustedOperatingIncome', 'Utilidad operativa ajustada'],
        ['adminSellingOperatingExpenses', 'Gastos adm., venta y operación'],
        ['ebitda', 'EBITDA'],
        ['interestExpense', 'Gasto financiero'],
        ['netIncome', 'Utilidad neta'],
        ['currentAssets', 'Activo corriente'],
        ['currentLiabilities', 'Pasivo corriente'],
        ['totalDebt', 'Deuda total'],
        ['banksFundsShortTerm', 'Bancos y fondos CP'],
        ['banksFundsLongTerm', 'Bancos y fondos LP'],
        ['totalLiabilities', 'Total pasivo'],
        ['totalAssets', 'Total activo'],
        ['equity', 'Capital contable'],
        ['cash', 'Bancos / efectivo'],
        ['availableInvestments', 'Inversiones disponibles no comprometidas'],
        ['loanPortfolio', 'Cartera de crédito'],
        ['netPortfolio', 'Cartera neta'],
        ['managedPortfolio', 'Cartera administrada'],
        ['pastDuePortfolio', 'Cartera vencida'],
        ['loanLossReserves', 'Estimación preventiva'],
        ['productiveAssets', 'Activos productivos'],
      ];
      metricDefs.forEach(([key, label]) => {
        metricRows[key] = sourceRows.length + 1;
        sourceRows.push([
          key,
          label,
          'Métrica base',
          'Dato fuente normalizado',
          '',
          ...allPeriods.map(period => {
            const statement = statementForMonth(period);
            return statement ? getMetric(statement, key) ?? '' : '';
          }),
        ]);
      });
      const metricRef = (key: string, col: string) => {
        const row = metricRows[key];
        return row ? `'Cov Datos'!${col}${row}` : '0';
      };
      const covenantFormulaWithRefs = (formula: string, col: string, fallbackCell: string) => {
        const f = (formula || '').trim();
        if (f.startsWith('ratio:')) {
          const [num, den] = f.slice('ratio:'.length).split('/');
          return num && den ? `IFERROR(${metricRef(num, col)}/${metricRef(den, col)},"")` : fallbackCell;
        }
        if (f.startsWith('expr:')) {
          try {
            const tokens = JSON.parse(f.slice('expr:'.length)) as string[];
            const body = tokens.map(token => {
              if (token.startsWith('ref:')) return metricRef(token.slice(4), col);
              if (token.startsWith('num:')) return token.slice(4);
              return token;
            }).join('');
            return `IFERROR(${body},"")`;
          } catch {
            return fallbackCell;
          }
        }
        const low = f.toLowerCase();
        if (low.includes('deuda') && low.includes('ebitda')) return `IFERROR(${metricRef('totalDebt', col)}/${metricRef('ebitda', col)},"")`;
        if (low.includes('dscr') || (low.includes('ebitda') && low.includes('interes'))) return `IFERROR(${metricRef('ebitda', col)}/${metricRef('interestExpense', col)},"")`;
        if (low.includes('corriente')) return `IFERROR(${metricRef('currentAssets', col)}/${metricRef('currentLiabilities', col)},"")`;
        if (low.includes('liquidez inmediata')) return `IFERROR((${metricRef('cash', col)}+${metricRef('availableInvestments', col)})/${metricRef('currentLiabilities', col)},"")`;
        if (low.includes('roa')) return `IFERROR(${metricRef('netIncome', col)}/${metricRef('totalAssets', col)},"")`;
        if (low.includes('roe')) return `IFERROR(${metricRef('netIncome', col)}/${metricRef('equity', col)},"")`;
        if (low.includes('apalanc')) return `IFERROR((${metricRef('banksFundsShortTerm', col)}+${metricRef('banksFundsLongTerm', col)})/${metricRef('totalAssets', col)},"")`;
        if (low.includes('equity') || low.includes('capital')) return `IFERROR(${metricRef('totalDebt', col)}/${metricRef('equity', col)},"")`;
        return fallbackCell;
      };
      const calcRows: any[][] = [
        ['Covenants Calculados'],
        ['Cada covenant muestra Real, Límite, Holgura y Cumple. Las celdas de periodos son fórmulas auditables.'],
        [],
        ['Covenant', 'Facility', 'Linea', 'Formula / criterio', 'Fuente', ...allPeriods.map(periodLabel)],
      ];
      let sourceRowNumber = sourceRows.length + 1;

      covenantFrequencyGroups.forEach(group => {
        calcRows.push([]);
        calcRows.push([frequencyLabels[group.frequency]]);
        group.covenants.forEach(cov => {
          const periods = allPeriods;
          const groupPeriodSet = new Set(group.periods);
          const actualSourceRow = sourceRowNumber;
          const limitSourceRow = sourceRowNumber + 1;
          const threshold = parseFinancialNumber(cov.threshold, Number.NaN);
          const facility = scopedFacilityName(cov);
          const values = periods.map(period => {
            if (!groupPeriodSet.has(period)) return '';
            const statement = statementForMonth(period);
            if (!statement) return '';
            const result = evaluateCovenant(cov, [statement]);
            return result.value ?? '';
          });
          const limits = periods.map(period => groupPeriodSet.has(period) && Number.isFinite(threshold) ? threshold : '');
          sourceRows.push([`${cov.id}:real`, cov.name, facility, 'Real', frequencyLabels[group.frequency], ...values]);
          sourceRows.push([`${cov.id}:limit`, cov.name, facility, 'Limite', frequencyLabels[group.frequency], ...limits]);
          sourceRowNumber += 2;

          const realRow = calcRows.length + 1;
          const limitRow = realRow + 1;
          const cushionRow = realRow + 2;
          const statusRow = realRow + 3;
          const firstPeriodCol = 6;
          const realFormulaStrings = periods.map((_, i) => {
            const col = xlCol(firstPeriodCol + i);
            return `=${covenantFormulaWithRefs(cov.formula || cov.name, col, `'Cov Datos'!${col}${actualSourceRow}`)}`;
          });
          const limitFormulaStrings = periods.map((_, i) => {
            const col = xlCol(firstPeriodCol + i);
            return `='Cov Datos'!${col}${limitSourceRow}`;
          });
          const cushionFormulaStrings = periods.map((_, i) => {
            const col = xlCol(firstPeriodCol + i);
            return cov.operator === 'none' || !Number.isFinite(threshold) ? '=""' : `=${cushionFormula(`${col}${realRow}`, `${col}${limitRow}`, cov.operator)}`;
          });
          const statusFormulaStrings = periods.map((_, i) => {
            const col = xlCol(firstPeriodCol + i);
            return cov.operator === 'none' || !Number.isFinite(threshold) ? '=""' : `=${compareFormula(`${col}${realRow}`, `${col}${limitRow}`, cov.operator)}`;
          });
          calcRows.push([cov.name, facility, 'Real', cov.formula || cov.name, 'Cov Datos', ...realFormulaStrings.map(formula => fcell(formula))]);
          calcRows.push([cov.name, facility, `Limite ${opLabel(cov.operator) || 'N/A'}`, Number.isFinite(threshold) ? cov.threshold : 'N/A', 'Cov Datos', ...limitFormulaStrings.map(formula => fcell(formula))]);
          calcRows.push([cov.name, facility, 'Holgura', isMin(cov.operator) ? '=Real - Limite' : '=Limite - Real', 'Calculo',
            ...cushionFormulaStrings.map(formula => fcell(formula)),
          ]);
          calcRows.push([cov.name, facility, 'Cumple', '=IF(Real vs Limite,"CUMPLE","INCUMPLE")', 'Calculo',
            ...statusFormulaStrings.map(formula => fcell(formula, 's')),
          ]);
          calcRows.push([cov.name, facility, 'Formula Real visible', 'Texto visible', 'Auditoria', ...realFormulaStrings]);
          calcRows.push([cov.name, facility, 'Formula Holgura visible', 'Texto visible', 'Auditoria', ...cushionFormulaStrings]);
          calcRows.push([cov.name, facility, 'Formula Cumple visible', 'Texto visible', 'Auditoria', ...statusFormulaStrings]);
          calcRows.push([]);
        });
      });

      calcRows.push([]);
      calcRows.push(['Resumen de incumplimientos por periodo']);
      calcRows.push(['Metrica', '', '', 'Formula', 'Notas', ...covenantFrequencyGroups.flatMap(group => group.periods.map(periodLabel))]);
      calcRows.push(['Incumplimientos', '', '', '=COUNTIF(statuses,"INCUMPLE")', 'Cuenta covenants incumplidos por fecha',
        ...allPeriods.map((_, i) => {
          const col = xlCol(6 + i);
          const statusCells: string[] = [];
          for (let r = 1; r <= calcRows.length; r++) {
            if (calcRows[r - 1]?.[2] === 'Cumple') statusCells.push(`${col}${r}`);
          }
          return fcell(statusCells.map(cell => `COUNTIF(${cell},"INCUMPLE")`).join('+') || '0');
        }),
      ]);

      XLSX.utils.book_append_sheet(wb, sheetFromRows(sourceRows), 'Cov Datos');
      XLSX.utils.book_append_sheet(wb, sheetFromRows(calcRows), 'Covenants Calculados');
    }

    XLSX.writeFile(wb, `Reporte_Monitoreo_${safeClientName}.xlsx`);
    } catch (err) {
      console.error('Excel export error:', err);
      alert('Error al generar el Excel. Revisa la consola para ver el detalle.');
    }
  };

  const cellCStyle: React.CSSProperties = { ...tdVC, padding: '6px 8px', fontSize: 9, border: '1px solid #e2e8f0' };
  const sectionCard: React.CSSProperties = {
    marginBottom: 20,
  };
  const sectionTitle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 900,
    color: '#0070c9',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    marginBottom: 12,
  };
  const sectionKicker: React.CSSProperties = {
    fontSize: 8,
    fontWeight: 900,
    color: '#94a3b8',
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    marginBottom: 4,
  };

  const ReportFooter = () => (
    <div style={{ position: 'absolute', left: 44, right: 44, bottom: 24, display: 'grid', gridTemplateColumns: showContractFooter ? '1fr 1fr 1fr' : '1fr 1fr', gap: 12, borderTop: '2px solid #0018E6', paddingTop: 12, backgroundColor: '#ffffff' }}>
      <div style={{ ...vccCol, textAlign: 'center' }}>
        <p style={{ fontSize: 8, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#94a3b8', margin: 0 }}>Analista Responsable</p>
        <p style={{ fontSize: 12, fontWeight: 900, color: '#0066E6', margin: '2px 0 0 0' }}>{client.analystName || 'No asignado'}</p>
      </div>
      <div style={{ ...vccCol, textAlign: 'center' }}>
        <p style={{ fontSize: 8, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#94a3b8', margin: 0 }}>Fecha de Reporte</p>
        <p style={{ fontSize: 12, fontWeight: 900, color: '#334155', margin: '2px 0 0 0' }}>{fmtDate(client.reportDate)}</p>
      </div>
      {showContractFooter && <div style={{ ...vccCol, textAlign: 'center' }}>
        <p style={{ fontSize: 8, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#94a3b8', margin: 0 }}>Contrato</p>
        <p style={{ fontSize: 12, fontWeight: 900, color: '#334155', margin: '2px 0 0 0' }}>{selectedContractLabel}</p>
      </div>}
    </div>
  );

  const StatusPill = ({ status }: { status: CondStatus }) => {
    const s = STATUS_STYLE[status];
    return (
      <span style={{ backgroundColor: s.bg, color: s.color, padding: '2px 8px', borderRadius: 4, fontSize: 8, fontWeight: 900, border: `1px solid ${s.color}40` }}>
        {s.label}
      </span>
    );
  };

  const pageClass = 'pdf-page bg-white w-[210mm] p-[8mm] relative text-slate-800';

  return (
    <div className="bg-slate-100 min-h-screen py-10 px-4 flex flex-col items-center gap-6">
      {/* Toolbar */}
      <div className="flex flex-col items-center gap-3 print:hidden">
        <div className="flex gap-3 items-center">
          <button onClick={onClose} className="bg-white text-slate-600 px-5 py-2 rounded-xl font-bold shadow-sm hover:bg-slate-50 transition-all border border-slate-200">
            Volver al Tablero
          </button>
          <button
            onClick={exportExcel}
            className="flex items-center gap-2 bg-white border border-slate-200 text-slate-700 font-bold px-4 py-2.5 rounded-xl text-sm hover:bg-slate-50 transition-all"
          >
            <FileSpreadsheet className="w-4 h-4" />
            Exportar Excel
          </button>
          <button
            onClick={exportPDF}
            disabled={isExporting}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-400 text-white font-bold px-4 py-2.5 rounded-xl text-sm transition-all"
          >
            <Download className="w-4 h-4" />
            {isExporting ? 'Generando PDF...' : 'Exportar PDF'}
          </button>
          <button onClick={exportReportPNG} className="flex items-center gap-2 bg-white border border-slate-200 text-slate-700 font-bold px-4 py-2.5 rounded-xl text-sm hover:bg-slate-50 transition-all">
            <ImageDown className="w-4 h-4" />
            Exportar PNG
          </button>
        </div>
        <div className="flex gap-3 bg-white p-2 rounded-2xl shadow-sm border border-slate-200 items-center">
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-2">Facility del reporte:</span>
          <select
            value={selectedReportTransactionId}
            onChange={e => updateSelectedReportTransaction(e.target.value)}
            disabled={transactions.length === 0}
            className="min-w-64 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-black text-slate-700 outline-none focus:ring-2 focus:ring-indigo-400 disabled:text-slate-400"
          >
            {transactions.length === 0 ? (
              <option value="">Sin facilities registradas</option>
            ) : (
              <>
                <option value="">Todas / general</option>
                {transactions.map(tx => <option key={tx.id} value={tx.id}>{tx.name}</option>)}
              </>
            )}
          </select>
          <label className="flex items-center gap-2 px-2">
            <input type="checkbox" checked={showContractFooter} onChange={e => updateShowContractFooter(e.target.checked)} />
            <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest whitespace-nowrap">Contrato en reporte</span>
          </label>
        </div>
        <div className="flex gap-3 bg-white p-2 rounded-2xl shadow-sm border border-slate-200 items-center">
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-2">Versión:</span>
          <button onClick={() => setReportMode('interno')}
            className={`px-3 py-1.5 rounded-xl text-[9px] font-black uppercase transition-all ${reportMode === 'interno' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
            Interno
          </button>
          <button onClick={() => setReportMode('inv')}
            className={`px-3 py-1.5 rounded-xl text-[9px] font-black uppercase transition-all ${reportMode === 'inv' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
            Inversionista
          </button>
        </div>
        <div className="flex gap-3 bg-white p-2 rounded-2xl shadow-sm border border-slate-200 items-center">
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-2">Incluir:</span>
          {[
            { label: 'Aforo', id: 'aforo' as ReportBlockId },
            { label: 'Covenants', id: 'financialCovenants' as ReportBlockId },
            { label: 'Doc.', id: 'documentation' as ReportBlockId },
            { label: 'Loan Tape', id: 'loanTape' as ReportBlockId },
          ].map(({ label, id }) => (
            <button key={label} onClick={() => toggleBlock(id)}
              className={`px-3 py-1.5 rounded-xl text-[9px] font-black uppercase transition-all ${blockVisible(id) ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="w-full max-w-5xl bg-white border border-slate-200 rounded-2xl p-6 shadow-sm print:hidden">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div className="flex items-center gap-2">
            <LayoutGrid className="w-4 h-4 text-indigo-600" />
            <p className="text-xs font-black text-slate-500 uppercase tracking-widest">Canvas del Reporte</p>
          </div>
          <div className="flex items-center gap-2">
            <input value={templateName} onChange={e => setTemplateName(e.target.value)} className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold" />
            <button onClick={saveTemplate} className="flex items-center gap-1 bg-indigo-600 text-white rounded-xl px-3 py-2 text-xs font-black">
              <Save className="w-3.5 h-3.5" /> Guardar plantilla
            </button>
            {savedTemplates.length > 0 && (
              <select onChange={e => applyTemplate(e.target.value)} defaultValue="" className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold">
                <option value="" disabled>Cargar plantilla</option>
                {savedTemplates.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
            )}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {reportCanvasBlocks.map((b, idx) => (
            <div key={b.id} className="flex items-center gap-3 border border-slate-200 rounded-xl px-4 py-3 bg-slate-50">
              <input type="checkbox" checked={b.visible} onChange={() => toggleBlock(b.id)} />
              <span className="flex-1 text-sm font-black text-slate-800">{b.label}</span>
              <button onClick={() => moveBlock(b.id, -1)} disabled={idx === 0} className="p-1.5 rounded-lg bg-white border border-slate-200 disabled:opacity-30"><ArrowUp className="w-3.5 h-3.5" /></button>
              <button onClick={() => moveBlock(b.id, 1)} disabled={idx === reportCanvasBlocks.length - 1} className="p-1.5 rounded-lg bg-white border border-slate-200 disabled:opacity-30"><ArrowDown className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
      </div>

      <div className="w-full max-w-5xl bg-white border border-slate-200 rounded-2xl p-6 shadow-sm print:hidden">
        <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">Campos del Reporte</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <label>
            <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Nombre comercial / acreditado</span>
            <input value={commercialName} onChange={e => updateCommercialName(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-400" />
          </label>
          <label>
            <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Contrato</span>
            <input value={client.contractName || ''} onChange={e => onClientUpdate({ contractName: e.target.value })} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-400" />
          </label>
          {transactions.length > 0 && (
            <label>
              <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Contrato del reporte</span>
              <select value={selectedReportTransactionId} onChange={e => updateSelectedReportTransaction(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-400">
                <option value="">Todos / general</option>
                {transactions.map(tx => <option key={tx.id} value={tx.id}>{tx.name}</option>)}
              </select>
            </label>
          )}
          <label className="flex items-end gap-2 pb-2">
            <input type="checkbox" checked={showContractFooter} onChange={e => updateShowContractFooter(e.target.checked)} />
            <span className="text-xs font-black text-slate-500 uppercase tracking-widest">Mostrar contrato en reporte</span>
          </label>
          <label>
            <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Analista</span>
            <input value={client.analystName || ''} onChange={e => onClientUpdate({ analystName: e.target.value })} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-400" />
          </label>
          <label>
            <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Fecha Reporte</span>
            <input type="date" value={client.reportDate || ''} onChange={e => onClientUpdate({ reportDate: e.target.value })} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-400" />
          </label>
          <label>
            <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Periodo de monitoreo</span>
            <input type="month" value={monitoringPeriod} onChange={e => updateMonitoringPeriod(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-400" />
          </label>
          <label>
            <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Línea Crédito</span>
            <input
              key={`${client.id}:${client.totalCreditValue}`}
              type="text"
              inputMode="decimal"
              defaultValue={client.totalCreditValue || 0}
              onBlur={e => onClientUpdate({ totalCreditValue: parseFinancialNumber(e.target.value) })}
              className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono font-bold outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </label>
          <label>
            <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Aforo requerido</span>
            <input value={client.aforoRequerido || ''} onChange={e => onClientUpdate({ aforoRequerido: e.target.value })} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono font-bold outline-none focus:ring-2 focus:ring-indigo-400" />
          </label>
          <label>
            <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Calificación</span>
            <input type="number" min="0" max="100" step="1" value={client.score || ''} onChange={e => onClientUpdate({ score: e.target.value })} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-400" />
          </label>
        </div>
        <div className="mt-6 border-t border-slate-100 pt-5">
          <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-3">Imágenes del reporte</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            {(['left', 'right'] as const).map(side => {
              const value = side === 'left' ? client.logoLeft : client.logoRight;
              return (
                <div key={side} className="border border-slate-200 rounded-xl p-4">
                  <div className="flex items-center gap-3">
                    <div className="w-16 h-16 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-center overflow-hidden">
                      {value ? <img src={value} className="w-full h-full object-contain" /> : <Upload className="w-5 h-5 text-slate-300" />}
                    </div>
                    <div className="flex-1">
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">{side === 'left' ? 'Logo izquierdo' : 'Logo derecho'}</p>
                      <div className="flex gap-2 flex-wrap">
                        <label className="cursor-pointer bg-indigo-600 text-white px-3 py-2 rounded-lg text-xs font-black">
                          Subir
                          <input type="file" accept="image/*" onChange={e => handleLogoUpload(e, side)} className="hidden" />
                        </label>
                        {value && (
                          <>
                            <button onClick={() => downloadDataUrl(value, `${client.name}_${side}.png`)} className="bg-white border border-slate-200 text-slate-700 px-3 py-2 rounded-lg text-xs font-black">Bajar</button>
                            <button onClick={() => onClientUpdate(side === 'left' ? { logoLeft: '' } : { logoRight: '' })} className="bg-rose-50 text-rose-700 px-3 py-2 rounded-lg text-xs font-black flex items-center gap-1"><Trash2 className="w-3 h-3" />Quitar</button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Cobranza · periodo de monitoreo + 5 meses atrás</p>
            <button onClick={addReportPeriod} className="bg-indigo-600 text-white px-3 py-2 rounded-lg text-xs font-black">Siguiente periodo</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 text-slate-500 uppercase tracking-wider">
                  <th className="text-left px-3 py-2">Periodo</th>
                  <th className="text-left px-3 py-2">Capital</th>
                  <th className="text-left px-3 py-2">Monto capital</th>
                  <th className="text-left px-3 py-2">Intereses</th>
                  <th className="text-left px-3 py-2">Monto intereses</th>
                  <th className="text-left px-3 py-2">Aforo</th>
                  <th className="text-left px-3 py-2">Estado aforo</th>
                </tr>
              </thead>
              <tbody>
                {aforoPeriodKeys.map((month, idx) => {
                  const pay = paymentHistory[idx] || { month, principalStatus: 'none', interestStatus: 'none' };
                  const aforo = aforoHistory[idx] || { month, value: '', status: 'warning' as const };
                  return (
                    <tr key={month} className="border-t border-slate-100">
                      <td className="px-3 py-2">
                        <span className="w-28 block bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 font-bold text-slate-700">{periodLabel(month)}</span>
                      </td>
                      <td className="px-3 py-2">
                        <select value={pay.principalStatus} onChange={e => updatePaymentPeriod(month, { principalStatus: e.target.value as any })} className="bg-white border border-slate-200 rounded-lg px-2 py-1">
                          <option value="paid">Cumple</option>
                          <option value="unpaid">Incumple</option>
                          <option value="none">N/A</option>
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <input value={pay.principalAmount || ''} onChange={e => updatePaymentPeriod(month, { principalAmount: e.target.value })} placeholder="Opcional" className="w-28 bg-white border border-slate-200 rounded-lg px-2 py-1 font-mono" />
                      </td>
                      <td className="px-3 py-2">
                        <select value={pay.interestStatus} onChange={e => updatePaymentPeriod(month, { interestStatus: e.target.value as any })} className="bg-white border border-slate-200 rounded-lg px-2 py-1">
                          <option value="paid">Cumple</option>
                          <option value="unpaid">Incumple</option>
                          <option value="none">N/A</option>
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <input value={pay.interestAmount || ''} onChange={e => updatePaymentPeriod(month, { interestAmount: e.target.value })} placeholder="Opcional" className="w-28 bg-white border border-slate-200 rounded-lg px-2 py-1 font-mono" />
                      </td>
                      <td className="px-3 py-2">
                        <input value={aforo.value} onChange={e => updateAforoPeriod(month, { value: e.target.value })} className="w-24 bg-white border border-slate-200 rounded-lg px-2 py-1 font-mono" />
                      </td>
                      <td className="px-3 py-2">
                        <select value={aforo.status} onChange={e => updateAforoPeriod(month, { status: e.target.value as any })} className="bg-white border border-slate-200 rounded-lg px-2 py-1">
                          <option value="good">Cumple</option>
                          <option value="warning">Alerta</option>
                          <option value="bad">Incumple</option>
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Pre-export comment editor ────────────────────────────────────────── */}
      {(condCovenants.length > 0 || latestTape) && (
        <div className="w-full max-w-5xl bg-white border border-indigo-200 rounded-2xl overflow-hidden shadow-sm print:hidden">
          <button
            onClick={() => setEditOpen(v => !v)}
            className="w-full flex items-center justify-between px-6 py-4 hover:bg-indigo-50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <MessageSquare className="w-4 h-4 text-indigo-600" />
              <span className="text-sm font-black text-indigo-900 uppercase tracking-wider">Comentarios del Reporte</span>
              <span className="text-xs text-indigo-500 font-semibold">— edita antes de exportar, se guardan automáticamente</span>
            </div>
            {editOpen ? <ChevronDown className="w-4 h-4 text-indigo-400" /> : <ChevronRight className="w-4 h-4 text-indigo-400" />}
          </button>

          {editOpen && (
            <div className="px-6 pb-6 space-y-6 border-t border-indigo-100">

              {/* Loan tape commentary */}
              {latestTape && (
                <div className="pt-5">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-black text-slate-700 uppercase tracking-widest">Observaciones de Cartera (Loan Tape)</p>
                    {tapeAnalysis && (
                      <span className="text-xs text-slate-400 font-medium">
                        Riesgo IA: {tapeAnalysis.overallStatus === 'good' ? '✅ Bueno' : tapeAnalysis.overallStatus === 'warning' ? '⚠️ Alerta' : '🔴 Crítico'} · Score {tapeAnalysis.riskScore}/100
                      </span>
                    )}
                  </div>
                  <textarea
                    value={tapeComment}
                    onChange={e => setTapeComment(e.target.value)}
                    onBlur={handleTapeCommentBlur}
                    rows={6}
                    placeholder={TAPE_PLACEHOLDER}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-800 resize-y focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-all placeholder:text-slate-300 placeholder:text-xs"
                  />
                  {tapeAnalysis?.findings?.filter(f => f.severity === 'high').length > 0 && (
                    <div className="mt-2 bg-rose-50 border border-rose-200 rounded-lg px-4 py-2.5">
                      <p className="text-xs font-bold text-rose-700 mb-1">Hallazgos críticos de la IA a considerar:</p>
                      <ul className="space-y-0.5">
                        {tapeAnalysis.findings.filter(f => f.severity === 'high').map((f, i) => (
                          <li key={i} className="text-xs text-rose-600">· {f.title}: {f.detail}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* Condition comments */}
              {condCovenants.length > 0 && (
                <div>
                  <p className="text-xs font-black text-slate-700 uppercase tracking-widest mb-4">Estado y Comentario por Condición</p>
                  <div className="space-y-3">
                    {condCovenants.map(cov => {
                      const currentStatus = condStatuses[cov.id] || 'CUMPLE';
                      const isHacer = cov.type === 'hacer';
                      return (
                        <div key={cov.id} className={`rounded-xl border p-4 ${isHacer ? 'bg-emerald-50 border-emerald-200' : 'bg-rose-50 border-rose-200'}`}>
                          <div className="flex items-start gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-2 flex-wrap">
                                <span className={`text-[10px] font-black px-1.5 py-0.5 rounded ${isHacer ? 'bg-emerald-200 text-emerald-900' : 'bg-rose-200 text-rose-900'}`}>
                                  {isHacer ? 'HACER' : 'NO HACER'}
                                </span>
                                <p className="text-xs font-semibold text-slate-800 flex-1">{cov.name}</p>
                              </div>
                              {cov.description && cov.description !== cov.name && (
                                <p className="text-xs text-slate-500 mb-2 leading-relaxed">{cov.description.slice(0, 120)}{cov.description.length > 120 ? '...' : ''}</p>
                              )}
                              <div className="flex items-center gap-3 mb-2">
                                <p className="text-xs font-bold text-slate-600">Estado:</p>
                                {(['CUMPLE', 'ALERTA', 'INCUMPLE'] as CondStatus[]).map(s => (
                                  <button
                                    key={s}
                                    onClick={() => setCondStatuses(prev => ({ ...prev, [cov.id]: s }))}
                                    className={`text-xs font-black px-3 py-1 rounded-lg border transition-all ${
                                      currentStatus === s
                                        ? s === 'CUMPLE' ? 'bg-emerald-600 text-white border-emerald-600'
                                          : s === 'ALERTA' ? 'bg-amber-500 text-white border-amber-500'
                                          : 'bg-rose-600 text-white border-rose-600'
                                        : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'
                                    }`}
                                  >
                                    {s}
                                  </button>
                                ))}
                              </div>
                              <textarea
                                value={condComments[cov.id] || ''}
                                onChange={e => setCondComments(prev => ({ ...prev, [cov.id]: e.target.value }))}
                                onBlur={() => handleCondBlur(cov.id)}
                                rows={2}
                                placeholder={`Comentario de la empresa sobre esta condición... (ej: Se entregó evidencia el DD/MM/AAAA, pendiente verificar...)`}
                                className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 resize-y focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-all placeholder:text-slate-300"
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── PAGE 1 ────────────────────────────────────────────────────────────── */}
      <div
        ref={page1Ref}
        id="pdf-page-1"
        className={`${pageClass} shadow-2xl mb-4`}
        style={{ fontFamily: "Arial, Helvetica, sans-serif", boxSizing: 'border-box', minHeight: 1123, paddingBottom: 96, position: 'relative' }}
      >
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 0 }}>
          {/* Header */}
          <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 80px', alignItems: 'center', marginBottom: 32, width: '100%', minHeight: 80 }}>
            <div style={{ ...vc, width: 80, height: 80, justifyContent: 'flex-start', overflow: 'hidden' }}>
              {client.logoLeft ? (
                <img src={client.logoLeft} alt="Logo Left" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
              ) : (
                <div style={{ fontSize: 12, fontWeight: 900, color: '#334155' }}>{client.name.split(' ')[0] || ''}</div>
              )}
            </div>
            <div style={{ ...vccCol }}>
              <h1 style={{ fontSize: 28, fontWeight: 900, color: '#0018E6', borderBottom: '4px solid #0018E6', paddingBottom: 10, textTransform: 'uppercase', display: 'inline-block', lineHeight: 1.3, margin: 0 }}>
                Reporte de Monitoreo
              </h1>
            </div>
            <div style={{ ...vc, width: 80, height: 80, justifyContent: 'flex-end', overflow: 'hidden' }}>
              {client.logoRight ? (
                <img src={client.logoRight} alt="Logo Right" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
              ) : (
                <span style={{ color: '#0018E6', fontSize: 40, fontWeight: 900, lineHeight: 1 }}>A</span>
              )}
            </div>
          </div>

          {/* Info Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
            <div style={{ gridColumn: '1 / 3', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {[
                { label: 'Acreditado', value: commercialName },
                ...(showContractFooter ? [{ label: 'Contrato', value: selectedContractLabel }] : []),
                { label: 'Score AXCESS', value: client.score || 'N/A' },
                { label: 'Tipo de Crédito', value: (client.creditType || []).join(', ') || 'N/A' },
              ].map(({ label, value }) => (
                <div key={label} style={{ ...vc, minHeight: 34 }}>
                  <div style={{ ...vcc, width: 112, minWidth: 112, backgroundColor: '#0018E6', color: 'white', padding: '6px 12px', fontSize: 9, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.05em', alignSelf: 'stretch' }}>
                    {label}
                  </div>
                  <div style={{ ...vcc, flex: 1, border: '1px solid #e2e8f0', padding: '6px 12px', fontSize: 12, fontWeight: 700, alignSelf: 'stretch', textAlign: 'center' }}>
                    {value}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ ...vccCol, backgroundColor: '#0018E6', color: 'white', borderRadius: 12, padding: 12, minHeight: 96 }}>
              <span style={{ fontSize: 7, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', opacity: 0.7 }}>Periodo de Monitoreo</span>
              <span style={{ fontSize: 18, fontWeight: 900, marginTop: 4 }}>{periodLabel(reportPeriod)}</span>
            </div>
          </div>

          {/* Stats Row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
            {[
              { label: 'Atrasos (12 meses)', value: `${client.defaultFrequency12m || 0}` },
              { label: 'Días incumplimiento', value: `${client.maxDefaultDays || 0}` },
              { label: `Monto máximo (${client.currency || 'MXN'})`, value: fmtMoney(client.maxDefaultAmount || 0, client.currency || 'MXN') },
            ].map(({ label, value }) => (
              <div key={label} style={{ ...vccCol, border: '1px solid #e2e8f0', borderRadius: 12, padding: 8, textAlign: 'center' }}>
                <span style={{ fontSize: 7, fontWeight: 900, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 2 }}>{label}</span>
                <span style={{ fontSize: 16, fontWeight: 900, color: '#0066E6' }}>{value}</span>
              </div>
            ))}
          </div>

          {/* Balances */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
            <div style={{ ...vc, justifyContent: 'space-between', border: '1px solid #0018E6', borderRadius: 12, padding: '6px 12px', backgroundColor: '#f8fafc', minHeight: 36 }}>
              <span style={{ fontSize: 9, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#0066E6' }}>Saldo Inicial ({client.currency || 'MXN'})</span>
              <span style={{ fontSize: 12, fontWeight: 900, fontFamily: 'monospace', color: '#0066E6' }}>{fmtMoney(client.totalCreditValue, client.currency || 'MXN')}</span>
            </div>
            <div style={{ ...vc, justifyContent: 'space-between', border: '1px solid #0018E6', borderRadius: 12, padding: '6px 12px', backgroundColor: '#0018E6', color: 'white', minHeight: 36 }}>
              <span style={{ fontSize: 9, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Saldo Actual ({client.currency || 'MXN'})</span>
              <span style={{ fontSize: 12, fontWeight: 900, fontFamily: 'monospace' }}>{fmtMoney(client.currentDue || 0, client.currency || 'MXN')}</span>
            </div>
          </div>

          {/* Cobranza */}
          {paymentHistory.length > 0 && blockVisible('payment') && (
          <div style={{ marginBottom: 24, ...blockStyle('payment') }}>
            <h3 style={{ fontSize: 12, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#0066E6', margin: '0 0 16px 0' }}>Cobranza</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ width: 112 }} />
                  {paymentHistory.map(h => <th key={h.month} style={{ ...tdVC, border: '1px solid #e2e8f0', backgroundColor: '#f8fafc', padding: '10px 4px', fontSize: 11, fontWeight: 900, textTransform: 'uppercase' }}>{periodLabel(h.month)}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ ...tdVC, padding: '14px 4px', fontSize: 11, fontWeight: 900, color: '#64748b', textTransform: 'uppercase' }}>Capital</td>
                  {paymentHistory.map(h => (
                    <TD key={h.month} style={{ ...cellCStyle }}>
                      <StatusCircle status={h.principalStatus} />
                      {h.principalAmount && <div style={{ marginTop: 4, fontSize: 7, fontFamily: 'monospace', fontWeight: 900, color: '#64748b' }}>{fmtMoney(h.principalAmount, client.currency || 'MXN')}</div>}
                    </TD>
                  ))}
                </tr>
                <tr>
                  <td style={{ ...tdVC, padding: '14px 4px', fontSize: 11, fontWeight: 900, color: '#64748b', textTransform: 'uppercase' }}>Intereses</td>
                  {paymentHistory.map(h => (
                    <TD key={h.month} style={{ ...cellCStyle }}>
                      <StatusCircle status={h.interestStatus} />
                      {h.interestAmount && <div style={{ marginTop: 4, fontSize: 7, fontFamily: 'monospace', fontWeight: 900, color: '#64748b' }}>{fmtMoney(h.interestAmount, client.currency || 'MXN')}</div>}
                    </TD>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* Aforo */}
        {aforoHistory.length > 0 && blockVisible('aforo') && (
          <div style={{ marginBottom: 24, width: '100%', ...blockStyle('aforo') }}>
            <h3 style={{ fontSize: 9, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#0066E6', margin: '0 0 8px 0' }}>Aforo</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                <tr>
                  <TD style={{ width: 112, backgroundColor: '#0018E6', color: '#fff', textAlign: 'center', fontWeight: 900 }}>{fmtAforoValue(client.aforoRequerido || '')}</TD>
                  {aforoHistory.map(a => (
                    <TD key={a.month} style={{ ...cellCStyle, backgroundColor: a.status === 'bad' ? '#fee2e2' : a.status === 'warning' ? '#fef3c7' : '#dcfce7', fontFamily: 'monospace', fontWeight: 900, color: a.status === 'bad' ? '#e11d48' : '#059669' }}>
                      {reportMode === 'interno' ? fmtAforoValue(a.value) : <AforoCircle status={a.status} />}
                    </TD>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* Financial covenants */}
        {financialCovenants.length > 0 && blockVisible('financialCovenants') && (
          <div style={{ marginBottom: 24, width: '100%', ...blockStyle('financialCovenants') }}>
            <h3 style={{ fontSize: 12, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#0066E6', margin: '0 0 16px 0' }}>Covenants Financieros</h3>
            {covenantFrequencyGroups.map(group => (
              <div key={group.frequency} style={{ marginBottom: 12 }}>
                {covenantFrequencyGroups.length > 1 && (
                  <div style={{ fontSize: 8, fontWeight: 900, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 5px 0' }}>
                    {frequencyLabels[group.frequency]}
                  </div>
                )}
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <TH>Indicador</TH>
                      <TH style={{ textAlign: 'center' }}>Requerido</TH>
                      {group.periods.map(period => <TH key={period} style={{ textAlign: 'center' }}>{periodLabel(period)}</TH>)}
                    </tr>
                  </thead>
                  <tbody>
                    {group.covenants.map((cov, i) => (
                      <tr key={cov.id} style={{ backgroundColor: i % 2 === 0 ? '#fff' : '#f8fafc' }}>
                        <TD>
                          <span style={{ fontWeight: 900, color: '#0070c9' }}>{cov.name}</span>
                          <br/><span style={{ fontSize: 7, color: '#94a3b8' }}>{cov.description}</span>
                        </TD>
                        <TD style={{ ...cellCStyle, fontFamily: 'monospace', fontWeight: 900 }}>{fmtCovenantThreshold(cov)}</TD>
                        {group.periods.map(period => {
                          const statement = statementForMonth(period);
                          if (!statement) {
                            return (
                              <TD key={period} style={{ ...cellCStyle, backgroundColor: '#f8fafc', color: '#94a3b8', fontWeight: 900 }}>
                                NA
                              </TD>
                            );
                          }
                          const { value, status } = evaluateCovenant(cov, [statement]);
                          const bg = status === 'INCUMPLE' ? '#fee2e2' : status === 'ALERTA' ? '#fef3c7' : '#dcfce7';
                          return (
                            <TD key={period} style={{ ...cellCStyle, backgroundColor: bg, fontFamily: 'monospace', fontWeight: 900 }}>
                              {reportMode === 'interno' ? fmtCovenantValue(cov, value) : <AforoCircle status={status === 'INCUMPLE' ? 'bad' : status === 'ALERTA' ? 'warning' : 'good'} />}
                            </TD>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}

        {/* Loan tape summary + commentary */}
        {blockVisible('loanTape') && reportMode === 'interno' && (tapeAnalysis || tapeComment) && (
          <div style={{ ...sectionCard, ...blockStyle('loanTape') }}>
            <div style={sectionKicker}>Cartera</div>
            <div style={sectionTitle}>Análisis de Cartera</div>
            {tapeAnalysis && (
              <>
                <div style={{ backgroundColor: '#f0fdf4', borderRadius: 8, padding: '8px 12px', border: '1px solid #bbf7d0', marginBottom: 8 }}>
                  <p style={{ fontSize: 9, color: '#166534', margin: 0, lineHeight: 1.5 }}>{tapeAnalysis.executiveSummary}</p>
                </div>
                {tapeAnalysis.metrics?.length > 0 && (
                  <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
                    <thead>
                      <tr>
                        <TH>Métrica</TH>
                        <TH style={{ textAlign: 'right' }}>Valor</TH>
                        <TH style={{ textAlign: 'right' }}>Anterior</TH>
                        <TH style={{ textAlign: 'center' }}>Estado</TH>
                      </tr>
                    </thead>
                    <tbody>
                      {tapeAnalysis.metrics.slice(0, 6).map((m, i) => {
                        const sc = m.status === 'good' ? '#059669' : m.status === 'warning' ? '#d97706' : '#e11d48';
                        return (
                          <tr key={i} style={{ backgroundColor: i % 2 === 0 ? '#fff' : '#f8fafc' }}>
                            <TD>{m.name}</TD>
                            <TD style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 700 }}>{m.latestValue}</TD>
                            <TD style={{ textAlign: 'right', fontFamily: 'monospace', color: '#94a3b8' }}>{m.previousValue || '—'}</TD>
                            <TD style={{ textAlign: 'center' }}>
                              <span style={{ backgroundColor: sc + '20', color: sc, padding: '2px 6px', borderRadius: 4, fontSize: 8, fontWeight: 900 }}>
                                {m.status === 'good' ? 'BUENO' : m.status === 'warning' ? 'ALERTA' : 'CRÍTICO'}
                              </span>
                            </TD>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </>
            )}
            {/* Analyst commentary on loan tape */}
            {tapeComment && (
              <div style={{ backgroundColor: '#fffbeb', borderRadius: 8, padding: '10px 14px', border: '1px solid #fde68a' }}>
                <div style={{ fontSize: 8, fontWeight: 900, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Observaciones del Analista</div>
                <p style={{ fontSize: 9, color: '#78350f', lineHeight: 1.6, whiteSpace: 'pre-wrap', margin: 0 }}>{tapeComment}</p>
              </div>
            )}
          </div>
        )}

        {/* Documentation */}
        {client.documentation?.length > 0 && blockVisible('documentation') && (
          <div style={{ marginBottom: 24, width: '100%', ...blockStyle('documentation') }}>
            <h3 style={{ fontSize: 12, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#0066E6', margin: '0 0 16px 0' }}>Documentación</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <TH>Documento</TH>
                  <TH style={{ textAlign: 'center' }}>Fecha</TH>
                  <TH style={{ textAlign: 'center' }}>Periodicidad</TH>
                  <TH style={{ textAlign: 'center' }}>Status</TH>
                  <TH>Comentarios</TH>
                </tr>
              </thead>
              <tbody>
                {client.documentation.map((doc, i) => (
                  <tr key={doc.id} style={{ backgroundColor: i % 2 === 0 ? '#fff' : '#f8fafc' }}>
                    <TD>{doc.name}</TD>
                    <TD style={{ ...cellCStyle }}>{doc.date.toUpperCase()}</TD>
                    <TD style={{ ...cellCStyle }}>{doc.periodicity}</TD>
                    <TD style={{ ...cellCStyle }}><BoolCircle val={doc.isCompliant} /></TD>
                    <TD>{doc.comments || '-'}</TD>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Analyst opinion */}
        {reportMode === 'interno' && client.opinion && blockVisible('opinion') && (
          <div style={{ ...sectionCard, ...blockStyle('opinion'), backgroundColor: '#f8fbff', borderColor: '#bfdbfe' }}>
            <div style={sectionKicker}>Comentario</div>
            <div style={sectionTitle}>Opinión del Analista</div>
            <p style={{ fontSize: 9, color: '#334155', lineHeight: 1.6, whiteSpace: 'pre-wrap', margin: 0 }}>{client.opinion}</p>
          </div>
        )}

        <ReportFooter />
        </div>
      </div>

      {/* ── PAGE 2: Conditions with status + commentary ───────────────────────── */}
      {(hacerCovenants.length > 0 || noHacerCovenants.length > 0) && (
        <div
          ref={condRef}
          className="pdf-page"
          style={{ width: 794, backgroundColor: '#f8fafc', padding: '36px 44px', fontFamily: "'Inter', 'Helvetica Neue', Arial, sans-serif", boxSizing: 'border-box' }}
        >
          <div style={{ ...vc, gap: 14, marginBottom: 24 }}>
            <div style={{ ...vcc, width: 46, height: 46, borderRadius: 14, backgroundColor: '#ffffff', color: '#0018E6', fontSize: 20, fontWeight: 900, border: '1px solid #dbe3ef' }}>FM</div>
            <div>
              <div style={{ fontSize: 24, fontWeight: 900, color: '#020617', letterSpacing: '-0.04em', lineHeight: 1 }}>{commercialName}</div>
              <div style={{ fontSize: 12, fontWeight: 900, color: '#6b98ff', marginTop: 5 }}>Condiciones Contractuales</div>
            </div>
          </div>

          {hacerCovenants.length > 0 && (
            <div style={sectionCard}>
              <div style={sectionKicker}>Cumplimiento</div>
              <div style={sectionTitle}>Obligaciones de Hacer ({hacerCovenants.length})</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <TH style={{ width: '45%' }}>Obligación</TH>
                    <TH style={{ textAlign: 'center', width: '12%' }}>Estado</TH>
                    <TH>Comentario de la Empresa</TH>
                  </tr>
                </thead>
                <tbody>
                  {hacerCovenants.map((cov, i) => {
                    const status = condStatuses[cov.id] || 'CUMPLE';
                    const comment = condComments[cov.id] || '';
                    const s = STATUS_STYLE[status];
                    return (
                      <tr key={cov.id} style={{ backgroundColor: i % 2 === 0 ? '#fff' : '#f8fafc' }}>
                        <TD style={{ verticalAlign: 'top' }}>{cov.description || cov.name}</TD>
                        <TD style={{ ...cellCStyle, verticalAlign: 'top' }}>
                          <StatusPill status={status} />
                        </TD>
                        <TD style={{ verticalAlign: 'top', fontSize: 8, color: comment ? '#334155' : '#94a3b8', fontStyle: comment ? 'normal' : 'italic' }}>
                          {comment || 'Sin comentario'}
                        </TD>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {noHacerCovenants.length > 0 && (
            <div style={sectionCard}>
              <div style={sectionKicker}>Restricciones</div>
              <div style={sectionTitle}>No Hacer ({noHacerCovenants.length})</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <TH style={{ width: '45%' }}>Restricción</TH>
                    <TH style={{ textAlign: 'center', width: '12%' }}>Estado</TH>
                    <TH>Comentario de la Empresa</TH>
                  </tr>
                </thead>
                <tbody>
                  {noHacerCovenants.map((cov, i) => {
                    const status = condStatuses[cov.id] || 'CUMPLE';
                    const comment = condComments[cov.id] || '';
                    return (
                      <tr key={cov.id} style={{ backgroundColor: i % 2 === 0 ? '#fff' : '#f8fafc' }}>
                        <TD style={{ verticalAlign: 'top' }}>{cov.description || cov.name}</TD>
                        <TD style={{ ...cellCStyle, verticalAlign: 'top' }}>
                          <StatusPill status={status} />
                        </TD>
                        <TD style={{ verticalAlign: 'top', fontSize: 8, color: comment ? '#334155' : '#94a3b8', fontStyle: comment ? 'normal' : 'italic' }}>
                          {comment || 'Sin comentario'}
                        </TD>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <ReportFooter />
        </div>
      )}
    </div>
  );
};

export default ClientReportView;
