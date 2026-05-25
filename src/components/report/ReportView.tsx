import React, { useRef, useState, useEffect } from 'react';
import { db, Client, FinancialStatement_DB, Covenant_DB, LoanTape_DB } from '../../db/index';
import { StructuredLoanTapeAnalysis } from '../../services/ai';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import { Download, ChevronDown, ChevronRight, MessageSquare, FileSpreadsheet, Upload, Trash2, ImageDown } from 'lucide-react';
import * as XLSX from 'xlsx';
import { evaluateCovenantAuto } from '../../lib/financialMetrics';

interface Props {
  client: Client;
  statements: FinancialStatement_DB[];
  covenants: Covenant_DB[];
  loanTapes: LoanTape_DB[];
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
    .pdf-page [style*="display: flex"], .pdf-page [style*="display:flex"] {
      align-items: flex-start !important;
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

const fmtNum = (n: number) => {
  if (!n) return '—';
  return n.toLocaleString('es-MX', { maximumFractionDigits: 6 });
};

const fmtDate = (d?: string) => {
  if (!d) return '—';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d.toUpperCase();
  const [y, m] = d.split('-');
  const months = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
  return `${months[parseInt(m) - 1]} ${y.substring(2)}`;
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

const ClientReportView: React.FC<Props> = ({ client, statements, covenants, loanTapes, onClientUpdate, onClose }) => {
  const page1Ref = useRef<HTMLDivElement>(null);
  const condRef = useRef<HTMLDivElement>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [editOpen, setEditOpen] = useState(true);
  const [reportMode, setReportMode] = useState<'inv' | 'interno'>('inv');
  const [showAforo, setShowAforo] = useState(true);
  const [showCovenants, setShowCovenants] = useState(true);
  const [showDocs, setShowDocs] = useState(true);
  const [showLoanTape, setShowLoanTape] = useState(true);

  // ── Comment state ────────────────────────────────────────────────────────────
  const [condStatuses, setCondStatuses] = useState<Record<string, CondStatus>>({});
  const [condComments, setCondComments] = useState<Record<string, string>>({});
  const [tapeComment, setTapeComment] = useState('');

  const sortedStatements = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate));
  const latest = sortedStatements.length > 0 ? sortedStatements[sortedStatements.length - 1] : null;
  const latestTape = loanTapes.length > 0 ? loanTapes[0] : null;
  const tapeAnalysis: StructuredLoanTapeAnalysis | null = latestTape?.extractedData?._analysis || null;

  const paymentHistory = [...(client.paymentHistory || [])].slice(0, 6);
  const aforoHistory = [...(client.aforoHistory || [])].slice(0, 6);
  const reportPeriods = paymentHistory.map(p => p.month || '').filter(Boolean);
  const reportPeriod = latest?.period || client.lastPeriod || reportPeriods[0] || '—';
  const financialCovenants = covenants.filter(c => c.type === 'financial');
  const hacerCovenants = covenants.filter(c => c.type === 'hacer');
  const noHacerCovenants = covenants.filter(c => c.type === 'noHacer');
  const condCovenants = [...hacerCovenants, ...noHacerCovenants];

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
    const canvas = await html2canvas(page1Ref.current, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: '#ffffff',
      imageTimeout: 0,
      onclone: d => sanitizeColors(d),
    });
    downloadDataUrl(canvas.toDataURL('image/png'), `Reporte_Monitoreo_${client.name}.png`);
  };

  const updatePaymentPeriod = (idx: number, updates: Partial<Client['paymentHistory'][number]>) => {
    const next = [...(client.paymentHistory || [])];
    next[idx] = { ...next[idx], ...updates };
    onClientUpdate({ paymentHistory: next });
  };

  const updateAforoPeriod = (idx: number, updates: Partial<Client['aforoHistory'][number]>) => {
    const next = [...(client.aforoHistory || [])];
    next[idx] = { ...next[idx], ...updates };
    onClientUpdate({ aforoHistory: next });
  };

  const addReportPeriod = () => {
    const month = client.lastPeriod || latest?.period || 'N/A';
    onClientUpdate({
      paymentHistory: [...(client.paymentHistory || []), { month, principalStatus: 'none', interestStatus: 'none' }],
      aforoHistory: [...(client.aforoHistory || []), { month, value: '', status: 'warning' }],
    });
  };

  const renderPageToPDF = async (el: HTMLElement, pdf: jsPDF, addNewPage = false) => {
    const PAGE_W = 210, PAGE_H = 297;
    const canvas = await html2canvas(el, {
      scale: 2, useCORS: true, logging: false, backgroundColor: '#ffffff',
      imageTimeout: 0,
      windowWidth: el.scrollWidth, windowHeight: el.scrollHeight,
      scrollX: 0, scrollY: 0, onclone: (d) => sanitizeColors(d),
    });
    const imgData = canvas.toDataURL('image/jpeg', 0.95);
    const imgHeight = (canvas.height * PAGE_W) / canvas.width;
    if (addNewPage) pdf.addPage();
    let fW = PAGE_W, fH = imgHeight, x = 0, y = 0;
    if (fH > PAGE_H) { fH = PAGE_H; fW = PAGE_H * (canvas.width / canvas.height); x = (PAGE_W - fW) / 2; }
    pdf.addImage(imgData, 'JPEG', x, y, fW, fH);
  };

  const exportPDF = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
      if (page1Ref.current) await renderPageToPDF(page1Ref.current, pdf, false);
      if (condRef.current && (hacerCovenants.length > 0 || noHacerCovenants.length > 0)) {
        await renderPageToPDF(condRef.current, pdf, true);
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

  const exportExcel = () => {
    const wb = XLSX.utils.book_new();

    const resumen = [
      ['Cliente', client.name],
      ['RFC', client.taxId],
      ['Industria', client.industry],
      ['Contrato', client.contractName || ''],
      ['Analista', client.analystName || ''],
      ['Fecha reporte', client.reportDate || ''],
      ['Linea credito', client.totalCreditValue],
      ['Moneda', client.currency],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumen), 'Resumen');

    if (sortedStatements.length > 0) {
      const periods = sortedStatements.map(s => s.period);
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
      const rows = [['Seccion', 'Cuenta', ...periods]];
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
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Data Raw');
    }

    if (financialCovenants.length > 0) {
      const rows = [['Covenant', 'Formula', 'Umbral', 'Valor actual', 'Estado']];
      financialCovenants.forEach(cov => {
        const { value, status } = evaluateCovenant(cov, sortedStatements);
        rows.push([cov.name, cov.formula, cov.threshold, value ?? '', status]);
      });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Covenants');
    }

    XLSX.writeFile(wb, `Reporte_Monitoreo_${client.name}.xlsx`);
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
    <div style={{ ...vc, justifyContent: 'space-between', borderTop: '2px solid #0018E6', paddingTop: 16, marginTop: 32 }}>
      <div style={{ ...vccCol, flex: 1 }}>
        <p style={{ fontSize: 8, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#94a3b8', margin: 0 }}>Analista Responsable</p>
        <p style={{ fontSize: 12, fontWeight: 900, color: '#0066E6', margin: '2px 0 0 0' }}>{client.analystName || 'No asignado'}</p>
      </div>
      <div style={{ ...vccCol, flex: 1 }}>
        <p style={{ fontSize: 8, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#94a3b8', margin: 0 }}>Fecha de Reporte</p>
        <p style={{ fontSize: 12, fontWeight: 900, color: '#334155', margin: '2px 0 0 0' }}>{fmtDate(client.reportDate)}</p>
      </div>
      <div style={{ ...vccCol, flex: 1 }}>
        <p style={{ fontSize: 8, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#94a3b8', margin: 0 }}>Contrato</p>
        <p style={{ fontSize: 12, fontWeight: 900, color: '#334155', margin: '2px 0 0 0' }}>{client.contractName || '—'}</p>
      </div>
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
            { label: 'Aforo', state: showAforo, set: setShowAforo },
            { label: 'Covenants', state: showCovenants, set: setShowCovenants },
            { label: 'Doc.', state: showDocs, set: setShowDocs },
            { label: 'Loan Tape', state: showLoanTape, set: setShowLoanTape },
          ].map(({ label, state, set }) => (
            <button key={label} onClick={() => set(!state)}
              className={`px-3 py-1.5 rounded-xl text-[9px] font-black uppercase transition-all ${state ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="w-full max-w-5xl bg-white border border-slate-200 rounded-2xl p-6 shadow-sm print:hidden">
        <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">Campos del Reporte</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <label>
            <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Contrato</span>
            <input value={client.contractName || ''} onChange={e => onClientUpdate({ contractName: e.target.value })} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-400" />
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
            <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Línea Crédito</span>
            <input type="number" value={client.totalCreditValue || 0} onChange={e => onClientUpdate({ totalCreditValue: Number(e.target.value) || 0 })} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono font-bold outline-none focus:ring-2 focus:ring-indigo-400" />
          </label>
          <label>
            <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Aforo requerido</span>
            <input value={client.aforoRequerido || ''} onChange={e => onClientUpdate({ aforoRequerido: e.target.value })} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono font-bold outline-none focus:ring-2 focus:ring-indigo-400" />
          </label>
          <label>
            <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Calificación</span>
            <input value={client.score || ''} onChange={e => onClientUpdate({ score: e.target.value })} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-400" />
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
            <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Editar tablero mensual</p>
            <button onClick={addReportPeriod} className="bg-indigo-600 text-white px-3 py-2 rounded-lg text-xs font-black">Agregar periodo</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 text-slate-500 uppercase tracking-wider">
                  <th className="text-left px-3 py-2">Periodo</th>
                  <th className="text-left px-3 py-2">Capital</th>
                  <th className="text-left px-3 py-2">Intereses</th>
                  <th className="text-left px-3 py-2">Aforo</th>
                  <th className="text-left px-3 py-2">Estado aforo</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: Math.max(client.paymentHistory?.length || 0, client.aforoHistory?.length || 0) }).map((_, idx) => {
                  const pay = client.paymentHistory?.[idx] || { month: '', principalStatus: 'none', interestStatus: 'none' };
                  const aforo = client.aforoHistory?.[idx] || { month: pay.month, value: '', status: 'warning' as const };
                  return (
                    <tr key={idx} className="border-t border-slate-100">
                      <td className="px-3 py-2">
                        <input value={pay.month || aforo.month || ''} onChange={e => {
                          updatePaymentPeriod(idx, { month: e.target.value });
                          updateAforoPeriod(idx, { month: e.target.value });
                        }} className="w-28 bg-white border border-slate-200 rounded-lg px-2 py-1 font-bold" />
                      </td>
                      <td className="px-3 py-2">
                        <select value={pay.principalStatus} onChange={e => updatePaymentPeriod(idx, { principalStatus: e.target.value as any })} className="bg-white border border-slate-200 rounded-lg px-2 py-1">
                          <option value="paid">Cumple</option>
                          <option value="unpaid">Incumple</option>
                          <option value="none">N/A</option>
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <select value={pay.interestStatus} onChange={e => updatePaymentPeriod(idx, { interestStatus: e.target.value as any })} className="bg-white border border-slate-200 rounded-lg px-2 py-1">
                          <option value="paid">Cumple</option>
                          <option value="unpaid">Incumple</option>
                          <option value="none">N/A</option>
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <input value={aforo.value} onChange={e => updateAforoPeriod(idx, { value: e.target.value })} className="w-24 bg-white border border-slate-200 rounded-lg px-2 py-1 font-mono" />
                      </td>
                      <td className="px-3 py-2">
                        <select value={aforo.status} onChange={e => updateAforoPeriod(idx, { status: e.target.value as any })} className="bg-white border border-slate-200 rounded-lg px-2 py-1">
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
        style={{ fontFamily: "Arial, Helvetica, sans-serif", boxSizing: 'border-box' }}
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
                { label: 'Acreditado', value: client.name },
                { label: 'Score AXCESS', value: client.score || 'N/A' },
                { label: 'Tipo de Crédito', value: (client.creditType || []).join(', ') || 'N/A' },
              ].map(({ label, value }) => (
                <div key={label} style={{ ...vc, minHeight: 34 }}>
                  <div style={{ ...vcc, width: 112, minWidth: 112, backgroundColor: '#0018E6', color: 'white', padding: '6px 12px', fontSize: 9, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.05em', alignSelf: 'stretch' }}>
                    {label}
                  </div>
                  <div style={{ ...vcc, flex: 1, border: '1px solid #e2e8f0', padding: '6px 12px', fontSize: 12, fontWeight: 700, alignSelf: 'stretch' }}>
                    {value}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ ...vccCol, backgroundColor: '#0018E6', color: 'white', borderRadius: 12, padding: 12, minHeight: 96 }}>
              <span style={{ fontSize: 7, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', opacity: 0.7 }}>Periodo de Monitoreo</span>
              <span style={{ fontSize: 18, fontWeight: 900, marginTop: 4 }}>{reportPeriod}</span>
            </div>
          </div>

          {/* Stats Row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
            {[
              { label: 'Atrasos (12 meses)', value: `${client.defaultFrequency12m || 0}` },
              { label: 'Días incumplimiento', value: `${client.maxDefaultDays || 0}` },
              { label: `Monto máximo ($ ${client.currency || 'MXN'})`, value: fmtNum(client.maxDefaultAmount || 0) },
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
              <span style={{ fontSize: 9, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#0066E6' }}>Saldo Inicial ($ {client.currency || 'MXN'})</span>
              <span style={{ fontSize: 12, fontWeight: 900, fontFamily: 'monospace', color: '#0066E6' }}>{fmtNum(client.totalCreditValue)}</span>
            </div>
            <div style={{ ...vc, justifyContent: 'space-between', border: '1px solid #0018E6', borderRadius: 12, padding: '6px 12px', backgroundColor: '#0018E6', color: 'white', minHeight: 36 }}>
              <span style={{ fontSize: 9, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Saldo Actual ($ {client.currency || 'MXN'})</span>
              <span style={{ fontSize: 12, fontWeight: 900, fontFamily: 'monospace' }}>{fmtNum(client.currentDue || 0)}</span>
            </div>
          </div>

          {/* Payment history */}
          {paymentHistory.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <h3 style={{ fontSize: 12, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#0066E6', margin: '0 0 16px 0' }}>Historial de Pagos</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ width: 112 }} />
                  {paymentHistory.map(h => <th key={h.month} style={{ ...tdVC, border: '1px solid #e2e8f0', backgroundColor: '#f8fafc', padding: '10px 4px', fontSize: 11, fontWeight: 900, textTransform: 'uppercase' }}>{h.month}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ ...tdVC, padding: '14px 4px', fontSize: 11, fontWeight: 900, color: '#64748b', textTransform: 'uppercase' }}>Capital</td>
                  {paymentHistory.map(h => <TD key={h.month} style={{ ...cellCStyle }}><StatusCircle status={h.principalStatus} /></TD>)}
                </tr>
                <tr>
                  <td style={{ ...tdVC, padding: '14px 4px', fontSize: 11, fontWeight: 900, color: '#64748b', textTransform: 'uppercase' }}>Intereses</td>
                  {paymentHistory.map(h => <TD key={h.month} style={{ ...cellCStyle }}><StatusCircle status={h.interestStatus} /></TD>)}
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* Aforo */}
        {showAforo && aforoHistory.length > 0 && (
          <div style={{ marginBottom: 24, width: '100%' }}>
            <h3 style={{ fontSize: 9, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#0066E6', margin: '0 0 8px 0' }}>Aforo</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                <tr>
                  <TD style={{ width: 112, backgroundColor: '#0018E6', color: '#fff', textAlign: 'center', fontWeight: 900 }}>{client.aforoRequerido || 'N/A'}</TD>
                  {aforoHistory.map(a => (
                    <TD key={a.month} style={{ ...cellCStyle, backgroundColor: a.status === 'bad' ? '#fee2e2' : a.status === 'warning' ? '#fef3c7' : '#dcfce7', fontFamily: 'monospace', fontWeight: 900, color: a.status === 'bad' ? '#e11d48' : '#059669' }}>
                      {reportMode === 'interno' ? a.value : <AforoCircle status={a.status} />}
                    </TD>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* Financial covenants */}
        {showCovenants && financialCovenants.length > 0 && (
          <div style={{ marginBottom: 24, width: '100%' }}>
            <h3 style={{ fontSize: 12, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#0066E6', margin: '0 0 16px 0' }}>Covenants Financieros</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <TH>Indicador</TH>
                  <TH style={{ textAlign: 'center' }}>Requerido</TH>
                  {sortedStatements.slice(-6).reverse().map(s => <TH key={s.id} style={{ textAlign: 'center' }}>{s.period}</TH>)}
                </tr>
              </thead>
              <tbody>
                {financialCovenants.map((cov, i) => {
                  return (
                    <tr key={cov.id} style={{ backgroundColor: i % 2 === 0 ? '#fff' : '#f8fafc' }}>
                      <TD><span style={{ fontWeight: 900, color: '#0070c9' }}>{cov.name}</span><br/><span style={{ fontSize: 7, color: '#94a3b8' }}>{cov.description}</span></TD>
                      <TD style={{ ...cellCStyle, fontFamily: 'monospace', fontWeight: 900 }}>{cov.threshold}</TD>
                      {sortedStatements.slice(-6).reverse().map(statement => {
                        const { value, status } = evaluateCovenant(cov, [statement]);
                        const bg = status === 'INCUMPLE' ? '#fee2e2' : status === 'ALERTA' ? '#fef3c7' : '#dcfce7';
                        return (
                          <TD key={statement.id} style={{ ...cellCStyle, backgroundColor: bg, fontFamily: 'monospace', fontWeight: 900 }}>
                            {value === null ? 'NA' : reportMode === 'interno' ? value.toLocaleString('es-MX', { maximumFractionDigits: 4 }) : <AforoCircle status={status === 'INCUMPLE' ? 'bad' : status === 'ALERTA' ? 'warning' : 'good'} />}
                          </TD>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Loan tape summary + commentary */}
        {showLoanTape && reportMode === 'interno' && (tapeAnalysis || tapeComment) && (
          <div style={sectionCard}>
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
        {showDocs && client.documentation?.length > 0 && (
          <div style={{ marginBottom: 24, width: '100%' }}>
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
        {reportMode === 'interno' && client.opinion && (
          <div style={{ ...sectionCard, backgroundColor: '#f8fbff', borderColor: '#bfdbfe' }}>
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
              <div style={{ fontSize: 24, fontWeight: 900, color: '#020617', letterSpacing: '-0.04em', lineHeight: 1 }}>{client.name}</div>
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
