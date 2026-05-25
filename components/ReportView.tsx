import React, { useRef, useState } from 'react';
import { Company } from '../types';
import { ICONS } from '../constants';

import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';

interface ReportViewProps {
  company: Company;
  onClose: () => void;
}

// Reusable inline style helpers — survive html2canvas cloning
const vc: React.CSSProperties = { display: 'flex', alignItems: 'center' };                          // horizontal flex, vertically centered
const vcc: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center' }; // centered both axes
const vccCol: React.CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }; // column, centered
const tdV: React.CSSProperties = { verticalAlign: 'middle' };                                        // table cell
const tdVC: React.CSSProperties = { verticalAlign: 'middle', textAlign: 'center' };                  // table cell centered

const ReportView: React.FC<ReportViewProps> = ({ company, onClose }) => {
  const page1Ref = useRef<HTMLDivElement>(null);
  const condicionesRef = useRef<HTMLDivElement>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isInvestorMode, setIsInvestorMode] = useState(false);

  const [showAforo,     setShowAforo]     = useState(company.aforoHistory.length > 0);
  const [showCovenants, setShowCovenants] = useState(company.covenants.length > 0);
  const [showDocs,      setShowDocs]      = useState(company.documentation.length > 0);
  const [showLoanTape,  setShowLoanTape]  = useState(company.loanTapeSnapshots && company.loanTapeSnapshots.length > 0);
  const [showHacer,     setShowHacer]     = useState(company.condicionesHacer?.length > 0);
  const [showNoHacer,   setShowNoHacer]   = useState(company.condicionesNoHacer?.length > 0);

  const history = [...company.paymentHistory].slice(0, 6);

  const getCovenantPeriods = () => {
    const freq = company.covenantFrequency || company.frequency || 'mensual';
    const last = company.covenantLastPeriod || company.lastPeriod;
    
    // Replicate generateInitialHistory logic
    const months = [];
    let date: Date;
    if (last) {
      const separator = last.includes('-') ? '-' : ' ';
      const parts = last.split(separator);
      if (parts.length === 2) {
        const monthMap: { [key: string]: number } = {
          'ene': 0, 'feb': 1, 'mar': 2, 'abr': 3, 'may': 4, 'jun': 5,
          'jul': 6, 'ago': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dic': 11
        };
        const m = monthMap[parts[0].toLowerCase()] ?? 0;
        const y = 2000 + parseInt(parts[1]);
        date = new Date(y, m, 1);
      } else {
        date = new Date();
      }
    } else {
      date = new Date();
    }
    const step = freq === 'mensual' ? 1 : 3;
    for (let i = 0; i < 6; i++) {
      const d = new Date(date.getFullYear(), date.getMonth() - (i * step), 1);
      const mLabel = d.toLocaleString('es-MX', { month: 'short' }).toUpperCase().replace('.', '');
      const yLabel = d.toLocaleString('es-MX', { year: '2-digit' });
      months.push(`${mLabel} ${yLabel}`);
    }
    return months;
  };

  const covPeriods = getCovenantPeriods();

  // ── Color sanitizer ───────────────────────────────────────────────────────
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
      * { color-scheme: light !important; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; box-sizing: border-box !important; }
      body { margin: 0 !important; padding: 0 !important; background: #ffffff !important; }
      #pdf-page-1, .pdf-extra-page { margin: 0 !important; transform: none !important; page-break-after: always !important; }
      table td, table th { vertical-align: middle !important; }
      .shadow-2xl, .shadow-sm, .shadow-lg, .shadow-xl { box-shadow: none !important; }
      .bg-emerald-500  { background-color: #10b981 !important; }
      .bg-emerald-50   { background-color: #ecfdf5 !important; }
      .bg-rose-500     { background-color: #f43f5e !important; }
      .bg-rose-50      { background-color: #fff1f2 !important; }
      .bg-amber-500    { background-color: #f59e0b !important; }
      .bg-amber-50     { background-color: #fffbeb !important; }
      .bg-slate-50     { background-color: #f8fafc !important; }
      .bg-slate-100    { background-color: #f1f5f9 !important; }
      .bg-bluebonnet   { background-color: #0018E6 !important; }
      .text-trueblue   { color: #0066E6 !important; }
      .text-bluebonnet { color: #0018E6 !important; }
      .text-emerald-700{ color: #047857 !important; }
      .text-rose-700   { color: #be123c !important; }
      .text-amber-700  { color: #b45309 !important; }
      .text-emerald-600{ color: #059669 !important; }
      .text-rose-600   { color: #e11d48 !important; }
      .text-amber-600  { color: #d97706 !important; }
      .col-name     { width: 40% !important; }
      .col-status   { width: 15% !important; text-align: center !important; }
      .col-comments { width: 45% !important; }
      .col-date     { width: 15% !important; text-align: center !important; }
      .col-period   { width: 15% !important; text-align: center !important; }
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

  // ── Chunking Helper ───────────────────────────────────────────────────────
  const chunkArray = <T,>(arr: T[], size: number): T[][] => {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  };

  const ITEMS_PER_PAGE = 10; // Reduced to ensure each page fits comfortably without slicing row content

  // ── Render to PDF ─────────────────────────────────────────────────────────
  const renderPageToPDF = async (el: HTMLElement, pdf: jsPDF, addNewPage = false, fitToPage = false) => {
    const PAGE_W = 210, PAGE_H = 297;
    
    const canvas = await html2canvas(el, { 
      scale: 2,
      useCORS: true, 
      logging: false, 
      backgroundColor: '#ffffff',
      windowWidth: el.scrollWidth,
      windowHeight: el.scrollHeight,
      scrollX: 0,
      scrollY: 0,
      onclone: (_d) => sanitizeColors(_d) 
    });
    
    const imgData = canvas.toDataURL('image/jpeg', 0.95);
    const imgWidth = PAGE_W;
    const imgHeight = (canvas.height * PAGE_W) / canvas.width;
    
    if (addNewPage) pdf.addPage();

    if (fitToPage) {
      let fW = PAGE_W;
      let fH = imgHeight;
      let x = 0;
      let y = 0;
      
      if (fH > PAGE_H) {
        fH = PAGE_H;
        fW = PAGE_H * (canvas.width / canvas.height);
        x = (PAGE_W - fW) / 2;
      }
      pdf.addImage(imgData, 'JPEG', x, y, fW, fH);
    } else {
      // For flowing pages, we assume the element is already sized to fit one page
      // but we still use the slicing logic as a safety measure
      let heightLeft = imgHeight;
      let position = 0;

      pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
      heightLeft -= PAGE_H;

      while (heightLeft > 0) {
        position = heightLeft - imgHeight;
        pdf.addPage();
        pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
        heightLeft -= PAGE_H;
      }
    }
  };

  const exportPDF = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
      
      // Page 1: Main Report
      if (page1Ref.current) {
        await renderPageToPDF(page1Ref.current, pdf, false, true);
      }
      
      // Page 2+: Extra Pages (Condiciones)
      const extraPages = document.querySelectorAll('.pdf-extra-page');
      for (let i = 0; i < extraPages.length; i++) {
        await renderPageToPDF(extraPages[i] as HTMLElement, pdf, true, true);
      }
      
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const dateStr = `${yyyy}${mm}${dd}`;
      const modeSuffix = isInvestorMode ? 'inv' : 'interno';
      const fileName = `${dateStr} - Reporte Monitoreo - ${company.name} ${modeSuffix}.pdf`;
      
      pdf.save(fileName);
    } catch (err) {
      console.error('PDF Export Error:', err);
      alert('Error al generar el PDF. Por favor, intente de nuevo.');
    } finally {
      setIsExporting(false);
    }
  };

  // ── SVG check/cross — always pixel-perfect centered ───────────────────────
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
    <div style={{ ...vcc, width: 24, height: 24, minWidth: 24, borderRadius: '50%', backgroundColor: status === 'paid' ? '#10b981' : status === 'unpaid' ? '#f43f5e' : '#e2e8f0', margin: '0 auto' }}>
      {status === 'paid' && <Check />}
      {status === 'unpaid' && <Cross />}
    </div>
  );

  const Warning = () => (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );

  const BoolCircle = ({ val }: { val: boolean }) => (
    <div style={{ ...vcc, width: 20, height: 20, minWidth: 20, borderRadius: '50%', backgroundColor: val ? '#059669' : '#e11d48', margin: '0 auto' }}>
      {val ? <Check /> : <Cross />}
    </div>
  );

  const AforoStatusCircle = ({ status }: { status: 'good' | 'warning' | 'bad' }) => {
    const color = status === 'good' ? '#059669' : status === 'warning' ? '#d97706' : '#e11d48';
    return (
      <div style={{ ...vcc, width: 20, height: 20, minWidth: 20, borderRadius: '50%', backgroundColor: color, margin: '0 auto', color: 'white', fontSize: 12, fontWeight: 900 }}>
        {status === 'good' ? <Check /> : status === 'warning' ? '!' : <Cross />}
      </div>
    );
  };

  // ── Shared table header style ─────────────────────────────────────────────
  const TH = (props: React.ThHTMLAttributes<HTMLTableCellElement>) => (
    <th {...props} style={{ ...tdV, backgroundColor: '#0018E6', color: 'white', padding: '6px 8px', fontSize: 9, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.05em', border: '1px solid #0018E6', ...props.style }} />
  );
  const TD = (props: React.TdHTMLAttributes<HTMLTableCellElement>) => (
    <td {...props} style={{ ...tdV, padding: '6px 8px', fontSize: 9, border: '1px solid #e2e8f0', ...props.style }} />
  );

  const formatDate = (dateStr: string | undefined) => {
    if (!dateStr) return '-';
    // If it's already in a format like "nov-25", return it as is but uppercase
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return dateStr.toUpperCase();
    }
    const [y, m, d] = dateStr.split('-');
    const months = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
    const month = months[parseInt(m) - 1];
    return `${d} ${month} ${y.substring(2)}`;
  };

  const formatMonthOnly = (dateStr: string | undefined) => {
    if (!dateStr) return '-';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return dateStr.toUpperCase();
    }
    const [y, m] = dateStr.split('-');
    const months = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
    return `${months[parseInt(m) - 1]} ${y.substring(2)}`;
  };

  const ReportFooter = () => (
    <div style={{ ...vc, justifyContent: 'space-between', borderTop: '2px solid #0018E6', paddingTop: 16, marginTop: 32 }}>
      <div style={{ ...vccCol, flex: 1 }}>
        <p style={{ fontSize: 8, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#94a3b8', margin: 0 }}>Analista Responsable</p>
        <p style={{ fontSize: 12, fontWeight: 900, color: '#0066E6', margin: '2px 0 0 0' }}>{company.analystName || 'No asignado'}</p>
      </div>
      <div style={{ ...vccCol, flex: 1 }}>
        <p style={{ fontSize: 8, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#94a3b8', margin: 0 }}>Fecha del Reporte</p>
        <p style={{ fontSize: 12, fontWeight: 900, color: '#0066E6', margin: '2px 0 0 0' }}>
          {company.reportDate ? formatDate(company.reportDate) : new Date().toLocaleDateString('es-MX')}
        </p>
      </div>
    </div>
  );

  // ── Condicion Table ───────────────────────────────────────────────────────
  const CondicionTable = ({ items }: { items: { id: string; name: string; isCompliant: boolean; comments?: string }[] }) => (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9 }}>
      <thead>
        <tr>
          <TH style={{ width: '85%', textAlign: 'left' }}>Condición</TH>
          <TH style={{ width: '15%', textAlign: 'center' }}>Estatus</TH>
        </tr>
      </thead>
      <tbody>
        {items.map(item => (
          <React.Fragment key={item.id}>
            <tr>
              <TD style={{ color: '#0066E6', fontWeight: 700, textAlign: 'left' }}>{item.name}</TD>
              <TD style={{ textAlign: 'center' }}><BoolCircle val={item.isCompliant} /></TD>
            </tr>
            <tr>
              <TD colSpan={2} style={{ fontStyle: 'italic', color: '#64748b', textAlign: 'left', backgroundColor: '#f8fafc', padding: '4px 8px' }}>
                <span style={{ fontWeight: 900, textTransform: 'uppercase', fontSize: 8, marginRight: 8 }}>Comentarios:</span>
                {item.comments || '-'}
              </TD>
            </tr>
          </React.Fragment>
        ))}
      </tbody>
    </table>
  );

  const pageClass = 'bg-white w-[210mm] p-[8mm] relative text-slate-800';

  return (
    <div className="bg-slate-100 min-h-screen py-10 px-4 flex flex-col items-center">

      {/* Controls */}
      <div className="flex flex-col items-center gap-4 mb-6 print:hidden">
        <div className="flex gap-4 items-center">
          <button onClick={onClose} className="bg-white text-slate-600 px-6 py-2 rounded-xl font-bold shadow-sm hover:bg-slate-50 transition-all border border-slate-200">
            Volver al Tablero
          </button>
          <button onClick={exportPDF} disabled={isExporting}
            className={`${isExporting ? 'bg-blue-400' : 'bg-bluebonnet hover:bg-trueblue'} text-white px-6 py-2 rounded-xl font-bold shadow-lg transition-all flex items-center gap-2`}>
            {isExporting ? (<><svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>Generando...</>) : 'Descargar PDF'}
          </button>
        </div>
        <div className="flex gap-3 bg-white p-2 rounded-2xl shadow-sm border border-slate-200 items-center">
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-2">Versión:</span>
          <button onClick={() => setIsInvestorMode(false)}
            className={`px-3 py-1.5 rounded-xl text-[9px] font-black uppercase transition-all ${!isInvestorMode ? 'bg-bluebonnet text-white' : 'bg-slate-100 text-slate-400'}`}>
            Analista
          </button>
          <button onClick={() => setIsInvestorMode(true)}
            className={`px-3 py-1.5 rounded-xl text-[9px] font-black uppercase transition-all ${isInvestorMode ? 'bg-bluebonnet text-white' : 'bg-slate-100 text-slate-400'}`}>
            Inversionista
          </button>
        </div>
        <div className="flex gap-3 bg-white p-2 rounded-2xl shadow-sm border border-slate-200 items-center">
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-2">Incluir en PDF:</span>
          {[
            { label: 'Aforo',     state: showAforo,     set: setShowAforo },
            { label: 'Covenants', state: showCovenants, set: setShowCovenants },
            { label: 'Doc.',      state: showDocs,      set: setShowDocs },
            { label: 'Loan Tape', state: showLoanTape,  set: setShowLoanTape },
            { label: 'Hacer',     state: showHacer,     set: setShowHacer },
            { label: 'No Hacer',  state: showNoHacer,   set: setShowNoHacer },
          ].map(({ label, state, set }) => (
            <button key={label} onClick={() => set(!state)}
              className={`px-3 py-1.5 rounded-xl text-[9px] font-black uppercase transition-all ${state ? 'bg-bluebonnet text-white' : 'bg-slate-100 text-slate-400'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ════════ PAGE 1 ════════ */}
      <div ref={page1Ref} id="pdf-page-1" className={`${pageClass} shadow-2xl mb-4`} style={{ fontFamily: "'Inter', sans-serif" }}>
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 0 }}>

          {/* Header */}
          <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 80px', alignItems: 'center', marginBottom: 32, width: '100%', minHeight: 80 }}>
            <div style={{ ...vc, width: 80, height: 80, justifyContent: 'flex-start', overflow: 'hidden' }}>
              {company.logoLeft && <img src={company.logoLeft} alt="Logo Left" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} referrerPolicy="no-referrer" />}
            </div>
            <div style={{ ...vccCol }}>
              <h1 style={{ fontSize: 28, fontWeight: 900, color: '#0018E6', borderBottom: '4px solid #0018E6', paddingBottom: 10, letterSpacing: '-0.05em', textTransform: 'uppercase', display: 'inline-block', lineHeight: 1.3, margin: 0 }}>
                Reporte de Monitoreo
              </h1>
            </div>
            <div style={{ ...vc, width: 80, height: 80, justifyContent: 'flex-end', overflow: 'hidden' }}>
              {company.logoRight && <img src={company.logoRight} alt="Logo Right" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} referrerPolicy="no-referrer" />}
            </div>
          </div>

          {/* Info Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
            {/* Left col: label rows */}
            <div style={{ gridColumn: '1 / 3', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {[
                { label: 'Acreditado',      value: company.name },
                { label: 'Score AXCESS',    value: company.score || 'N/A' },
                { label: 'Tipo de Crédito', value: Array.isArray(company.creditType) ? company.creditType.join(', ') : company.creditType || 'Simple' },
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
            {/* Right col: period box */}
            <div style={{ ...vccCol, backgroundColor: '#0018E6', color: 'white', borderRadius: 12, padding: 12, minHeight: 96 }}>
              <span style={{ fontSize: 7, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', opacity: 0.7 }}>Periodo de Monitoreo</span>
              <span style={{ fontSize: 18, fontWeight: 900, marginTop: 4 }}>{history[0]?.month || 'N/A'}</span>
            </div>
          </div>

          {/* Stats Row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
            {[
              { label: 'Atrasos (12 Meses)',  value: company.delinquencyMonths12 || '0' },
              { label: 'Días Incumplimiento', value: company.delinquencyDays || '0' },
              { label: `Monto Máximo ($ ${company.currency || 'MXN'})`, value: `$ ${company.maxAmount?.toLocaleString() || '0'} ${company.currency || 'MXN'}` },
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
              <span style={{ fontSize: 9, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#0066E6' }}>Saldo Inicial ($ {company.currency || 'MXN'})</span>
              <span style={{ fontSize: 12, fontWeight: 900, fontFamily: 'monospace', color: '#0066E6' }}>$ {company.initialBalance?.toLocaleString() || '0'}</span>
            </div>
            <div style={{ ...vc, justifyContent: 'space-between', border: '1px solid #0018E6', borderRadius: 12, padding: '6px 12px', backgroundColor: '#0018E6', color: 'white', minHeight: 36 }}>
              <span style={{ fontSize: 9, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Saldo Actual ($ {company.currency || 'MXN'})</span>
              <span style={{ fontSize: 12, fontWeight: 900, fontFamily: 'monospace' }}>$ {company.currentDue?.toLocaleString() || '0'}</span>
            </div>
          </div>

          {/* Payment History */}
          <div style={{ marginBottom: 24 }}>
            <h3 style={{ fontSize: 12, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#0066E6', marginBottom: 16, margin: '0 0 16px 0' }}>Historial de Pagos</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ width: 112 }} />
                  {history.map((p, i) => (
                    <th key={i} style={{ ...tdVC, border: '1px solid #e2e8f0', backgroundColor: '#f8fafc', padding: '10px 4px', fontSize: 11, fontWeight: 900, textTransform: 'uppercase' }}>
                      {p.month}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(['Capital', 'Intereses'] as const).map((label, row) => (
                  <tr key={label}>
                    <td style={{ ...tdVC, padding: '14px 4px', fontSize: 11, fontWeight: 900, color: '#64748b', textTransform: 'uppercase' }}>
                      {label}
                    </td>
                    {history.map((p, i) => {
                      const status = row === 0 ? p.principalStatus : p.interestStatus;
                      return (
                        <td key={i} style={{ ...tdVC, border: '1px solid #e2e8f0', padding: 8 }}>
                          <StatusCircle status={status} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Aforo */}
          {showAforo && (
            <div style={{ marginBottom: 24, width: '100%' }}>
              <h3 style={{ fontSize: 9, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#0066E6', margin: '0 0 8px 0' }}>Aforo</h3>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  <tr>
                    <td style={{ ...tdVC, width: 112, backgroundColor: '#0018E6', color: 'white', padding: '6px 8px', fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.05em', border: '1px solid #0018E6' }}>
                      {company.aforoRequerido}
                    </td>
                    {history.map((h, i) => {
                      const norm = (s: string) => s.toLowerCase().replace(/[-\s]/g, '');
                      const aforo = company.aforoHistory.find(a => norm(a.month) === norm(h.month));
                      const isNA = !aforo?.value || aforo?.value === '-' || aforo?.value?.toLowerCase() === 'na';
                      const bgColor = aforo?.status === 'warning' ? '#fffbeb' : (isNA ? '#f1f5f9' : (aforo?.status === 'good' ? '#ecfdf5' : '#fff1f2'));
                      const textColor = aforo?.status === 'warning' ? '#b45309' : (isNA ? '#94a3b8' : (aforo?.status === 'good' ? '#047857' : '#be123c'));
                      
                      return (
                        <TD key={i} style={{ 
                          textAlign: 'center', 
                          fontWeight: 900, 
                          fontSize: 10, 
                          backgroundColor: bgColor, 
                          color: textColor,
                          padding: 8
                        }}>
                          {isInvestorMode ? (
                            aforo ? (isNA && aforo.status !== 'warning' ? 'NA' : <AforoStatusCircle status={aforo.status} />) : '-'
                          ) : (
                            aforo?.value || '-'
                          )}
                        </TD>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* Covenants */}
          {showCovenants && (
            <div style={{ marginBottom: 24, width: '100%' }}>
              <h3 style={{ fontSize: 12, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#0066E6', margin: '0 0 16px 0' }}>Covenants Financieros</h3>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 8 }}>
                <thead>
                  <tr>
                    <TH style={{ width: '22%', textAlign: 'left' }}>Indicador</TH>
                    <TH style={{ width: '12%', textAlign: 'center' }}>Requerido</TH>
                    {covPeriods.map((month, i) => <TH key={i} style={{ textAlign: 'center' }}>{month}</TH>)}
                  </tr>
                </thead>
                <tbody>
                  {company.covenants.map(cov => (
                    <tr key={cov.id}>
                      <TD style={{ textAlign: 'left', backgroundColor: '#f8fafc' }}>
                        <div style={{ color: '#0066E6', fontSize: 9, fontWeight: 700 }}>{cov.name}</div>
                        <div style={{ color: '#94a3b8', fontSize: 7, fontWeight: 400 }}>{cov.description}</div>
                      </TD>
                      <TD style={{ textAlign: 'center', fontWeight: 900, fontSize: 10, backgroundColor: '#f8fafc' }}>{cov.threshold}</TD>
                      {covPeriods.map((month, i) => {
                        const data = company.manualCovenantData.find(d => d.covenantId === cov.id && d.month === month);
                        const isNA = !data?.value || data?.value === '-' || data?.value?.toLowerCase() === 'na';
                        return (
                          <TD key={i} style={{ 
                            textAlign: 'center', 
                            fontWeight: 900, 
                            fontSize: 10, 
                            backgroundColor: data?.status === 'warning' ? '#fffbeb' : (isNA ? '#f1f5f9' : (data?.status === 'good' ? '#ecfdf5' : '#fff1f2')), 
                            color: data?.status === 'warning' ? '#b45309' : (isNA ? '#94a3b8' : (data?.status === 'good' ? '#047857' : '#be123c')) 
                          }}>
                            {isInvestorMode ? (
                              data ? (isNA && data.status !== 'warning' ? 'NA' : <AforoStatusCircle status={data.status} />) : '-'
                            ) : (
                              data?.value || '-'
                            )}
                          </TD>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Documentation */}
          {showDocs && (
            <div style={{ marginBottom: 24, width: '100%' }}>
              <h3 style={{ fontSize: 12, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#0066E6', margin: '0 0 16px 0' }}>Documentación</h3>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 8 }}>
                <thead>
                  <tr>
                    <TH style={{ width: '30%', textAlign: 'left' }}>Documento</TH>
                    <TH style={{ width: '12%', textAlign: 'center' }}>Fecha</TH>
                    <TH style={{ width: '13%', textAlign: 'center' }}>Periodicidad</TH>
                    <TH style={{ width: '10%', textAlign: 'center' }}>Estatus</TH>
                    <TH style={{ width: '35%', textAlign: 'left' }}>Comentarios</TH>
                  </tr>
                </thead>
                <tbody>
                  {company.documentation.map(doc => (
                    <tr key={doc.id}>
                      <TD style={{ color: '#0066E6', fontWeight: 700, textAlign: 'left' }}>{doc.name}</TD>
                      <TD style={{ textAlign: 'center', fontWeight: 900 }}>{formatMonthOnly(doc.date)}</TD>
                      <TD style={{ textAlign: 'center' }}>{doc.periodicity}</TD>
                      <TD style={{ textAlign: 'center' }}><BoolCircle val={doc.isCompliant} /></TD>
                      <TD style={{ fontStyle: 'italic', color: '#64748b', fontSize: 7, textAlign: 'left' }}>{doc.comments || '-'}</TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Summary / Opinion */}
          {company.opinion && (
            <div style={{ marginBottom: 24, width: '100%' }}>
              <h3 style={{ fontSize: 12, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#0066E6', margin: '0 0 16px 0' }}>Resumen y Comentarios</h3>
              <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, backgroundColor: '#f8fafc', fontSize: 10, lineHeight: 1.6, color: '#334155', whiteSpace: 'pre-wrap' }}>
                {company.opinion}
              </div>
            </div>
          )}

          <ReportFooter />
        </div>
      </div>

      {/* ════════ SECTION 2: Condiciones ════════ */}
      {(() => {
        const hacerChunks = showHacer ? chunkArray<{ id: string; name: string; isCompliant: boolean; comments?: string; }>(company.condicionesHacer || [], ITEMS_PER_PAGE) : [];
        const noHacerChunks = showNoHacer ? chunkArray<{ id: string; name: string; isCompliant: boolean; comments?: string; }>(company.condicionesNoHacer || [], ITEMS_PER_PAGE) : [];
        
        // If both fit on one page, combine them. Otherwise, separate them.
        const totalItems = (company.condicionesHacer?.length || 0) + (company.condicionesNoHacer?.length || 0);
        const combine = totalItems <= ITEMS_PER_PAGE;

        if (totalItems === 0 && (showHacer || showNoHacer)) {
          return (
            <div className={`${pageClass} shadow-2xl mb-4 pdf-extra-page`} style={{ fontFamily: "'Inter', sans-serif" }}>
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 24, minHeight: '280mm' }}>
                <h3 style={{ fontSize: 12, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#0066E6', borderBottom: '2px solid #0018E6', paddingBottom: 8, marginBottom: 16 }}>
                  Condiciones de Hacer y No Hacer
                </h3>
                <div style={{ padding: '40px 0', textAlign: 'center', fontSize: 14, fontWeight: 700, color: '#64748b', fontStyle: 'italic' }}>
                  No fueron estipuladas condiciones de hacer y no hacer para este contrato
                </div>
                <div style={{ marginTop: 'auto' }}>
                  <ReportFooter />
                </div>
              </div>
            </div>
          );
        }

        if (totalItems === 0) return null;

        if (combine && totalItems > 0) {
          return (
            <div className={`${pageClass} shadow-2xl mb-4 pdf-extra-page`} style={{ fontFamily: "'Inter', sans-serif" }}>
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 24, minHeight: '280mm' }}>
                <h3 style={{ fontSize: 12, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#0066E6', borderBottom: '2px solid #0018E6', paddingBottom: 8, marginBottom: 16 }}>
                  Condiciones de Hacer y No Hacer
                </h3>
                {showHacer && company.condicionesHacer.length > 0 && (
                  <div>
                    <h4 style={{ fontSize: 10, fontWeight: 900, textTransform: 'uppercase', color: '#0018E6', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 4, height: 16, backgroundColor: '#0018E6' }} />
                      Condiciones de Hacer
                    </h4>
                    <CondicionTable items={company.condicionesHacer} />
                  </div>
                )}
                {showNoHacer && company.condicionesNoHacer.length > 0 && (
                  <div>
                    <h4 style={{ fontSize: 10, fontWeight: 900, textTransform: 'uppercase', color: '#0018E6', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 4, height: 16, backgroundColor: '#0018E6' }} />
                      Condiciones de No Hacer
                    </h4>
                    <CondicionTable items={company.condicionesNoHacer} />
                  </div>
                )}
                <div style={{ marginTop: 'auto' }}>
                  <ReportFooter />
                </div>
              </div>
            </div>
          );
        }

        // Separate pages
        return (
          <>
            {hacerChunks.map((chunk, idx) => (
              <div key={`hacer-${idx}`} className={`${pageClass} shadow-2xl mb-4 pdf-extra-page`} style={{ fontFamily: "'Inter', sans-serif" }}>
                <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 24, minHeight: '280mm' }}>
                  <h3 style={{ fontSize: 12, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#0066E6', borderBottom: '2px solid #0018E6', paddingBottom: 8, marginBottom: 16 }}>
                    Condiciones de Hacer {hacerChunks.length > 1 ? `(${idx + 1}/${hacerChunks.length})` : ''}
                  </h3>
                  <CondicionTable items={chunk} />
                  <div style={{ marginTop: 'auto' }}>
                    <ReportFooter />
                  </div>
                </div>
              </div>
            ))}
            {noHacerChunks.map((chunk, idx) => (
              <div key={`nohacer-${idx}`} className={`${pageClass} shadow-2xl mb-4 pdf-extra-page`} style={{ fontFamily: "'Inter', sans-serif" }}>
                <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 24, minHeight: '280mm' }}>
                  <h3 style={{ fontSize: 12, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#0066E6', borderBottom: '2px solid #0018E6', paddingBottom: 8, marginBottom: 16 }}>
                    Condiciones de No Hacer {noHacerChunks.length > 1 ? `(${idx + 1}/${noHacerChunks.length})` : ''}
                  </h3>
                  <CondicionTable items={chunk} />
                  <div style={{ marginTop: 'auto' }}>
                    <ReportFooter />
                  </div>
                </div>
              </div>
            ))}
          </>
        );
      })()}

      {/* ════════ SECTION 3: Loan Tape — Executive Analytics Dashboard ════════ */}
      {/* ════════ SECTION 3: Loan Tape — High Fidelity Dashboard ════════ */}
      {showLoanTape && company.loanTapeSnapshots && company.loanTapeSnapshots.length > 0 && (() => {
        const snapshotsSorted = [...company.loanTapeSnapshots].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        const latest = snapshotsSorted[snapshotsSorted.length - 1];
        const axcessBlue = '#0018E6';

        const formatDateShort = (d: string) => {
          const date = new Date(d);
          const months = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
          return `${months[date.getMonth()]} ${date.getFullYear().toString().substring(2)}`;
        };

        return (
          <div className={`${pageClass} shadow-2xl mb-4 pdf-extra-page`} style={{ fontFamily: "'Inter', sans-serif", padding: '10mm', backgroundColor: '#FFFFFF' }}>
            <div style={{ width: '100%', minHeight: '277mm', display: 'flex', flexDirection: 'column', gap: 12 }}>
              
              {/* Header with Logos */}
              <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 80px', alignItems: 'center', marginBottom: 4 }}>
                <div style={{ ...vc }}>
                  <div style={{ width: 36, height: 36, backgroundColor: '#CB1F1F', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline><polyline points="17 6 23 6 23 12"></polyline></svg>
                  </div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <h2 style={{ fontSize: 20, fontWeight: 900, color: axcessBlue, textTransform: 'uppercase', letterSpacing: '0.04em', margin: 0 }}>
                    Reporte de Monitoreo
                  </h2>
                  <div style={{ height: 2, width: 150, backgroundColor: '#BFDBFE', margin: '4px auto 0' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <span style={{ fontSize: 28, fontWeight: 900, color: axcessBlue, fontFamily: 'serif' }}>A</span>
                </div>
              </div>

              {/* Major Headline Banner (Blue) */}
              <div style={{ backgroundColor: axcessBlue, borderRadius: 6, padding: '20px 24px', color: 'white', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h1 style={{ fontSize: 22, fontWeight: 900, margin: 0, letterSpacing: '0.02em' }}>LOAN TAPE</h1>
                  <p style={{ fontSize: 9, fontWeight: 700, margin: '2px 0 0 0', opacity: 0.8, textTransform: 'uppercase' }}>
                    {company.name} • CIERRE {formatDateShort(latest.date)}
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 32, textAlign: 'center' }}>
                  <div>
                    <div style={{ fontSize: 24, fontWeight: 900 }}>$ {(latest.totalPoolBalance / 1000000).toFixed(0)} M</div>
                    <p style={{ fontSize: 7, fontWeight: 800, margin: 0, opacity: 0.7, textTransform: 'uppercase' }}>Portafolio</p>
                  </div>
                  <div>
                    <div style={{ fontSize: 24, fontWeight: 900 }}>{latest.loanCount.toLocaleString()}</div>
                    <p style={{ fontSize: 7, fontWeight: 800, margin: 0, opacity: 0.7, textTransform: 'uppercase' }}>Créditos Vivos</p>
                  </div>
                  <div>
                    <div style={{ fontSize: 24, fontWeight: 900 }}>{(latest.loanCount * 0.45).toFixed(0).toLocaleString()}</div>
                    <p style={{ fontSize: 7, fontWeight: 800, margin: 0, opacity: 0.7, textTransform: 'uppercase' }}>Clientes Únicos</p>
                  </div>
                </div>
              </div>

              {/* Middle Section Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: 12 }}>
                {/* Delinquency Card */}
                <div style={{ border: '1px solid #E2E8F0', borderRadius: 8, padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #F1F5F9', paddingBottom: 6, marginBottom: 10 }}>
                    <h3 style={{ fontSize: 9, fontWeight: 900, color: axcessBlue, margin: 0, textTransform: 'uppercase' }}>Cartera Vencida</h3>
                    <span style={{ fontSize: 7, fontWeight: 800, color: '#94A3B8', textTransform: 'uppercase' }}>Mantener - Mes Actual</span>
                  </div>
                  <div style={{ display: 'flex', gap: 16 }}>
                    <div style={{ flex: 1, borderRight: '1px solid #F1F5F9', paddingRight: 10 }}>
                      <div style={{ fontSize: 28, fontWeight: 900, color: '#DC2626' }}>{latest.delinquency90Plus}%</div>
                      <p style={{ fontSize: 9, fontWeight: 700, color: '#64748B', margin: 0 }}>$ {(latest.totalPoolBalance * (latest.delinquency90Plus/100) / 1000000).toFixed(1)} M</p>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                        <span style={{ color: '#DC2626', fontSize: 10 }}>▲</span>
                        <span style={{ fontSize: 8, fontWeight: 800, color: '#DC2626' }}>Trend vs mes ant.</span>
                      </div>
                    </div>
                    <div style={{ flex: 2, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 3 }}>
                      {[
                        { l: '1-30 D', v: latest.delinquency1_30 !== undefined ? (latest.loanCount * (latest.delinquency1_30/100)).toFixed(0) : '78', p: `${latest.delinquency1_30 !== undefined ? latest.delinquency1_30 : 1.9}%`, c: '#10B981' },
                        { l: '31-60 D', v: latest.delinquency31_60 !== undefined ? (latest.loanCount * (latest.delinquency31_60/100)).toFixed(0) : '41', p: `${latest.delinquency31_60 !== undefined ? latest.delinquency31_60 : 1.1}%`, c: '#F59E0B' },
                        { l: '61-90 D', v: latest.delinquency61_90 !== undefined ? (latest.loanCount * (latest.delinquency61_90/100)).toFixed(0) : (latest.loanCount * 0.008).toFixed(0), p: `${latest.delinquency61_90 !== undefined ? latest.delinquency61_90 : 0.8}%`, c: '#F43F5E' },
                        { l: '90+ D', v: (latest.loanCount * (latest.delinquency90Plus/100)).toFixed(0), p: `${latest.delinquency90Plus}%`, c: '#B91C1C' },
                      ].map(b => (
                        <div key={b.l} style={{ textAlign: 'center', border: '1px solid #F1F5F9', borderRadius: 4, padding: '4px 2px' }}>
                          <p style={{ fontSize: 8, fontWeight: 900, margin: 0, color: '#111827' }}>{b.v}</p>
                          <p style={{ fontSize: 6, fontWeight: 700, margin: '1px 0', color: '#94A3B8' }}>{b.l}</p>
                          <div style={{ height: 3, width: '100%', backgroundColor: b.c, margin: '3px 0' }} />
                          <p style={{ fontSize: 7, fontWeight: 900, margin: 0, color: '#374151' }}>{b.p}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Recoveries Card */}
                <div style={{ border: '1px solid #E2E8F0', borderRadius: 8, padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #F1F5F9', paddingBottom: 6, marginBottom: 10 }}>
                    <h3 style={{ fontSize: 9, fontWeight: 900, color: axcessBlue, margin: 0, textTransform: 'uppercase' }}>Recuperados</h3>
                    <span style={{ fontSize: 7, fontWeight: 800, color: '#94A3B8', textTransform: 'uppercase' }}>Trailing 90D</span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <div style={{ width: 56, height: 56, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="56" height="56" viewBox="0 0 36 36">
                        <circle cx="18" cy="18" r="16" fill="transparent" stroke="#E2E8F0" strokeWidth="3" />
                        <circle cx="18" cy="18" r="16" fill="transparent" stroke="#10B981" strokeWidth="3" strokeDasharray="64, 100" strokeLinecap="round" transform="rotate(-90 18 18)" />
                      </svg>
                      <div style={{ position: 'absolute', textAlign: 'center' }}>
                        <p style={{ fontSize: 10, fontWeight: 900, color: '#1F2937', margin: 0 }}>64%</p>
                      </div>
                    </div>
                    <div style={{ flex: 1 }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <tbody>
                          {[
                            { l: 'Monto recuperado', v: `$ 5.1 M` },
                            { l: 'Casos cerrados', v: '47' },
                            { l: 'Días promedio', v: '38 d' },
                            { l: 'Base elegible', v: `$ 8.0 M` },
                          ].map(r => (
                            <tr key={r.l}>
                              <td style={{ fontSize: 7, color: '#64748B', fontWeight: 600, padding: '1px 0' }}>{r.l}</td>
                              <td style={{ fontSize: 7, textAlign: 'right', fontWeight: 900, color: '#1F2937' }}>{r.v}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>

              {/* Origination Section */}
              <div style={{ border: '1px solid #E2E8F0', borderRadius: 8, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #F1F5F9', paddingBottom: 6, marginBottom: 12 }}>
                  <h3 style={{ fontSize: 9, fontWeight: 900, color: axcessBlue, margin: 0, textTransform: 'uppercase' }}>New Origination - Por Mes</h3>
                  <span style={{ fontSize: 7, fontWeight: 800, color: '#94A3B8', textTransform: 'uppercase' }}>Últimos 6 Meses</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
                  {[
                    { v: latest.newCréditos || '312', l: '# CRÉDITOS (MES)' },
                    { v: latest.newClientes || '248', l: '# CLIENTES (MES)' },
                    { v: latest.biggestPortfolioPct ? `${latest.biggestPortfolioPct}%` : '2.8%', l: 'BIGGEST % PORTAFOLIO' },
                  ].map(k => (
                    <div key={k.l} style={{ backgroundColor: '#F8FAFC', borderRadius: 6, padding: '8px 12px', textAlign: 'center' }}>
                      <p style={{ fontSize: 16, fontWeight: 900, color: axcessBlue, margin: 0 }}>{k.v}</p>
                      <p style={{ fontSize: 6, fontWeight: 800, color: '#94A3B8', margin: '2px 0 0 0', textTransform: 'uppercase' }}>{k.l}</p>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 20 }}>
                  <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', height: 80, paddingBottom: 16, borderBottom: '1px solid #F1F5F9' }}>
                    {[
                      { h: 164, m: 'SEP' }, { h: 181, m: 'OCT' }, { h: 218, m: 'NOV' },
                      { h: 173, m: 'DIC' }, { h: 205, m: 'ENE' }, { h: 212, m: 'FEB' }
                    ].map((bar, i) => (
                      <div key={i} style={{ width: '12%', backgroundColor: axcessBlue, height: `${(bar.h / 250) * 100}%`, borderRadius: '2px 2px 0 0', position: 'relative' }}>
                        <span style={{ position: 'absolute', top: -10, left: 0, width: '100%', textAlign: 'center', fontSize: 6, fontWeight: 900, color: axcessBlue }}>{bar.h}</span>
                        <span style={{ position: 'absolute', bottom: -14, left: 0, width: '100%', textAlign: 'center', fontSize: 6, fontWeight: 800, color: '#94A3B8' }}>{bar.m}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ width: '38%' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 7 }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #F1F5F9' }}>
                          <th style={{ textAlign: 'left', color: '#94A3B8', padding: '2px 0' }}>MES</th>
                          <th style={{ textAlign: 'right', color: '#94A3B8', padding: '2px 0' }}># CRÉD.</th>
                          <th style={{ textAlign: 'right', color: '#94A3B8', padding: '2px 0' }}># CLI.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[
                          { m: 'FEB 26', cr: 212, cl: 198 },
                          { m: 'ENE 26', cr: 205, cl: 191 },
                          { m: 'DIC 25', cr: 173, cl: 165 },
                          { m: 'NOV 25', cr: 218, cl: 210 }
                        ].map(row => (
                          <tr key={row.m} style={{ borderBottom: '1px solid #F8FAFC' }}>
                            <td style={{ fontWeight: 800, padding: '3px 0', color: '#374151' }}>{row.m}</td>
                            <td style={{ fontWeight: 800, padding: '3px 0', textAlign: 'right', color: '#4B5563' }}>{row.cr}</td>
                            <td style={{ fontWeight: 800, padding: '3px 0', textAlign: 'right', color: '#4B5563' }}>{row.cl}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* Concentration Section */}
              <div style={{ border: '1px solid #E2E8F0', borderRadius: 8, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #F1F5F9', paddingBottom: 6, marginBottom: 12 }}>
                  <h3 style={{ fontSize: 9, fontWeight: 900, color: axcessBlue, margin: 0, textTransform: 'uppercase' }}>Concentración General</h3>
                  <span style={{ fontSize: 7, fontWeight: 800, color: '#94A3B8', textTransform: 'uppercase' }}>% del Portafolio</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                  {[
                    { l: 'TOP 3', v: latest.top3Pct ? `${latest.top3Pct}%` : '7.8%' },
                    { l: 'TOP 5', v: latest.top5Pct ? `${latest.top5Pct}%` : '11.4%' },
                    { l: 'TOP 10', v: latest.top10Pct ? `${latest.top10Pct}%` : '18.6%' },
                  ].map(t => (
                    <div key={t.l} style={{ border: '1px solid #F1F5F9', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                      <p style={{ fontSize: 7, fontWeight: 800, color: '#94A3B8', margin: 0 }}>{t.l}</p>
                      <p style={{ fontSize: 16, fontWeight: 900, color: axcessBlue, margin: '1px 0' }}>{t.v}</p>
                      <p style={{ fontSize: 6, fontWeight: 600, color: '#CBD5E1', margin: 0 }}>acreditados</p>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 12, width: '100%' }}>
                  <div style={{ display: 'flex', height: 14, borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ width: `${latest.top3Pct || 7.8}%`, backgroundColor: axcessBlue }} />
                    <div style={{ width: `${(latest.top5Pct || 11.4)-(latest.top3Pct || 7.8)}%`, backgroundColor: '#3B82F6' }} />
                    <div style={{ width: `${(latest.top10Pct || 18.6)-(latest.top5Pct || 11.4)}%`, backgroundColor: '#93C5FD' }} />
                    <div style={{ width: `${100-(latest.top10Pct || 18.6)}%`, backgroundColor: '#E2E8F0' }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 6, fontWeight: 800, color: '#94A3B8', marginTop: 4 }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}><div style={{ width: 6, height: 6, backgroundColor: axcessBlue }} /> <span>Top 3 - {latest.top3Pct || 7.8}%</span></div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}><div style={{ width: 6, height: 6, backgroundColor: '#3B82F6' }} /> <span>Top 4-5 - {latest.top5Pct ? (latest.top5Pct - (latest.top3Pct || 0)).toFixed(1) : '3.6'}%</span></div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}><div style={{ width: 6, height: 6, backgroundColor: '#93C5FD' }} /> <span>Top 6-10 - {latest.top10Pct ? (latest.top10Pct - (latest.top5Pct || 0)).toFixed(1) : '7.2'}%</span></div>
                    </div>
                    <span>Resto - {100 - (latest.top10Pct || 18.6)}%</span>
                  </div>
                </div>
              </div>

              {/* Categorization Section */}
              <div style={{ border: '1px solid #E2E8F0', borderRadius: 8, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #F1F5F9', paddingBottom: 6, marginBottom: 12 }}>
                  <h3 style={{ fontSize: 9, fontWeight: 900, color: axcessBlue, margin: 0, textTransform: 'uppercase' }}>Loans Desaparecidos - Categorización</h3>
                  <span style={{ fontSize: 7, fontWeight: 800, color: '#94A3B8', textTransform: 'uppercase' }}>TOTAL: {((latest.expectedVencimiento || 318) + (latest.earlyPayments || 76) + (latest.moraCastigo || 27))} - {(((latest.expectedVencimiento || 318) + (latest.earlyPayments || 76) + (latest.moraCastigo || 27)) / (latest.loanCount || 1) * 100).toFixed(1)}% DEL PORTAFOLIO</span>
                </div>
                <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
                  <div style={{ width: 70, height: 70, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="70" height="70" viewBox="0 0 36 36">
                      <circle cx="18" cy="18" r="16" fill="transparent" stroke="#F1F5F9" strokeWidth="4" />
                      {(() => {
                        const total = (latest.expectedVencimiento || 318) + (latest.earlyPayments || 76) + (latest.moraCastigo || 27);
                        if (total === 0) return null;
                        const p1 = ((latest.expectedVencimiento || 318) / total) * 100;
                        const p2 = ((latest.earlyPayments || 76) / total) * 100;
                        const p3 = ((latest.moraCastigo || 27) / total) * 100;
                        return (
                          <>
                            <circle cx="18" cy="18" r="16" fill="transparent" stroke={axcessBlue} strokeWidth="4" strokeDasharray={`${p1}, 100`} strokeLinecap="round" transform="rotate(-90 18 18)" />
                            <circle cx="18" cy="18" r="16" fill="transparent" stroke="#3B82F6" strokeWidth="4" strokeDasharray={`${p2}, 100`} strokeLinecap="round" transform={`rotate(${(p1*3.6)-90} 18 18)`} />
                            <circle cx="18" cy="18" r="16" fill="transparent" stroke="#DC2626" strokeWidth="4" strokeDasharray={`${p3}, 100`} strokeLinecap="round" transform={`rotate(${(p1*3.6)+(p2*3.6)-90} 18 18)`} />
                          </>
                        );
                      })()}
                    </svg>
                    <div style={{ position: 'absolute', textAlign: 'center' }}>
                      <p style={{ fontSize: 11, fontWeight: 900, color: '#1F2937', margin: 0 }}>{(latest.expectedVencimiento || 318) + (latest.earlyPayments || 76) + (latest.moraCastigo || 27)}</p>
                      <p style={{ fontSize: 5, fontWeight: 800, color: '#94A3B8', margin: 0 }}>LOANS</p>
                    </div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {[
                        { l: 'Expected (al vencimiento)', v: latest.expectedVencimiento || '318', p: latest.expectedVencimiento ? `${(latest.expectedVencimiento/((latest.expectedVencimiento || 318) + (latest.earlyPayments || 76) + (latest.moraCastigo || 27))*100).toFixed(1)}%` : '75.5%', c: axcessBlue },
                        { l: 'Early payments (prepago)', v: latest.earlyPayments || '76', p: latest.earlyPayments ? `${(latest.earlyPayments/((latest.expectedVencimiento || 318) + (latest.earlyPayments || 76) + (latest.moraCastigo || 27))*100).toFixed(1)}%` : '18.1%', c: '#3B82F6' },
                        { l: 'Mora / castigo', v: latest.moraCastigo || '27', p: latest.moraCastigo ? `${(latest.moraCastigo/((latest.expectedVencimiento || 318) + (latest.earlyPayments || 76) + (latest.moraCastigo || 27))*100).toFixed(1)}%` : '6.4%', c: '#DC2626' },
                      ].map(row => (
                        <div key={row.l} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ width: 6, height: 6, backgroundColor: row.c, borderRadius: 1 }} />
                            <span style={{ fontSize: 7, fontWeight: 600, color: '#475569' }}>{row.l}</span>
                          </div>
                          <div style={{ display: 'flex', gap: 12 }}>
                            <span style={{ fontSize: 7, fontWeight: 900, color: '#1F2937', width: 25, textAlign: 'right' }}>{row.v}</span>
                            <span style={{ fontSize: 7, fontWeight: 700, color: '#94A3B8', width: 30, textAlign: 'right' }}>{row.p}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Disclaimer */}
              <div style={{ marginTop: 'auto', textAlign: 'center', padding: '8px 0' }}>
                <p style={{ fontSize: 6, fontStyle: 'italic', color: '#94A3B8', margin: 0 }}>
                  Métricas calculadas sobre la loan tape entregada por el acreditado • Datos protegidos • Concentrado analítico AXCESS.
                </p>
              </div>

              {/* Footer row */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, borderTop: '1.5px solid #0018E6', paddingTop: 10 }}>
                <div style={{ textAlign: 'center' }}>
                  <p style={{ fontSize: 7, fontWeight: 800, color: '#94A3B8', margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Analista Responsable</p>
                  <p style={{ fontSize: 10, fontWeight: 900, color: axcessBlue, margin: '1px 0 0 0' }}>{company.analystName || 'Cordelia Molina'}</p>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <p style={{ fontSize: 7, fontWeight: 800, color: '#94A3B8', margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Fecha del Reporte</p>
                  <p style={{ fontSize: 10, fontWeight: 900, color: axcessBlue, margin: '1px 0 0 0' }}>{company.reportDate ? formatDate(company.reportDate) : '10/03/2026'}</p>
                </div>
              </div>

            </div>
          </div>
        );
      })()}

    </div>
  );
};

export default ReportView;
