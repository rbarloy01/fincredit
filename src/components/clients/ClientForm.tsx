import React, { useState, useEffect, useRef } from 'react';
import { Client, CustomField, db } from '../../db/index';
import { Session } from '../../services/auth';
import { AISettings, AIMedia, ContractClientExtractionResult, extractClientFromContract } from '../../services/ai';
import { Plus, Trash2, ChevronLeft, Save, Upload, FileSignature, Sparkles, CheckCircle, X } from 'lucide-react';
import { parseFinancialNumber } from '../../lib/numberParsing';
import { extractPdfText, isUsefulExtractedText, renderPdfPreviewImages } from '../../lib/documentParsing';
import WorkingOverlay from '../common/WorkingOverlay';

const nanoid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

interface Props {
  session: Session;
  aiSettings: AISettings;
  initialData?: Client;
  onSave: (client: Client, customFields: CustomField[]) => void;
  onCancel: () => void;
}

const INDUSTRIES = ['SOFOM', 'SOFIPO', 'Arrendadora', 'Factoraje', 'Crédito Simple', 'Otro'];
const CREDIT_TYPES = ['Simple', 'Revolvente', 'Flex', 'Factoraje', 'Arrendamiento', 'Crédito Puente', 'Otro'];
const FIELD_TYPES = [
  { value: 'text', label: 'Texto' },
  { value: 'number', label: 'Número' },
  { value: 'date', label: 'Fecha' },
];

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function decodeText(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

const ClientForm: React.FC<Props> = ({ session, aiSettings, initialData, onSave, onCancel }) => {
  const [name, setName] = useState(initialData?.name || '');
  const [taxId, setTaxId] = useState(initialData?.taxId || '');
  const [industry, setIndustry] = useState(initialData?.industry || 'SOFOM');
  const [creditType, setCreditType] = useState<string[]>(initialData?.creditType || []);
  const [currency, setCurrency] = useState<'MXN' | 'USD' | 'EUR'>(initialData?.currency || 'MXN');
  const [totalCreditValue, setTotalCreditValue] = useState(initialData?.totalCreditValue?.toString() || '');
  const [contractName, setContractName] = useState(initialData?.contractName || '');
  const [analystName, setAnalystName] = useState(initialData?.analystName || '');
  const [score, setScore] = useState(initialData?.score || '');
  const [frequency, setFrequency] = useState<'mensual' | 'trimestral'>(initialData?.frequency || 'mensual');
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [saving, setSaving] = useState(false);
  const [contractFile, setContractFile] = useState<{ file: File; base64?: string } | null>(null);
  const [contractExtraction, setContractExtraction] = useState<ContractClientExtractionResult | null>(null);
  const [extractingContract, setExtractingContract] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const contractInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialData) {
      db.getCustomFields(initialData.id).then(fields => setCustomFields(fields));
    }
  }, [initialData]);

  const addCustomField = () => {
    const newField: CustomField = {
      id: nanoid(),
      clientId: initialData?.id || '',
      label: '',
      value: '',
      fieldType: 'text',
    };
    setCustomFields(prev => [...prev, newField]);
  };

  const updateCustomField = (id: string, key: keyof CustomField, value: string) => {
    setCustomFields(prev => prev.map(f => f.id === id ? { ...f, [key]: value } : f));
  };

  const removeCustomField = (id: string) => {
    setCustomFields(prev => prev.filter(f => f.id !== id));
  };

  const handleContractFile = async (file: File) => {
    const supported = file.type === 'application/pdf'
      || file.type === 'text/plain'
      || file.type.startsWith('image/')
      || /\.(pdf|txt|png|jpe?g|webp)$/i.test(file.name);
    if (!supported) {
      setErrors(prev => ({ ...prev, contract: 'Sube un PDF, TXT o imagen del contrato.' }));
      return;
    }
    setExtractingContract(true);
    setErrors(prev => ({ ...prev, contract: '' }));
    try {
      const mimeType = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/plain');
      const extractedPdfText = mimeType === 'application/pdf' ? await extractPdfText(file) : '';
      const textBase64 = mimeType === 'text/plain' ? await toBase64(file) : '';
      const text = mimeType === 'text/plain' ? decodeText(textBase64) : extractedPdfText;
      const needsVisualUpload = mimeType !== 'text/plain' && !isUsefulExtractedText(text);
      let media: AIMedia[] = [];
      if (needsVisualUpload && mimeType === 'application/pdf') {
        const previews = await renderPdfPreviewImages(file);
        media = previews.map((base64, index) => ({
          base64,
          mimeType: 'image/jpeg',
          fileName: `${file.name} · muestra ${index + 1}`,
        }));
      } else if (needsVisualUpload) {
        media = [{ base64: await toBase64(file), mimeType, fileName: file.name }];
      }
      if (needsVisualUpload && media.length === 0) {
        throw new Error('No pude leer el PDF escaneado. Intenta exportarlo nuevamente o subir imágenes de las páginas principales.');
      }
      const extraction = await extractClientFromContract(aiSettings, text, media.length ? media : undefined);
      setContractFile({ file, base64: textBase64 || undefined });
      setContractExtraction(extraction);
      setName(extraction.client.legalName || name);
      setTaxId(extraction.client.taxId || taxId);
      setIndustry(INDUSTRIES.includes(extraction.client.industry) ? extraction.client.industry : 'Otro');
      setContractName(extraction.transaction.contractName || file.name.replace(/\.[^.]+$/, ''));
      setCreditType([CREDIT_TYPES.includes(extraction.transaction.creditType) ? extraction.transaction.creditType : 'Otro']);
      setCurrency(extraction.transaction.currency);
      setTotalCreditValue(extraction.transaction.originalAmount ? String(extraction.transaction.originalAmount) : totalCreditValue);
      setFrequency(extraction.transaction.reviewFrequency);
    } catch (err: any) {
      setErrors(prev => ({ ...prev, contract: err.message || 'No se pudo analizar el contrato.' }));
    } finally {
      setExtractingContract(false);
      if (contractInputRef.current) contractInputRef.current.value = '';
    }
  };

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!name.trim()) newErrors.name = 'El nombre es requerido';
    if (!taxId.trim()) newErrors.taxId = 'El RFC es requerido';
    if (score.trim()) {
      const numericScore = Number(score);
      if (!Number.isFinite(numericScore) || numericScore < 0 || numericScore > 100) {
        newErrors.score = 'La calificación debe estar entre 0 y 100';
      }
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setSaving(true);
    try {
      const clientData: Omit<Client, 'id' | 'createdAt'> = {
        name: name.trim(),
        taxId: taxId.trim().toUpperCase(),
        industry,
        creditType,
        currency,
        totalCreditValue: parseFinancialNumber(totalCreditValue),
        contractName: contractName.trim(),
        analystName: analystName.trim(),
        score: score.trim(),
        frequency,
        createdBy: session.userId,
        paymentHistory: initialData?.paymentHistory || [],
        currentDue: initialData?.currentDue || 0,
        maxDefaultDays: initialData?.maxDefaultDays || 0,
        maxDefaultAmount: initialData?.maxDefaultAmount || 0,
        defaultFrequency12m: initialData?.defaultFrequency12m || 0,
        opinion: initialData?.opinion || '',
        aforoRequerido: initialData?.aforoRequerido || '',
        aforoHistory: initialData?.aforoHistory || [],
        documentation: initialData?.documentation || [],
        reportDate: initialData?.reportDate || new Date().toISOString().slice(0, 10),
        lastPeriod: initialData?.lastPeriod || '',
      };

      let savedClient: Client;
      if (initialData) {
        await db.updateClient(initialData.id, clientData);
        savedClient = { ...initialData, ...clientData };
      } else {
        savedClient = await db.createClient(clientData);
      }

      // Update custom fields with correct clientId
      const fieldsWithClientId = customFields
        .filter(f => f.label.trim() && !f.label.startsWith('__setting:'))
        .map(f => ({
          ...f,
          id: f.id.length === 36 ? f.id : '',
          clientId: savedClient.id,
          label: f.label.trim(),
        }));
      await db.setCustomFields(savedClient.id, fieldsWithClientId);

      if (!initialData && contractExtraction) {
        const transaction = await db.createTransaction({
          clientId: savedClient.id,
          name: contractName.trim() || contractExtraction.transaction.contractName || 'Contrato de crédito',
          description: contractExtraction.transaction.description,
          date: contractExtraction.transaction.signedAt || new Date().toISOString().slice(0, 10),
          creditType: creditType[0] || contractExtraction.transaction.creditType,
          originalAmount: parseFinancialNumber(totalCreditValue),
          currency,
          signedAt: contractExtraction.transaction.signedAt,
          maturityAt: contractExtraction.transaction.maturityAt,
          createdBy: session.userId,
        });

        if (contractFile) {
          const storedBase64 = contractFile.base64 || await toBase64(contractFile.file);
          await db.addContractFile({
            transactionId: transaction.id,
            clientId: savedClient.id,
            originalName: contractFile.file.name,
            mimeType: contractFile.file.type || 'application/octet-stream',
            base64Data: storedBase64,
            extractionStatus: 'done',
            extractedCovenants: contractExtraction,
          });
        }

        for (const item of contractExtraction.condicionesHacer.filter(Boolean)) {
          await db.createCovenant({
            clientId: savedClient.id, transactionId: transaction.id,
            name: item.slice(0, 80), type: 'hacer', formula: '', threshold: '',
            operator: 'none', description: item, isCustom: false, extractedFrom: contractFile?.file.name,
          });
        }
        for (const item of contractExtraction.condicionesNoHacer.filter(Boolean)) {
          await db.createCovenant({
            clientId: savedClient.id, transactionId: transaction.id,
            name: item.slice(0, 80), type: 'noHacer', formula: '', threshold: '',
            operator: 'none', description: item, isCustom: false, extractedFrom: contractFile?.file.name,
          });
        }
        for (const covenant of contractExtraction.covenants.filter(item => item.name)) {
          await db.createCovenant({
            clientId: savedClient.id, transactionId: transaction.id,
            name: covenant.name, type: 'financial', formula: covenant.formula || '',
            threshold: covenant.threshold || '', operator: covenant.operator || 'none',
            description: covenant.description || '', isCustom: false, extractedFrom: contractFile?.file.name,
          });
        }
      }

      onSave(savedClient, fieldsWithClientId);
    } catch (err: any) {
      setErrors({ form: err.message || 'Error al guardar el cliente' });
    } finally {
      setSaving(false);
    }
  };

  const inputClass = (field?: string) =>
    `w-full bg-white border ${errors[field || ''] ? 'border-rose-400' : 'border-slate-200'} text-slate-900 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-all`;

  const labelClass = 'block text-slate-700 text-xs font-bold uppercase tracking-wider mb-2';

  return (
    <div className="flex-1 bg-slate-50 min-h-screen p-8">
      <WorkingOverlay
        show={extractingContract}
        title="Leyendo contrato"
        messages={['Identificando al acreditado...', 'Extrayendo condiciones del crédito...', 'Leyendo fechas e importes...', 'Separando obligaciones...', 'Preparando covenants...', 'Precargando el cliente...']}
      />
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button onClick={onCancel} className="text-slate-500 hover:text-slate-900 transition-colors">
          <ChevronLeft className="w-6 h-6" />
        </button>
        <div>
          <h1 className="text-2xl font-black text-slate-900 tracking-tight">
            {initialData ? 'Editar Cliente' : 'Nuevo Cliente'}
          </h1>
          <p className="text-slate-500 text-sm mt-0.5">{initialData ? 'Actualiza la información del cliente' : 'Crea manualmente o precarga desde un contrato opcional'}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="max-w-3xl space-y-6">
        {/* Form error */}
        {errors.form && (
          <div className="bg-rose-50 border border-rose-200 rounded-xl p-4">
            <p className="text-rose-700 text-sm">{errors.form}</p>
          </div>
        )}

        {!initialData && (
          <div className="bg-gradient-to-br from-slate-950 to-indigo-950 text-white border border-indigo-900 rounded-2xl p-6 shadow-xl">
            <input
              ref={contractInputRef}
              type="file"
              accept=".pdf,.txt,image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={e => e.target.files?.[0] && handleContractFile(e.target.files[0])}
            />
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-5">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-2xl bg-indigo-500/20 border border-indigo-300/20 flex items-center justify-center flex-shrink-0">
                  <FileSignature className="w-6 h-6 text-indigo-200" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-black text-lg">Precargar desde contrato</h2>
                    <Sparkles className="w-4 h-4 text-amber-300" />
                  </div>
                  <p className="text-sm text-slate-300 mt-1 max-w-xl">
                    Opcional: sube un contrato para llenar acreditado, RFC y crear automáticamente la facility, contrato y covenants. También puedes llenar todo manualmente sin subir nada.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => contractInputRef.current?.click()}
                disabled={extractingContract}
                className="flex items-center justify-center gap-2 bg-white text-slate-950 hover:bg-indigo-50 disabled:opacity-60 font-black px-5 py-3 rounded-xl text-sm whitespace-nowrap"
              >
                <Upload className="w-4 h-4" />
                {contractFile ? 'Cambiar contrato' : 'Subir contrato opcional'}
              </button>
            </div>
            {errors.contract && <p className="mt-4 text-sm font-bold text-rose-300">{errors.contract}</p>}
            {contractFile && contractExtraction && (
              <div className="mt-5 bg-white/10 border border-white/10 rounded-2xl p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <CheckCircle className="w-5 h-5 text-emerald-300 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="font-black text-sm truncate">{contractFile.file.name}</p>
                      <p className="text-xs text-slate-300 mt-0.5">
                        Se creará 1 transacción · {contractExtraction.covenants.length} covenants · {contractExtraction.condicionesHacer.length} obligaciones de hacer · {contractExtraction.condicionesNoHacer.length} de no hacer
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setContractFile(null); setContractExtraction(null); }}
                    className="text-slate-300 hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Basic info card */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <h2 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-6">Información General</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Name */}
            <div className="md:col-span-2">
              <label className={labelClass}>Nombre Legal *</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Razón social completa"
                className={inputClass('name')}
              />
              {errors.name && <p className="text-rose-500 text-xs mt-1">{errors.name}</p>}
            </div>

            {/* RFC */}
            <div>
              <label className={labelClass}>RFC / ID Fiscal *</label>
              <input
                type="text"
                value={taxId}
                onChange={e => setTaxId(e.target.value.toUpperCase())}
                placeholder="XAXX010101000"
                className={inputClass('taxId')}
                maxLength={13}
              />
              {errors.taxId && <p className="text-rose-500 text-xs mt-1">{errors.taxId}</p>}
            </div>

            {/* Industry */}
            <div>
              <label className={labelClass}>Industria</label>
              <select
                value={industry}
                onChange={e => setIndustry(e.target.value)}
                className={inputClass()}
              >
                {INDUSTRIES.map(i => <option key={i} value={i}>{i}</option>)}
              </select>
            </div>

            {/* Analyst Name */}
            <div>
              <label className={labelClass}>Nombre del Analista</label>
              <input
                type="text"
                value={analystName}
                onChange={e => setAnalystName(e.target.value)}
                placeholder="Nombre del analista responsable"
                className={inputClass()}
              />
            </div>
          </div>
        </div>

        {/* Monitoring info */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <h2 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-6">Monitoreo</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Score */}
            <div>
              <label className={labelClass}>Calificación</label>
              <input
                type="number"
                value={score}
                onChange={e => setScore(e.target.value)}
                min="0"
                max="100"
                step="1"
                placeholder="0-100"
                className={inputClass('score')}
              />
              {errors.score && <p className="text-rose-500 text-xs mt-1">{errors.score}</p>}
            </div>

            {/* Frequency */}
            <div>
              <label className={labelClass}>Frecuencia de Revisión</label>
              <div className="flex gap-3">
                {(['mensual', 'trimestral'] as const).map(f => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFrequency(f)}
                    className={`flex-1 py-3 rounded-xl text-sm font-bold border transition-all capitalize ${
                      frequency === f
                        ? 'bg-indigo-600 text-white border-indigo-600'
                        : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'
                    }`}
                  >
                    {f.charAt(0).toUpperCase() + f.slice(1)}
                  </button>
                ))}
              </div>
            </div>

          </div>
        </div>

        {/* Custom fields (manager only) */}
        {session.role === 'manager' && (
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-sm font-black text-slate-900 uppercase tracking-widest">Campos Adicionales</h2>
              <button
                type="button"
                onClick={addCustomField}
                className="flex items-center gap-2 text-indigo-600 hover:text-indigo-700 text-sm font-bold transition-colors"
              >
                <Plus className="w-4 h-4" />
                Agregar campo
              </button>
            </div>

            {customFields.length === 0 ? (
              <p className="text-slate-400 text-sm text-center py-4">
                Sin campos adicionales. Haz clic en "Agregar campo" para añadir.
              </p>
            ) : (
              <div className="space-y-3">
                {customFields.map(field => (
                  <div key={field.id} className="flex gap-3 items-start">
                    <input
                      type="text"
                      value={field.label}
                      onChange={e => updateCustomField(field.id, 'label', e.target.value)}
                      placeholder="Nombre del campo"
                      className="flex-1 bg-slate-50 border border-slate-200 text-slate-900 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                    />
                    <input
                      type={field.fieldType === 'number' ? 'number' : field.fieldType === 'date' ? 'date' : 'text'}
                      value={field.value}
                      onChange={e => updateCustomField(field.id, 'value', e.target.value)}
                      placeholder="Valor"
                      className="flex-1 bg-slate-50 border border-slate-200 text-slate-900 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                    />
                    <select
                      value={field.fieldType}
                      onChange={e => updateCustomField(field.id, 'fieldType', e.target.value)}
                      className="bg-slate-50 border border-slate-200 text-slate-700 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                    >
                      {FIELD_TYPES.map(ft => <option key={ft.value} value={ft.value}>{ft.label}</option>)}
                    </select>
                    <button
                      type="button"
                      onClick={() => removeCustomField(field.id)}
                      className="text-slate-400 hover:text-rose-500 transition-colors mt-2.5"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 bg-white border border-slate-200 text-slate-700 font-bold py-3.5 rounded-xl hover:bg-slate-50 transition-all text-sm"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={saving}
            className="flex-1 flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-400 text-white font-black py-3.5 rounded-xl transition-all text-sm shadow-lg shadow-indigo-200"
          >
            {saving ? (
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            ) : (
              <Save className="w-4 h-4" />
            )}
            {saving ? 'Guardando...' : 'Guardar Cliente'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default ClientForm;
