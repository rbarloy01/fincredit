import React, { useEffect, useMemo, useState } from 'react';
import {
  Upload, Trash2, Plus, Landmark, Pencil, X, Download, AlertTriangle, Check,
} from 'lucide-react';
import { db, InstitutionalLiability_DB, LoanTape_DB } from '../../db/index';
import {
  analyzeLiabilities,
  formatMoney, formatPercent, parseLiabilitiesRows, LIABILITY_TYPE_LABELS, buildLiabilitiesInsights,
  type ParsedLiabilityRow,
} from '../../lib/institutionalLiabilitiesAnalytics';
import { analyzeAssetLiability } from '../../lib/assetLiabilityAnalysis';
import { buildCockpitData } from '../../lib/loanTapeCockpit';
import { analyzePortfolio } from '../../lib/loanTapeReport';
import { reserveDownloadTarget } from '../../lib/browserDownload';
import LiabilitiesCockpit from './LiabilitiesCockpit';
import LiabilityHistoryPanel from './LiabilityHistoryPanel';
import type { LiabilityLine } from '../../lib/liabilityHistory';
import { loadExportModule } from '../../lib/exportLoader';
import WorkingOverlay from '../common/WorkingOverlay';
import { type AISettings, extractInstitutionalLiabilities } from '../../services/ai';
import { extractPdfLines, extractPdfText, isUsefulExtractedText, renderPdfPreviewImages } from '../../lib/documentParsing';
import { linesFromRows, linesFromText, parseLiabilityBreakdown, screenAiLiabilityRows, type LiabilityParseResult } from '../../lib/liabilityRules';
import { loadLiabilityHistory, saveLiabilityHistory, upsertSnapshot } from '../../lib/liabilityHistory';
import { sheetToRows } from '../../lib/sheetRows';

interface Props {
  clientId: string;
  clientName?: string;
  aiSettings: AISettings;
  loanTapes?: LoanTape_DB[];
  onLiabilitiesChange?: (liabilities: InstitutionalLiability_DB[]) => void;
}


type FormState = {
  lenderName: string;
  liabilityType: InstitutionalLiability_DB['liabilityType'];
  originalAmount: string;
  currentBalance: string;
  currency: string;
  interestRate: string;
  rateDescription: string;
  originationDate: string;
  maturityDate: string;
  amortization: string;
  guarantee: string;
  notes: string;
};

const EMPTY_FORM: FormState = {
  lenderName: '', liabilityType: 'linea_credito', originalAmount: '', currentBalance: '',
  currency: 'MXN', interestRate: '', rateDescription: '', originationDate: '', maturityDate: '',
  amortization: '', guarantee: '', notes: '',
};

const ACCEPTED_FILES = '.pdf,.xlsx,.xls,.csv';

function normalizeKeyPart(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function moneyKey(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return String(Math.round(value * 100) / 100);
}

function sourceKey(sourceDocumentId?: string, fileName?: string) {
  return sourceDocumentId || normalizeKeyPart(fileName);
}

function liabilityDedupeKey(row: Partial<InstitutionalLiability_DB> & ParsedLiabilityRow, sourceDocumentId?: string, fileName?: string) {
  return [
    normalizeKeyPart(row.lenderName),
    row.liabilityType || 'otro',
    normalizeKeyPart(row.currency || 'MXN'),
    moneyKey(row.originalAmount),
    moneyKey(row.currentBalance),
    row.maturityDate || '',
    sourceKey(sourceDocumentId || row.sourceDocumentId, fileName),
  ].join('|');
}

function liabilityFacilityKey(row: Partial<InstitutionalLiability_DB> & ParsedLiabilityRow) {
  return [
    normalizeKeyPart(row.lenderName),
    row.liabilityType || 'otro',
    normalizeKeyPart(row.currency || 'MXN'),
    moneyKey(row.originalAmount),
    moneyKey(row.currentBalance),
    row.maturityDate || '',
  ].join('|');
}

function mergeLiabilityUpdates(existing: InstitutionalLiability_DB, row: ParsedLiabilityRow, sourceDocumentId?: string, fileName?: string): Partial<InstitutionalLiability_DB> {
  const notes = Array.from(new Set([existing.notes, row.notes, fileName ? `Fuente: ${fileName}` : ''].filter(Boolean).flatMap(item => String(item).split('|').map(part => part.trim()).filter(Boolean)))).join(' | ');
  return {
    sourceDocumentId: existing.sourceDocumentId || sourceDocumentId,
    lenderName: existing.lenderName || row.lenderName,
    liabilityType: existing.liabilityType || row.liabilityType,
    originalAmount: existing.originalAmount ?? row.originalAmount,
    currentBalance: existing.currentBalance ?? row.currentBalance,
    currency: existing.currency || row.currency,
    interestRate: existing.interestRate ?? row.interestRate,
    rateDescription: existing.rateDescription || row.rateDescription,
    originationDate: existing.originationDate || row.originationDate,
    maturityDate: existing.maturityDate || row.maturityDate,
    amortization: existing.amortization || row.amortization,
    guarantee: existing.guarantee || row.guarantee,
    notes: notes || undefined,
  };
}

function toForm(l: InstitutionalLiability_DB): FormState {
  return {
    lenderName: l.lenderName,
    liabilityType: l.liabilityType,
    originalAmount: l.originalAmount === null ? '' : String(l.originalAmount),
    currentBalance: l.currentBalance === null ? '' : String(l.currentBalance),
    currency: l.currency,
    interestRate: l.interestRate === null ? '' : String(l.interestRate * 100),
    rateDescription: l.rateDescription || '',
    originationDate: l.originationDate || '',
    maturityDate: l.maturityDate || '',
    amortization: l.amortization || '',
    guarantee: l.guarantee || '',
    notes: l.notes || '',
  };
}

function fromForm(clientId: string, form: FormState): Omit<InstitutionalLiability_DB, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    clientId,
    lenderName: form.lenderName.trim(),
    liabilityType: form.liabilityType,
    originalAmount: form.originalAmount === '' ? null : Number(form.originalAmount),
    currentBalance: form.currentBalance === '' ? null : Number(form.currentBalance),
    currency: form.currency.trim().toUpperCase() || 'MXN',
    interestRate: form.interestRate === '' ? null : Number(form.interestRate) / 100,
    rateDescription: form.rateDescription.trim() || undefined,
    originationDate: form.originationDate || undefined,
    maturityDate: form.maturityDate || undefined,
    amortization: form.amortization.trim() || undefined,
    guarantee: form.guarantee.trim() || undefined,
    notes: form.notes.trim() || undefined,
  };
}

const InstitutionalLiabilitiesPanel: React.FC<Props> = ({ clientId, clientName, aiSettings, loanTapes = [], onLiabilitiesChange }) => {
  const [liabilities, setLiabilities] = useState<InstitutionalLiability_DB[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<string | null>(null);
  const [schemaReady, setSchemaReady] = useState<boolean | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [rows, ready] = await Promise.all([
        db.getInstitutionalLiabilities(clientId),
        db.checkInstitutionalLiabilitiesSchema(),
      ]);
      setLiabilities(rows);
      setSchemaReady(ready);
      onLiabilitiesChange?.(rows);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [clientId]);

  const analysis = useMemo(() => analyzeLiabilities(liabilities), [liabilities]);
  const insights = useMemo(() => buildLiabilitiesInsights(liabilities), [liabilities]);
  // Activo vs. pasivo: último corte del loan tape contra el fondeo institucional.
  const assetLiability = useMemo(() => {
    const tapes = loanTapes.filter(t => Array.isArray(t.extractedData?._standardized));
    if (!tapes.length || !liabilities.length) return null;
    try {
      const data = buildCockpitData(tapes);
      const portfolio = data.periods.length ? analyzePortfolio(data, data.periods[data.periods.length - 1]) : null;
      return analyzeAssetLiability(portfolio, analysis);
    } catch {
      return null;
    }
  }, [loanTapes, liabilities, analysis]);

  const openNew = () => { setEditingId(null); setForm(EMPTY_FORM); setModalOpen(true); };
  const openEdit = (l: InstitutionalLiability_DB) => { setEditingId(l.id); setForm(toForm(l)); setModalOpen(true); };

  const handleSave = async () => {
    if (!form.lenderName.trim()) { alert('El acreedor / institución es obligatorio.'); return; }
    if (schemaReady === false) { setModalOpen(false); return; }
    setBusy(editingId ? 'Guardando cambios...' : 'Agregando pasivo...');
    try {
      if (editingId) {
        await db.updateInstitutionalLiability(editingId, fromForm(clientId, form));
      } else {
        await db.createInstitutionalLiability(fromForm(clientId, form));
      }
      setModalOpen(false);
      await load();
    } catch (e: any) {
      alert(`Error al guardar: ${e?.message || e}`);
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar este pasivo institucional?')) return;
    setBusy('Eliminando...');
    try {
      await db.deleteInstitutionalLiability(id);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const readSpreadsheetRows = async (file: File): Promise<{ parsed: ParsedLiabilityRow[]; unmatchedFields: string[] }> => {
    const buffer = await file.arrayBuffer();
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    const parsed: ParsedLiabilityRow[] = [];
    const unmatched = new Set<string>();
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = sheetToRows<Record<string, unknown>>(XLSX, sheet, { defval: null });
      const result = parseLiabilitiesRows(rows);
      result.parsed.forEach(row => parsed.push({
        ...row,
        notes: [row.notes, workbook.SheetNames.length > 1 ? `Hoja: ${sheetName}` : ''].filter(Boolean).join(' | ') || undefined,
      }));
      result.unmatchedFields.forEach(field => unmatched.add(field));
    }
    return { parsed, unmatchedFields: Array.from(unmatched) };
  };

  const readPdfRows = async (file: File): Promise<ParsedLiabilityRow[]> => {
    const text = await extractPdfText(file);
    const usefulText = isUsefulExtractedText(text);
    const media = usefulText ? undefined : (await renderPdfPreviewImages(file, 12, 0.9, 0.45)).map((base64, index) => ({
      base64,
      mimeType: 'image/jpeg',
      fileName: `${file.name} pagina ${index + 1}`,
    }));
    if (!usefulText && !media?.length) {
      throw new Error(`${file.name}: no pude leer texto ni renderizar páginas del PDF.`);
    }
    const rows = await extractInstitutionalLiabilities(
      aiSettings,
      { text: usefulText ? text : '', media },
      clientName,
      file.name,
    );
    return rows.map(row => ({
      ...row,
      notes: [row.notes, `Fuente: ${file.name}`].filter(Boolean).join(' | ') || undefined,
    }));
  };

  const extractRowsFromFile = async (file: File): Promise<{ parsed: ParsedLiabilityRow[]; unmatchedFields: string[] }> => {
    const name = file.name.toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')) {
      return readSpreadsheetRows(file);
    }
    if (name.endsWith('.pdf') || file.type === 'application/pdf') {
      return { parsed: await readPdfRows(file), unmatchedFields: [] };
    }
    throw new Error(`${file.name}: solo se aceptan PDF, Excel (.xlsx, .xls) o CSV.`);
  };

  const [historyKey, setHistoryKey] = useState(0);

  // Reglas de negocio (sin IA): si el archivo es un desglose del pasivo, se entiende completo — unidad, corte, jerarquía,
  // fondeadores y cuadre — y alimenta el historial mensual y los saldos por fondeador.
  const tryBreakdown = async (file: File): Promise<LiabilityParseResult | null> => {
    const name = file.name.toLowerCase();
    let text = ''; let raw: ReturnType<typeof linesFromText> = [];
    if (name.endsWith('.pdf') || file.type === 'application/pdf') {
      text = await extractPdfLines(file);
      raw = linesFromText(text);
    } else if (/\.(xlsx|xls|csv)$/.test(name)) {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
      const rows = wb.SheetNames.flatMap(n => sheetToRows<any[]>(XLSX, wb.Sheets[n], { header: 1, blankrows: false, defval: null }));
      text = rows.map(r => (r || []).join(' ')).join('\n');
      raw = linesFromRows(rows);
    }
    if (raw.length < 3) return null;
    const res = parseLiabilityBreakdown(raw, { text, fileName: file.name });
    return res.recognized ? res : null;
  };

  const typeFor = (lender: string): InstitutionalLiability_DB['liabilityType'] =>
    /bursatil|certificado|obligacion|emision/.test(normalizeKeyPart(lender)) ? 'bono' : /prestamo|credito simple|mutuo|pagare/.test(normalizeKeyPart(lender)) ? 'prestamo_simple' : 'linea_credito';

  const applyBreakdown = async (res: LiabilityParseResult, file: File): Promise<string> => {
    let store = await loadLiabilityHistory(clientId);
    const periods = [...res.periods].sort((a, b) => String(a.cutoff).localeCompare(String(b.cutoff)));
    for (const p of periods) {
      let cutoff = p.cutoff;
      if (!cutoff) cutoff = window.prompt(`${file.name}: no encontré la fecha de corte. Escríbela (AAAA-MM-DD):`) || null;
      if (!cutoff || !/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) throw new Error(`${file.name}: sin fecha de corte válida.`);
      p.cutoff = cutoff;
      store = upsertSnapshot(store, { cutoff, source: file.name, lines: p.funding.map(f => ({ lender: f.lender, term: f.term, balance: f.balance })), totalLiabilities: p.totalLiabilities, composition: p.composition, createdAt: new Date().toISOString() });
    }
    await saveLiabilityHistory(clientId, store);
    // Saldos por fondeador = corte más reciente del historial (solo si este archivo trae ese corte).
    const latest = store.snapshots.at(-1)!;
    const mine = periods.find(p => p.cutoff === latest.cutoff);
    let created = 0, updated = 0;
    if (mine) {
      for (const f of mine.funding) {
        const hit = liabilities.find(l => normalizeKeyPart(l.lenderName) === normalizeKeyPart(f.lender));
        const note = `${f.term === 'corto' ? 'Corto plazo' : f.term === 'largo' ? 'Largo plazo' : 'Plazo no indicado'} · saldo al ${mine.cutoff} desde ${file.name}`;
        if (hit) { await db.updateInstitutionalLiability(hit.id, { currentBalance: f.balance, notes: [hit.notes, note].filter(Boolean).join('\n') }); updated += 1; }
        else { await db.createInstitutionalLiability({ clientId, lenderName: f.lender, liabilityType: typeFor(f.lender), originalAmount: null, currentBalance: f.balance, currency: 'MXN', interestRate: null, notes: note }); created += 1; }
      }
    }
    const m = (v: number) => `$${(v / 1e6).toLocaleString('es-MX', { maximumFractionDigits: 2 })}M`;
    const p = periods.at(-1)!;
    const bad = periods.flatMap(x => x.checks.filter(c => !c.ok).map(c => `${x.cutoff}: ${c.detail}`));
    return `${file.name}: desglose del pasivo entendido con reglas (${res.unitLabel}, ${periods.map(x => x.cutoff).join(', ')}). `
      + `Fondeo ${m(p.composition.fondeo)} en ${p.funding.length} fondeador(es); no es fondeo: impuestos ${m(p.composition.impuestos)}, operativo ${m(p.composition.operativo)}, empleados ${m(p.composition.empleados)}. `
      + `${bad.length ? `⚠ No cuadra: ${bad.join(' · ')}. ` : 'Cuadra ✓. '}`
      + `${created ? `${created} fondeador(es) nuevo(s). ` : ''}${updated ? `${updated} saldo(s) actualizado(s). ` : ''}`;
  };

  const handleFilesSelect = async (files: FileList | File[]) => {
    if (schemaReady === false) return;
    const selected = Array.from(files);
    if (!selected.length) return;
    setBusy(`Procesando ${selected.length} archivo${selected.length === 1 ? '' : 's'}...`);
    setUploadWarning(null);
    setImportSummary(null);
    try {
      let savedRows = 0;
      let updatedRows = 0;
      const warnings: string[] = [];
      const breakdownNotes: string[] = [];
      const existingRows = [...liabilities];
      const bySourceKey = new Map(existingRows.map(row => [liabilityDedupeKey(row as any, row.sourceDocumentId), row]));
      const byFacilityKey = new Map(existingRows.map(row => [liabilityFacilityKey(row as any), row]));
      for (const file of selected) {
        setBusy(`Leyendo ${file.name}...`);
        const breakdown = await tryBreakdown(file).catch(() => null);
        if (breakdown) {
          breakdownNotes.push(await applyBreakdown(breakdown, file));
          continue;
        }
        const extracted = await extractRowsFromFile(file);
        // Cualquier IA: las mismas reglas descartan impuestos, proveedores y beneficios a empleados.
        const screened = screenAiLiabilityRows(extracted.parsed);
        if (screened.dropped.length) warnings.push(`${file.name}: se descartaron ${screened.dropped.length} renglón(es) que no son fondeo (${screened.dropped.map(d => `${d.row.lenderName} → ${d.kind}`).join(', ')}).`);
        const parsed = screened.keep; const unmatchedFields = extracted.unmatchedFields;
        if (!parsed.length) {
          warnings.push(`${file.name}: sin filas detectadas.`);
          continue;
        }

        let sourceDocumentId: string | undefined;
        try {
          const doc = await db.uploadClientDocument(clientId, file, 'institutional_liability', { clientName, rows: parsed.length });
          sourceDocumentId = doc.id;
        } catch {
          warnings.push(`${file.name}: se guardaron filas, pero no se pudo archivar el archivo original.`);
        }

        setBusy(`Guardando ${parsed.length} pasivos de ${file.name}...`);
        for (const row of parsed) {
          const enrichedRow = {
            ...row,
            notes: [row.notes, `Fuente: ${file.name}`].filter(Boolean).join(' | ') || undefined,
          };
          const sourceSignature = liabilityDedupeKey(enrichedRow, sourceDocumentId, file.name);
          const facilitySignature = liabilityFacilityKey(enrichedRow);
          const duplicate = bySourceKey.get(sourceSignature) || byFacilityKey.get(facilitySignature);
          if (duplicate) {
            const updates = mergeLiabilityUpdates(duplicate, enrichedRow, sourceDocumentId, file.name);
            await db.updateInstitutionalLiability(duplicate.id, updates);
            const merged = { ...duplicate, ...updates } as InstitutionalLiability_DB;
            bySourceKey.set(liabilityDedupeKey(merged as any, merged.sourceDocumentId, file.name), merged);
            byFacilityKey.set(liabilityFacilityKey(merged as any), merged);
            updatedRows += 1;
            continue;
          }
          const created = await db.createInstitutionalLiability({ clientId, sourceDocumentId, ...enrichedRow });
          bySourceKey.set(liabilityDedupeKey(created as any, created.sourceDocumentId, file.name), created);
          byFacilityKey.set(liabilityFacilityKey(created as any), created);
          savedRows += 1;
        }
        if (unmatchedFields.length && parsed.length) {
          warnings.push(`${file.name}: columnas no detectadas para ${unmatchedFields.join(', ')}.`);
        }
      }

      if (breakdownNotes.length) setHistoryKey(k => k + 1);
      if (!savedRows && !updatedRows && !breakdownNotes.length) {
        alert('No se detectaron pasivos institucionales en los archivos seleccionados.');
        return;
      }
      if (!savedRows && !updatedRows) {
        setImportSummary(breakdownNotes.join(' '));
        if (warnings.length) setUploadWarning(warnings.join(' '));
        await load();
        return;
      }
      setImportSummary([...breakdownNotes,
        savedRows ? `${savedRows} nuevos` : '',
        updatedRows ? `${updatedRows} duplicados actualizados/saltados` : '',
      ].filter(Boolean).join(' · ') + ` desde ${selected.length} archivo${selected.length === 1 ? '' : 's'}.`);
      if (warnings.length) setUploadWarning(warnings.join(' '));
      await load();
    } catch (e: any) {
      alert(`Error al procesar archivos: ${e?.message || e}`);
    } finally {
      setBusy(null);
    }
  };

  const handleExport = async () => {
    setBusy('Generando reporte Excel...');
    const target = reserveDownloadTarget();
    try {
      const mod = await loadExportModule();
      await mod.exportInstitutionalLiabilities(liabilities, clientName || 'Cliente', assetLiability, target);
    } catch (e: any) {
      alert(`Error al exportar: ${e?.message || e}`);
    } finally {
      setBusy(null);
    }
  };

  // El corte más reciente del historial actualiza el saldo actual de cada pasivo (mismo acreedor por nombre).
  const syncBalancesFromHistory = async (lines: LiabilityLine[], cutoff: string) => {
    const norm = (v: string) => normalizeKeyPart(v);
    await Promise.all(lines.map(line => {
      const hit = liabilities.find(l => norm(l.lenderName) === norm(line.lender));
      if (!hit || hit.currentBalance === line.balance) return Promise.resolve();
      const note = `Saldo actualizado desde el historial (corte ${cutoff}).`;
      return db.updateInstitutionalLiability(hit.id, { currentBalance: line.balance, notes: hit.notes ? `${hit.notes}\n${note}` : note });
    }));
    await load();
  };

  return (
    <div className="space-y-6">
      <WorkingOverlay show={!!busy} title={busy || 'Procesando'} />
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-black text-slate-900 flex items-center gap-2">
            <Landmark className="w-5 h-5 text-indigo-600" /> Pasivos Institucionales
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">Colección de fondeo institucional: PDFs, Excel o CSV consolidados por acreedor/facility.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className={`flex items-center gap-1.5 text-xs font-black text-slate-700 bg-white border border-slate-200 hover:border-indigo-300 px-3 py-2 rounded-xl transition-colors ${schemaReady === false ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
            <Upload className="w-3.5 h-3.5" /> Subir archivos
            <input type="file" multiple accept={ACCEPTED_FILES} className="hidden" disabled={schemaReady === false} onChange={e => { if (e.target.files?.length) handleFilesSelect(e.target.files); e.target.value = ''; }} />
          </label>
          <button onClick={openNew} disabled={schemaReady === false} className="flex items-center gap-1.5 text-xs font-black text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-2 rounded-xl transition-colors">
            <Plus className="w-3.5 h-3.5" /> Agregar
          </button>
          <button onClick={handleExport} disabled={!liabilities.length} className="flex items-center gap-1.5 text-xs font-black text-slate-700 bg-white border border-slate-200 hover:border-indigo-300 disabled:opacity-40 px-3 py-2 rounded-xl transition-colors">
            <Download className="w-3.5 h-3.5" /> Reporte Excel
          </button>
        </div>
      </div>

      {schemaReady === false && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 text-amber-900 text-xs font-semibold px-4 py-3.5 rounded-xl">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-black">Falta aplicar una migración en Supabase</p>
            <p className="mt-1 opacity-90">
              La tabla <code className="font-mono bg-amber-100 px-1 rounded">institutional_liabilities</code> todavía no existe en la base de datos.
              Corre <code className="font-mono bg-amber-100 px-1 rounded">database/20260716_institutional_liabilities.sql</code> en el editor SQL de Supabase y vuelve a cargar esta pestaña para poder agregar o subir pasivos.
            </p>
          </div>
        </div>
      )}

      {uploadWarning && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-800 text-xs font-semibold px-4 py-3 rounded-xl">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {uploadWarning}
        </div>
      )}
      {importSummary && (
        <div className="flex items-start gap-2 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold px-4 py-3 rounded-xl">
          <Check className="w-4 h-4 flex-shrink-0 mt-0.5" /> {importSummary}
        </div>
      )}

      {schemaReady !== false && (
        <LiabilityHistoryPanel
          clientId={clientId}
          clientName={clientName || 'Cliente'}
          liabilities={liabilities}
          onSyncBalances={syncBalancesFromHistory}
          reloadKey={historyKey}
        />
      )}

      {loading ? (
        <div className="text-sm text-slate-400 py-10 text-center">Cargando...</div>
      ) : !liabilities.length ? (
        <div className="text-center py-16 bg-slate-50 rounded-2xl border border-slate-200">
          <Landmark className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 font-semibold">Sin pasivos institucionales registrados</p>
          <p className="text-slate-400 text-sm mt-1">Sube un Excel/CSV o agrega manualmente para comenzar</p>
        </div>
      ) : (
        <>
          <LiabilitiesCockpit
            liabilities={liabilities}
            analysis={analysis}
            insights={insights}
            assetLiability={assetLiability}
            clientName={clientName || 'Cliente'}
          />

          <div className="bg-white rounded-2xl border border-slate-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left">
                  <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs">Acreedor</th>
                  <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs">Tipo</th>
                  <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs text-right">Monto Original</th>
                  <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs text-right">Saldo Actual</th>
                  <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs text-right">Tasa</th>
                  <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs">Vencimiento</th>
                  <th className="px-4 py-3 font-black text-slate-500 uppercase text-xs" />
                </tr>
              </thead>
              <tbody>
                {liabilities.map(l => (
                  <tr key={l.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3 font-bold text-slate-800">{l.lenderName}</td>
                    <td className="px-4 py-3 text-slate-600">{LIABILITY_TYPE_LABELS[l.liabilityType] || l.liabilityType}</td>
                    <td className="px-4 py-3 text-right text-slate-600">{formatMoney(l.originalAmount, l.currency)}</td>
                    <td className="px-4 py-3 text-right font-bold text-slate-800">{formatMoney(l.currentBalance, l.currency)}</td>
                    <td className="px-4 py-3 text-right text-slate-600">{formatPercent(l.interestRate)}{l.rateDescription ? <span className="text-slate-400"> ({l.rateDescription})</span> : null}</td>
                    <td className="px-4 py-3 text-slate-600">{l.maturityDate || 'N/A'}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button onClick={() => openEdit(l)} className="text-slate-400 hover:text-indigo-600 mr-2"><Pencil className="w-3.5 h-3.5" /></button>
                      <button onClick={() => handleDelete(l.id)} className="text-slate-300 hover:text-rose-500"><Trash2 className="w-3.5 h-3.5" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {modalOpen && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setModalOpen(false)}>
          <div className="bg-white rounded-2xl p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-black text-slate-900">{editingId ? 'Editar Pasivo' : 'Nuevo Pasivo Institucional'}</h3>
              <button onClick={() => setModalOpen(false)}><X className="w-4 h-4 text-slate-400" /></button>
            </div>
            <div className="space-y-3">
              <Field label="Acreedor / Institución *"><input className="input" value={form.lenderName} onChange={e => setForm({ ...form, lenderName: e.target.value })} placeholder="ej: Banco XYZ" /></Field>
              <Field label="Tipo">
                <select className="input" value={form.liabilityType} onChange={e => setForm({ ...form, liabilityType: e.target.value as any })}>
                  {Object.entries(LIABILITY_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Monto Original"><input type="number" className="input" value={form.originalAmount} onChange={e => setForm({ ...form, originalAmount: e.target.value })} /></Field>
                <Field label="Saldo Actual"><input type="number" className="input" value={form.currentBalance} onChange={e => setForm({ ...form, currentBalance: e.target.value })} /></Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Moneda"><input className="input" value={form.currency} onChange={e => setForm({ ...form, currency: e.target.value })} /></Field>
                <Field label="Tasa Anual (%)"><input type="number" className="input" value={form.interestRate} onChange={e => setForm({ ...form, interestRate: e.target.value })} /></Field>
              </div>
              <Field label="Referencia de Tasa"><input className="input" value={form.rateDescription} onChange={e => setForm({ ...form, rateDescription: e.target.value })} placeholder="ej: TIIE + 350 pb" /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Fecha de Originación"><input type="date" className="input" value={form.originationDate} onChange={e => setForm({ ...form, originationDate: e.target.value })} /></Field>
                <Field label="Fecha de Vencimiento"><input type="date" className="input" value={form.maturityDate} onChange={e => setForm({ ...form, maturityDate: e.target.value })} /></Field>
              </div>
              <Field label="Amortización"><input className="input" value={form.amortization} onChange={e => setForm({ ...form, amortization: e.target.value })} placeholder="ej: mensual, bullet" /></Field>
              <Field label="Garantía"><input className="input" value={form.guarantee} onChange={e => setForm({ ...form, guarantee: e.target.value })} /></Field>
              <Field label="Notas"><textarea className="input" rows={2} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></Field>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setModalOpen(false)} className="text-xs font-black text-slate-500 px-4 py-2">Cancelar</button>
              <button onClick={handleSave} className="text-xs font-black text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-xl">Guardar</button>
            </div>
          </div>
        </div>
      )}
      <style>{`.input { width: 100%; border: 1px solid #e2e8f0; border-radius: 0.75rem; padding: 0.5rem 0.75rem; font-size: 0.875rem; }`}</style>
    </div>
  );
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-black text-slate-500 uppercase mb-1">{label}</label>
      {children}
    </div>
  );
}

export default InstitutionalLiabilitiesPanel;
