import React, { useState, useEffect } from 'react';
import { Client, CustomField, db } from '../../db/index';
import { Session } from '../../services/auth';
import { Plus, Trash2, ChevronLeft, Save } from 'lucide-react';

const nanoid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

interface Props {
  session: Session;
  initialData?: Client;
  onSave: (client: Client, customFields: CustomField[]) => void;
  onCancel: () => void;
}

const INDUSTRIES = ['SOFOM', 'SOFIPO', 'Arrendadora', 'Factoraje', 'Crédito Simple', 'Otro'];
const CREDIT_TYPES = ['Simple', 'Revolvente', 'Flex', 'Factoraje', 'Arrendamiento', 'Crédito Puente', 'Otro'];
const CURRENCIES = ['MXN', 'USD', 'EUR'] as const;
const FIELD_TYPES = [
  { value: 'text', label: 'Texto' },
  { value: 'number', label: 'Número' },
  { value: 'date', label: 'Fecha' },
];

const ClientForm: React.FC<Props> = ({ session, initialData, onSave, onCancel }) => {
  const [name, setName] = useState(initialData?.name || '');
  const [taxId, setTaxId] = useState(initialData?.taxId || '');
  const [industry, setIndustry] = useState(initialData?.industry || 'SOFOM');
  const [creditType, setCreditType] = useState<string[]>(initialData?.creditType || ['Simple']);
  const [currency, setCurrency] = useState<'MXN' | 'USD' | 'EUR'>(initialData?.currency || 'MXN');
  const [totalCreditValue, setTotalCreditValue] = useState(initialData?.totalCreditValue?.toString() || '');
  const [contractName, setContractName] = useState(initialData?.contractName || '');
  const [analystName, setAnalystName] = useState(initialData?.analystName || '');
  const [score, setScore] = useState(initialData?.score || '');
  const [frequency, setFrequency] = useState<'mensual' | 'trimestral'>(initialData?.frequency || 'mensual');
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (initialData) {
      db.getCustomFields(initialData.id).then(fields => setCustomFields(fields));
    }
  }, [initialData]);

  const toggleCreditType = (ct: string) => {
    setCreditType(prev =>
      prev.includes(ct) ? prev.filter(x => x !== ct) : [...prev, ct]
    );
  };

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

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!name.trim()) newErrors.name = 'El nombre es requerido';
    if (!taxId.trim()) newErrors.taxId = 'El RFC es requerido';
    if (creditType.length === 0) newErrors.creditType = 'Selecciona al menos un tipo de crédito';
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
        totalCreditValue: parseFloat(totalCreditValue) || 0,
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
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button onClick={onCancel} className="text-slate-500 hover:text-slate-900 transition-colors">
          <ChevronLeft className="w-6 h-6" />
        </button>
        <div>
          <h1 className="text-2xl font-black text-slate-900 tracking-tight">
            {initialData ? 'Editar Cliente' : 'Nuevo Cliente'}
          </h1>
          <p className="text-slate-500 text-sm mt-0.5">Complete la información del cliente</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="max-w-3xl space-y-6">
        {/* Form error */}
        {errors.form && (
          <div className="bg-rose-50 border border-rose-200 rounded-xl p-4">
            <p className="text-rose-700 text-sm">{errors.form}</p>
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

            {/* Contract Name */}
            <div>
              <label className={labelClass}>Nombre del Contrato</label>
              <input
                type="text"
                value={contractName}
                onChange={e => setContractName(e.target.value)}
                placeholder="Contrato de Crédito Simple"
                className={inputClass()}
              />
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

        {/* Credit info */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <h2 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-6">Condiciones Crediticias</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Currency */}
            <div>
              <label className={labelClass}>Moneda</label>
              <select
                value={currency}
                onChange={e => setCurrency(e.target.value as 'MXN' | 'USD' | 'EUR')}
                className={inputClass()}
              >
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            {/* Total credit */}
            <div>
              <label className={labelClass}>Línea de Crédito Total</label>
              <input
                type="number"
                value={totalCreditValue}
                onChange={e => setTotalCreditValue(e.target.value)}
                placeholder="0"
                min="0"
                className={inputClass()}
              />
            </div>

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

            {/* Credit type */}
            <div className="md:col-span-2">
              <label className={labelClass}>Tipo de Crédito *</label>
              <div className="flex gap-3">
                {CREDIT_TYPES.map(ct => (
                  <button
                    key={ct}
                    type="button"
                    onClick={() => toggleCreditType(ct)}
                    className={`px-5 py-3 rounded-xl text-sm font-bold border transition-all ${
                      creditType.includes(ct)
                        ? 'bg-indigo-600 text-white border-indigo-600'
                        : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'
                    }`}
                  >
                    {ct}
                  </button>
                ))}
              </div>
              {errors.creditType && <p className="text-rose-500 text-xs mt-1">{errors.creditType}</p>}
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
