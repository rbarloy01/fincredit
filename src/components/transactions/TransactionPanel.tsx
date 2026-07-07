import React, { useState, useEffect, useRef } from 'react';
import { db, Transaction, ContractFile } from '../../db/index';
import { Session } from '../../services/auth';
import { AISettings, AIMedia, extractCovenants, ContractExtractionResult, FinancialCovenant } from '../../services/ai';
import {
  Plus, ChevronDown, ChevronRight, Upload, FileText, Trash2,
  Sparkles, Save, X, Calendar, DollarSign, FileSignature, Download,
  Pencil,
} from 'lucide-react';
import WorkingOverlay from '../common/WorkingOverlay';
import { parseFinancialNumber } from '../../lib/numberParsing';
import { extractPdfText, isUsefulExtractedText } from '../../lib/documentParsing';

const nanoid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

interface Props {
  clientId: string;
  clientName?: string;
  session: Session;
  aiSettings: AISettings;
  onCovenantsExtracted: () => void;
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function inferMimeType(file: Pick<ContractFile, 'mimeType' | 'originalName'>): string {
  if (file.mimeType) return file.mimeType;
  const name = file.originalName.toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}

function decodeBase64Text(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

const fmtDate = (d: string) => {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return d; }
};

const fmtAmount = (n: number, currency: string) => {
  const prefix = currency === 'MXN' ? '$' : currency === 'USD' ? 'USD ' : '€';
  if (n >= 1_000_000) return `${prefix}${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${prefix}${(n / 1_000).toFixed(1)}K`;
  return `${prefix}${n.toLocaleString('es-MX')}`;
};

interface TxFormData {
  name: string;
  description: string;
  date: string;
  creditType: string;
  originalAmount: string;
  currency: string;
  signedAt: string;
  maturityAt: string;
}

interface Disposition {
  id: string;
  date: string;
  amount: string;
  currency: string;
  notes: string;
}

type DispositionMap = Record<string, Disposition[]>;
const dispositionsKey = (clientId: string) => `finmonitor_transaction_dispositions_${clientId}`;

const EMPTY_FORM: TxFormData = {
  name: '', description: '', date: '', creditType: 'Simple',
  originalAmount: '', currency: 'MXN', signedAt: '', maturityAt: '',
};

const TransactionPanel: React.FC<Props> = ({ clientId, clientName = '', session, aiSettings, onCovenantsExtracted }) => {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [files, setFiles] = useState<Record<string, ContractFile[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'excel' | 'pdf' | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingTxId, setEditingTxId] = useState<string | null>(null);
  const [form, setForm] = useState<TxFormData>(EMPTY_FORM);
  const [formSaving, setFormSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [extractedMap, setExtractedMap] = useState<Record<string, ContractExtractionResult>>({});
  const [savingCovenants, setSavingCovenants] = useState<string | null>(null);
  const [dispositions, setDispositions] = useState<DispositionMap>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);

  const handleExport = async (format: 'excel' | 'pdf') => {
    setExporting(format);
    try {
      const { exportTransacciones } = await import('../../lib/export');
      await exportTransacciones(transactions, clientName, format, format === 'pdf' ? panelRef.current ?? undefined : undefined);
    } finally {
      setExporting(null);
    }
  };

  const loadTransactions = async () => {
    const txs = await db.getTransactions(clientId);
    txs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    setTransactions(txs);
    const fileMap: Record<string, ContractFile[]> = {};
    for (const tx of txs) {
      fileMap[tx.id] = await db.getContractFiles(tx.id);
    }
    setFiles(fileMap);
    setDispositions(await db.getClientSetting<DispositionMap>(clientId, dispositionsKey(clientId), {}));
  };

  useEffect(() => { loadTransactions(); }, [clientId]);

  const handleFormChange = (key: keyof TxFormData, value: string) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const openCreateForm = () => {
    setEditingTxId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const openEditForm = (tx: Transaction) => {
    setEditingTxId(tx.id);
    setForm({
      name: tx.name || '',
      description: tx.description || '',
      date: tx.date || '',
      creditType: tx.creditType || 'Simple',
      originalAmount: tx.originalAmount ? String(tx.originalAmount) : '',
      currency: tx.currency || 'MXN',
      signedAt: tx.signedAt || '',
      maturityAt: tx.maturityAt || '',
    });
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingTxId(null);
    setForm(EMPTY_FORM);
  };

  const handleSubmitTx = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setFormSaving(true);
    try {
      const payload = {
        clientId,
        name: form.name.trim(),
        description: form.description.trim(),
        date: form.date,
        creditType: form.creditType,
        originalAmount: parseFinancialNumber(form.originalAmount),
        currency: form.currency,
        signedAt: form.signedAt,
        maturityAt: form.maturityAt,
        createdBy: session.userId,
      };
      if (editingTxId) {
        await db.updateTransaction(editingTxId, payload);
      } else {
        await db.createTransaction(payload);
      }
      closeForm();
      await loadTransactions();
      onCovenantsExtracted();
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    } finally {
      setFormSaving(false);
    }
  };

  const handleDeleteTx = async (id: string) => {
    if (!confirm('¿Eliminar esta transacción?')) return;
    await db.deleteTransaction(id);
    await loadTransactions();
    onCovenantsExtracted();
  };

  const saveDispositions = async (next: DispositionMap) => {
    setDispositions(next);
    await db.setClientSetting(clientId, dispositionsKey(clientId), next);
  };

  const addDisposition = async (tx: Transaction) => {
    const next = {
      ...dispositions,
      [tx.id]: [
        ...(dispositions[tx.id] || []),
        { id: nanoid(), date: tx.date || '', amount: '', currency: tx.currency || 'MXN', notes: '' },
      ],
    };
    await saveDispositions(next);
  };

  const updateDisposition = async (txId: string, dispositionId: string, updates: Partial<Disposition>) => {
    const next = {
      ...dispositions,
      [txId]: (dispositions[txId] || []).map(item => item.id === dispositionId ? { ...item, ...updates } : item),
    };
    await saveDispositions(next);
  };

  const deleteDisposition = async (txId: string, dispositionId: string) => {
    const next = {
      ...dispositions,
      [txId]: (dispositions[txId] || []).filter(item => item.id !== dispositionId),
    };
    await saveDispositions(next);
  };

  const handleUploadFiles = async (txId: string, fileList: FileList) => {
    setUploadingFor(txId);
    try {
      for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i];
        const sourceDocument = await db.uploadClientDocument(clientId, file, 'contract', {
          transactionId: txId,
          uploadSurface: 'transactions_panel',
        });
        const base64Data = await toBase64(file);
        await db.addContractFile({
          transactionId: txId,
          clientId,
          sourceDocumentId: sourceDocument.id,
          originalName: file.name,
          mimeType: file.type,
          base64Data,
          extractionStatus: 'pending',
        });
      }
      await loadTransactions();
    } catch (err: any) {
      alert(`Error al subir archivo: ${err.message}`);
    } finally {
      setUploadingFor(null);
    }
  };

  const updateExtraction = (txId: string, updater: (e: ContractExtractionResult) => ContractExtractionResult) =>
    setExtractedMap(prev => ({ ...prev, [txId]: updater(prev[txId]) }));

  const updateHacerItem = (txId: string, idx: number, val: string) =>
    updateExtraction(txId, e => ({ ...e, condicionesHacer: e.condicionesHacer.map((v, i) => i === idx ? val : v) }));
  const deleteHacerItem = (txId: string, idx: number) =>
    updateExtraction(txId, e => ({ ...e, condicionesHacer: e.condicionesHacer.filter((_, i) => i !== idx) }));
  const addHacerItem = (txId: string) =>
    updateExtraction(txId, e => ({ ...e, condicionesHacer: [...e.condicionesHacer, ''] }));

  const updateNoHacerItem = (txId: string, idx: number, val: string) =>
    updateExtraction(txId, e => ({ ...e, condicionesNoHacer: e.condicionesNoHacer.map((v, i) => i === idx ? val : v) }));
  const deleteNoHacerItem = (txId: string, idx: number) =>
    updateExtraction(txId, e => ({ ...e, condicionesNoHacer: e.condicionesNoHacer.filter((_, i) => i !== idx) }));
  const addNoHacerItem = (txId: string) =>
    updateExtraction(txId, e => ({ ...e, condicionesNoHacer: [...e.condicionesNoHacer, ''] }));

  const updateCovField = (txId: string, idx: number, field: keyof FinancialCovenant, val: string) =>
    updateExtraction(txId, e => ({
      ...e,
      covenants: e.covenants.map((c, i) => i === idx ? { ...c, [field]: val } : c),
    }));
  const deleteCov = (txId: string, idx: number) =>
    updateExtraction(txId, e => ({ ...e, covenants: e.covenants.filter((_, i) => i !== idx) }));
  const addCov = (txId: string) =>
    updateExtraction(txId, e => ({
      ...e,
      covenants: [...e.covenants, { name: '', threshold: '', operator: 'none' as const, description: '', formula: '' }],
    }));

  const handleAnalyze = async (txId: string) => {
    const txFiles = files[txId] || [];
    if (txFiles.length === 0) { alert('Sube al menos un contrato antes de analizar'); return; }

    setAnalyzing(txId);
    try {
      const textParts: string[] = [];
      const mediaFiles: AIMedia[] = [];

      for (const f of txFiles) {
        const mimeType = inferMimeType(f);
        if (mimeType === 'text/plain') {
          textParts.push(`Archivo: ${f.originalName}\n${decodeBase64Text(f.base64Data)}`);
        } else if (mimeType === 'application/pdf') {
          const bytes = Uint8Array.from(atob(f.base64Data), char => char.charCodeAt(0));
          const pdfFile = new File([bytes], f.originalName, { type: mimeType });
          const parsedText = await extractPdfText(pdfFile);
          if (isUsefulExtractedText(parsedText)) textParts.push(`Archivo: ${f.originalName}\n${parsedText}`);
          else mediaFiles.push({ base64: f.base64Data, mimeType, fileName: f.originalName });
        } else if (mimeType.startsWith('image/')) {
          mediaFiles.push({ base64: f.base64Data, mimeType, fileName: f.originalName });
        }
      }

      const contractText = textParts.join('\n\n');
      const fallbackText = `Contrato: ${txFiles.map(f => f.originalName).join(', ')}`;
      const result = await extractCovenants(
        aiSettings,
        contractText || (mediaFiles.length > 0 ? '' : fallbackText),
        mediaFiles.length > 0 ? mediaFiles : undefined,
      );
      setExtractedMap(prev => ({ ...prev, [txId]: result }));

      for (const f of txFiles) {
        await db.updateContractFile(f.id, {
          extractionStatus: 'done',
          extractedCovenants: result,
        });
      }
      await loadTransactions();
    } catch (err: any) {
      await Promise.all(txFiles.map(f => db.updateContractFile(f.id, { extractionStatus: 'error' }).catch(() => undefined)));
      await loadTransactions();
      alert(`Error al analizar: ${err.message}`);
    } finally {
      setAnalyzing(null);
    }
  };

  const handleSaveCovenants = async (txId: string) => {
    const extraction = extractedMap[txId];
    if (!extraction) return;
    setSavingCovenants(txId);
    try {
      await Promise.all((files[txId] || []).map(f => db.updateContractFile(f.id, {
        extractionStatus: 'done',
        extractedCovenants: extraction,
      })));
      for (const item of extraction.condicionesHacer) {
        await db.createCovenant({
          clientId, transactionId: txId,
          name: item.slice(0, 80), type: 'hacer',
          formula: '', threshold: '', operator: 'none',
          description: item, isCustom: false,
        });
      }
      for (const item of extraction.condicionesNoHacer) {
        await db.createCovenant({
          clientId, transactionId: txId,
          name: item.slice(0, 80), type: 'noHacer',
          formula: '', threshold: '', operator: 'none',
          description: item, isCustom: false,
        });
      }
      for (const cov of extraction.covenants) {
        await db.createCovenant({
          clientId, transactionId: txId,
          name: cov.name, type: 'financial',
          formula: cov.formula || '', threshold: cov.threshold,
          operator: cov.operator, description: cov.description,
          isCustom: false,
        });
      }
      setExtractedMap(prev => { const n = { ...prev }; delete n[txId]; return n; });
      onCovenantsExtracted();
      await loadTransactions();
      alert('Covenants guardados exitosamente');
    } catch (err: any) {
      alert(`Error al guardar covenants: ${err.message}`);
    } finally {
      setSavingCovenants(null);
    }
  };

  const inputClass = 'bg-slate-50 border border-slate-200 text-slate-900 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-all w-full';

  return (
    <div ref={panelRef} className="space-y-6">
      <WorkingOverlay
        show={!!uploadingFor || !!analyzing || !!savingCovenants || !!exporting}
        title={exporting ? 'Exportando' : analyzing ? 'Analizando contrato' : savingCovenants ? 'Guardando covenants' : 'Procesando contrato'}
        messages={[
          'Almost there...',
          'Working on it...',
          'Still moving...',
          'One more pass...',
          exporting ? 'Construyendo archivo...' : 'Leyendo contrato...',
          exporting ? 'Aplicando formato...' : 'Extrayendo obligaciones...',
          exporting ? 'Preparando descarga...' : 'Preparando covenants...',
          exporting ? 'Acomodando hojas...' : 'Separando hacer y no hacer...',
          exporting ? 'Casi queda...' : 'Revisando covenants financieros...',
          exporting ? 'Listo en un momento...' : 'Preparando resultado...',
        ]}
      />
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-black text-slate-900">Facilities y Contratos</h2>
          <p className="text-slate-500 text-sm mt-0.5">{transactions.length} facilit{transactions.length !== 1 ? 'ies' : 'y'}</p>
        </div>
        <div className="flex items-center gap-2">
          {transactions.length > 0 && (
            <>
              <button onClick={() => handleExport('excel')} disabled={!!exporting} className="flex items-center gap-1.5 bg-white border border-slate-200 text-slate-600 font-bold px-3 py-2 rounded-xl text-xs hover:bg-slate-50 disabled:opacity-50 transition-all">
                {exporting === 'excel' ? <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg> : <Download className="w-3.5 h-3.5" />}
                Excel
              </button>
              <button onClick={() => handleExport('pdf')} disabled={!!exporting} className="flex items-center gap-1.5 bg-white border border-slate-200 text-slate-600 font-bold px-3 py-2 rounded-xl text-xs hover:bg-slate-50 disabled:opacity-50 transition-all">
                {exporting === 'pdf' ? <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg> : <FileText className="w-3.5 h-3.5" />}
                PDF
              </button>
            </>
          )}
          <button
            onClick={openCreateForm}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-4 py-2.5 rounded-xl text-sm transition-all"
          >
            <Plus className="w-4 h-4" />
            Nueva Facility
          </button>
        </div>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-6 border-b border-slate-100">
              <h3 className="font-black text-slate-900">{editingTxId ? 'Editar Facility' : 'Nueva Facility'}</h3>
              <button onClick={closeForm} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmitTx} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Nombre de facility *</label>
                  <input className={inputClass} value={form.name} onChange={e => handleFormChange('name', e.target.value)} placeholder="Nombre de la facility / contrato" required />
                </div>
                <div className="col-span-2">
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Descripción</label>
                  <textarea className={inputClass} value={form.description} onChange={e => handleFormChange('description', e.target.value)} placeholder="Descripción opcional" rows={2} />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Fecha disposición inicial</label>
                  <input type="date" className={inputClass} value={form.date} onChange={e => handleFormChange('date', e.target.value)} />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Tipo de Crédito</label>
                  <select className={inputClass} value={form.creditType} onChange={e => handleFormChange('creditType', e.target.value)}>
                    {['Simple', 'Revolvente', 'Flex', 'Factoraje', 'Arrendamiento', 'Otro'].map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Monto autorizado</label>
                  <input type="text" inputMode="decimal" className={inputClass} value={form.originalAmount} onChange={e => handleFormChange('originalAmount', e.target.value)} placeholder="1,250,000.00" />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Moneda</label>
                  <select className={inputClass} value={form.currency} onChange={e => handleFormChange('currency', e.target.value)}>
                    {['MXN', 'USD', 'EUR'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Fecha firma</label>
                  <input type="date" className={inputClass} value={form.signedAt} onChange={e => handleFormChange('signedAt', e.target.value)} />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Vencimiento</label>
                  <input type="date" className={inputClass} value={form.maturityAt} onChange={e => handleFormChange('maturityAt', e.target.value)} />
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={closeForm} className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-700 text-sm font-bold hover:bg-slate-50 transition-all">
                  Cancelar
                </button>
                <button type="submit" disabled={formSaving} className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-black transition-all disabled:opacity-60">
                  {formSaving ? 'Guardando...' : editingTxId ? 'Guardar cambios' : 'Guardar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {transactions.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center">
          <FileSignature className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 font-semibold">Sin facilities registradas</p>
          <p className="text-slate-400 text-sm mt-1">Crea una facility para gestionar contrato, disposiciones y covenants</p>
        </div>
      ) : (
        <div className="space-y-3">
          {transactions.map(tx => {
            const txFiles = files[tx.id] || [];
            const isExpanded = expanded === tx.id;
            const extraction = extractedMap[tx.id];
            const txDispositions = dispositions[tx.id] || [];
            const disposedTotal = txDispositions.reduce((sum, item) => sum + parseFinancialNumber(item.amount), 0);

            return (
              <div key={tx.id} className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                <div
                  className="flex items-center gap-4 px-6 py-4 cursor-pointer hover:bg-slate-50 transition-colors select-none"
                  onClick={() => setExpanded(isExpanded ? null : tx.id)}
                >
                  <span className="text-slate-400 flex-shrink-0">
                    {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                      <h3 className="font-black text-slate-900 text-sm truncate">{tx.name}</h3>
                      <span className="text-xs bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-md font-semibold flex-shrink-0">{tx.creditType}</span>
                    </div>
                    <div className="flex items-center gap-4 mt-1 text-xs text-slate-500">
                      <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />Disp. inicial {fmtDate(tx.date)}</span>
                      <span className="flex items-center gap-1"><DollarSign className="w-3 h-3" />Autorizado {fmtAmount(tx.originalAmount, tx.currency)}</span>
                      {txDispositions.length > 0 && <span className="flex items-center gap-1 text-emerald-600 font-semibold">{txDispositions.length} disposición{txDispositions.length !== 1 ? 'es' : ''}</span>}
                      {txFiles.length > 0
                        ? <span className="flex items-center gap-1"><FileText className="w-3 h-3" />{txFiles.length} archivo{txFiles.length !== 1 ? 's' : ''}</span>
                        : <span className="flex items-center gap-1 text-indigo-400 font-semibold"><Upload className="w-3 h-3" />Subir contrato / anexos</span>
                      }
                    </div>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); openEditForm(tx); }}
                    className="text-slate-300 hover:text-indigo-500 transition-colors flex-shrink-0"
                    title="Editar transacción"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); handleDeleteTx(tx.id); }}
                    className="text-slate-300 hover:text-rose-500 transition-colors flex-shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {isExpanded && (
                  <div className="border-t border-slate-100 px-6 py-5 bg-slate-50 space-y-5">
                    {tx.description && <p className="text-sm text-slate-600">{tx.description}</p>}

                    <div className="grid grid-cols-3 gap-4 text-xs">
                      <div>
                        <span className="text-slate-500 font-bold uppercase tracking-wide">Firma</span>
                        <p className="text-slate-800 font-semibold mt-0.5">{fmtDate(tx.signedAt)}</p>
                      </div>
                      <div>
                        <span className="text-slate-500 font-bold uppercase tracking-wide">Disposición inicial</span>
                        <p className="text-slate-800 font-semibold mt-0.5">{fmtDate(tx.date)}</p>
                      </div>
                      <div>
                        <span className="text-slate-500 font-bold uppercase tracking-wide">Autorizado / dispuesto</span>
                        <p className="text-slate-800 font-semibold mt-0.5">{fmtAmount(tx.originalAmount, tx.currency)} / {fmtAmount(disposedTotal, tx.currency)}</p>
                      </div>
                    </div>

                    <div className="bg-white border border-slate-200 rounded-xl p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <p className="text-xs font-black text-slate-700 uppercase tracking-widest">Disposiciones</p>
                          <p className="text-xs text-slate-400 mt-0.5">Carga una o varias disposiciones cuando no se usa todo el monto autorizado de una sola vez.</p>
                        </div>
                        <button
                          onClick={() => addDisposition(tx)}
                          className="flex items-center gap-1.5 text-xs bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-500 transition-all font-bold"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          Agregar disposición
                        </button>
                      </div>
                      {txDispositions.length === 0 ? (
                        <p className="text-slate-400 text-xs">Sin disposiciones adicionales registradas</p>
                      ) : (
                        <div className="space-y-2">
                          {txDispositions.map(disposition => (
                            <div key={disposition.id} className="grid grid-cols-1 md:grid-cols-[140px_1fr_110px_1fr_auto] gap-2 items-center">
                              <input type="date" value={disposition.date} onChange={e => updateDisposition(tx.id, disposition.id, { date: e.target.value })} className={inputClass} />
                              <input type="text" inputMode="decimal" value={disposition.amount} onChange={e => updateDisposition(tx.id, disposition.id, { amount: e.target.value })} placeholder="Monto dispuesto" className={inputClass} />
                              <select value={disposition.currency} onChange={e => updateDisposition(tx.id, disposition.id, { currency: e.target.value })} className={inputClass}>
                                {['MXN', 'USD', 'EUR'].map(c => <option key={c} value={c}>{c}</option>)}
                              </select>
                              <input value={disposition.notes} onChange={e => updateDisposition(tx.id, disposition.id, { notes: e.target.value })} placeholder="Nota opcional" className={inputClass} />
                              <button onClick={() => deleteDisposition(tx.id, disposition.id)} className="text-slate-300 hover:text-rose-500 transition-colors justify-self-end">
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-xs font-black text-slate-700 uppercase tracking-widest">Archivos de Contrato</p>
                        <div>
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept=".pdf,.png,.jpg,.jpeg,.webp,.txt"
                            multiple
                            className="hidden"
                            onChange={e => e.target.files && handleUploadFiles(tx.id, e.target.files)}
                          />
                          <button
                            onClick={() => { setUploadingFor(tx.id); fileInputRef.current?.click(); }}
                            disabled={uploadingFor === tx.id}
                            className="flex items-center gap-1.5 text-xs bg-white border border-slate-200 text-slate-700 px-3 py-1.5 rounded-lg hover:border-indigo-300 transition-all font-bold"
                          >
                            <Upload className="w-3.5 h-3.5" />
                            {uploadingFor === tx.id ? 'Subiendo...' : 'Subir Contrato'}
                          </button>
                        </div>
                      </div>

                      {txFiles.length === 0 ? (
                        <p className="text-slate-400 text-xs">Sin archivos subidos</p>
                      ) : (
                        <div className="space-y-2">
                          {txFiles.map(f => (
                            <div key={f.id} className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-2.5">
                              <FileText className="w-4 h-4 text-indigo-500 flex-shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-slate-800 truncate">{f.originalName}</p>
                                <p className="text-xs text-slate-400">{fmtDate(f.uploadedAt)}</p>
                              </div>
                              <span className={`text-[10px] font-black px-2 py-0.5 rounded-md ${
                                f.extractionStatus === 'done' ? 'bg-emerald-100 text-emerald-700' :
                                f.extractionStatus === 'error' ? 'bg-rose-100 text-rose-700' :
                                'bg-slate-100 text-slate-600'
                              }`}>
                                {f.extractionStatus === 'done' ? 'Analizado' : f.extractionStatus === 'error' ? 'Error' : 'Pendiente'}
                              </span>
                              <button
                                onClick={async () => { await db.deleteContractFile(f.id); await loadTransactions(); }}
                                className="text-slate-300 hover:text-rose-500 transition-colors"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {txFiles.length > 0 && !extraction && (
                      <button
                        onClick={() => handleAnalyze(tx.id)}
                        disabled={analyzing === tx.id}
                        className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-400 text-white font-bold px-4 py-2.5 rounded-xl text-sm transition-all"
                      >
                        {analyzing === tx.id ? (
                          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                          </svg>
                        ) : (
                          <Sparkles className="w-4 h-4" />
                        )}
                        {analyzing === tx.id ? 'Analizando contrato...' : 'Extraer Covenants con IA'}
                      </button>
                    )}

                    {extraction && (
                      <div className="bg-white border border-indigo-200 rounded-xl p-5 space-y-5">
                        <div className="flex items-center justify-between">
                          <h4 className="text-sm font-black text-indigo-800 uppercase tracking-wider">Revisión de Covenants Extraídos</h4>
                          <p className="text-xs text-slate-500">Edita o elimina antes de guardar</p>
                        </div>

                        {/* Hacer */}
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-xs font-bold text-emerald-700 uppercase tracking-wider">Hacer ({extraction.condicionesHacer.length})</p>
                            <button onClick={() => addHacerItem(tx.id)} className="text-xs text-emerald-600 font-bold hover:text-emerald-500 flex items-center gap-0.5">
                              <Plus className="w-3 h-3" /> Agregar
                            </button>
                          </div>
                          <div className="space-y-2">
                            {extraction.condicionesHacer.map((item, i) => (
                              <div key={i} className="flex gap-2 items-start">
                                <span className="text-emerald-500 mt-2.5 flex-shrink-0 text-sm">✓</span>
                                <textarea
                                  value={item}
                                  onChange={e => updateHacerItem(tx.id, i, e.target.value)}
                                  rows={2}
                                  className="flex-1 bg-emerald-50 border border-emerald-200 text-slate-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 resize-none"
                                />
                                <button onClick={() => deleteHacerItem(tx.id, i)} className="text-slate-300 hover:text-rose-500 mt-2 flex-shrink-0 transition-colors">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ))}
                            {extraction.condicionesHacer.length === 0 && (
                              <p className="text-xs text-slate-400 italic">Sin obligaciones de hacer extraídas</p>
                            )}
                          </div>
                        </div>

                        {/* No Hacer */}
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-xs font-bold text-rose-700 uppercase tracking-wider">No Hacer ({extraction.condicionesNoHacer.length})</p>
                            <button onClick={() => addNoHacerItem(tx.id)} className="text-xs text-rose-600 font-bold hover:text-rose-500 flex items-center gap-0.5">
                              <Plus className="w-3 h-3" /> Agregar
                            </button>
                          </div>
                          <div className="space-y-2">
                            {extraction.condicionesNoHacer.map((item, i) => (
                              <div key={i} className="flex gap-2 items-start">
                                <span className="text-rose-500 mt-2.5 flex-shrink-0 text-sm">✗</span>
                                <textarea
                                  value={item}
                                  onChange={e => updateNoHacerItem(tx.id, i, e.target.value)}
                                  rows={2}
                                  className="flex-1 bg-rose-50 border border-rose-200 text-slate-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-400 resize-none"
                                />
                                <button onClick={() => deleteNoHacerItem(tx.id, i)} className="text-slate-300 hover:text-rose-500 mt-2 flex-shrink-0 transition-colors">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ))}
                            {extraction.condicionesNoHacer.length === 0 && (
                              <p className="text-xs text-slate-400 italic">Sin obligaciones de no hacer extraídas</p>
                            )}
                          </div>
                        </div>

                        {/* Financial covenants */}
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-xs font-bold text-blue-700 uppercase tracking-wider">Financieros ({extraction.covenants.length})</p>
                            <button onClick={() => addCov(tx.id)} className="text-xs text-blue-600 font-bold hover:text-blue-500 flex items-center gap-0.5">
                              <Plus className="w-3 h-3" /> Agregar
                            </button>
                          </div>
                          <div className="space-y-3">
                            {extraction.covenants.map((cov, i) => (
                              <div key={i} className="bg-blue-50 border border-blue-200 rounded-lg p-3 space-y-2">
                                <div className="flex gap-2">
                                  <div className="flex-1">
                                    <label className="text-[10px] font-bold text-blue-600 uppercase tracking-wide">Indicador</label>
                                    <input
                                      value={cov.name}
                                      onChange={e => updateCovField(tx.id, i, 'name', e.target.value)}
                                      className="w-full mt-0.5 bg-white border border-blue-200 text-slate-800 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                                    />
                                  </div>
                                  <div className="w-24">
                                    <label className="text-[10px] font-bold text-blue-600 uppercase tracking-wide">Umbral</label>
                                    <input
                                      value={cov.threshold}
                                      onChange={e => updateCovField(tx.id, i, 'threshold', e.target.value)}
                                      className="w-full mt-0.5 bg-white border border-blue-200 text-slate-800 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                                    />
                                  </div>
                                  <div className="w-20">
                                    <label className="text-[10px] font-bold text-blue-600 uppercase tracking-wide">Operador</label>
                                    <select
                                      value={cov.operator}
                                      onChange={e => updateCovField(tx.id, i, 'operator', e.target.value)}
                                      className="w-full mt-0.5 bg-white border border-blue-200 text-slate-800 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                                    >
                                      <option value="gte">≥</option>
                                      <option value="lte">≤</option>
                                      <option value="gt">&gt;</option>
                                      <option value="lt">&lt;</option>
                                      <option value="none">—</option>
                                    </select>
                                  </div>
                                  <button onClick={() => deleteCov(tx.id, i)} className="text-slate-300 hover:text-rose-500 mt-5 flex-shrink-0 transition-colors">
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                                <div>
                                  <label className="text-[10px] font-bold text-blue-600 uppercase tracking-wide">Descripción</label>
                                  <input
                                    value={cov.description}
                                    onChange={e => updateCovField(tx.id, i, 'description', e.target.value)}
                                    className="w-full mt-0.5 bg-white border border-blue-200 text-slate-800 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                                  />
                                </div>
                              </div>
                            ))}
                            {extraction.covenants.length === 0 && (
                              <p className="text-xs text-slate-400 italic">Sin covenants financieros extraídos</p>
                            )}
                          </div>
                        </div>

                        <div className="flex gap-3 pt-1">
                          <button
                            onClick={() => setExtractedMap(prev => { const n = { ...prev }; delete n[tx.id]; return n; })}
                            className="flex-1 py-2 rounded-xl border border-slate-200 text-slate-600 text-sm font-bold hover:bg-slate-50 transition-all"
                          >
                            Descartar
                          </button>
                          <button
                            onClick={() => handleSaveCovenants(tx.id)}
                            disabled={savingCovenants === tx.id}
                            className="flex-1 flex items-center justify-center gap-2 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-black transition-all disabled:opacity-60"
                          >
                            <Save className="w-4 h-4" />
                            {savingCovenants === tx.id ? 'Guardando...' : 'Guardar Covenants'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default TransactionPanel;
