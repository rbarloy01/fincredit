import React, { useRef, useState } from 'react';
import { FileSpreadsheet, Plus, Trash2 } from 'lucide-react';
import { LineMovement, LineMovementType, newMovementId, parseMovementRows, parsePastedMovements } from '../../lib/lineLedger';
import { sheetToRows } from '../../lib/sheetRows';

interface Props {
  movements: LineMovement[];
  onChange: (next: LineMovement[]) => void;
}

const inputClass = 'w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-blue-200';
const btnClass = 'flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-slate-600 hover:bg-slate-50';

const LineMovementsEditor: React.FC<Props> = ({ movements, onChange }) => {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [message, setMessage] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const sorted = [...movements].sort((a, b) => (a.fecha || '9999').localeCompare(b.fecha || '9999'));

  const patchOne = (id: string, patch: Partial<LineMovement>) =>
    onChange(movements.map(m => (m.id === id ? { ...m, ...patch } : m)));

  const add = (tipo: LineMovementType) =>
    onChange([...movements, { id: newMovementId(), fecha: new Date().toISOString().slice(0, 10), tipo, monto: 0 }]);

  const append = (result: { movements: LineMovement[]; skipped: number }) => {
    if (result.movements.length === 0) {
      setMessage('No encontré movimientos válidos. Usa columnas Fecha, Monto y (opcional) Tipo.');
      return;
    }
    onChange([...movements, ...result.movements]);
    setMessage(`${result.movements.length} movimientos agregados${result.skipped ? ` · ${result.skipped} filas omitidas` : ''}.`);
  };

  const importPaste = () => {
    append(parsePastedMovements(pasteText));
    setPasteText('');
    setPasteOpen(false);
  };

  const importFile = async (file: File) => {
    try {
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = sheetToRows<unknown[]>(XLSX, sheet, { header: 1, blankrows: false, defval: null, raw: true });
      append(parseMovementRows(rows));
    } catch {
      setMessage('No pude leer el archivo. Sube un .xlsx o .csv.');
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-2">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Movimientos de la línea</p>
        <div className="flex flex-wrap gap-1">
          <button type="button" className={btnClass} onClick={() => add('disposicion')}><Plus className="h-3 w-3" />Disposición</button>
          <button type="button" className={btnClass} onClick={() => add('amortizacion')}><Plus className="h-3 w-3" />Amortización</button>
          <button type="button" className={btnClass} onClick={() => setPasteOpen(v => !v)}><FileSpreadsheet className="h-3 w-3" />Pegar de Excel</button>
          <button type="button" className={btnClass} onClick={() => fileRef.current?.click()}><FileSpreadsheet className="h-3 w-3" />Subir archivo</button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }}
          />
        </div>
      </div>

      {pasteOpen && (
        <div className="space-y-1">
          <textarea
            className={`${inputClass} h-24 font-mono`}
            value={pasteText}
            onChange={e => setPasteText(e.target.value)}
            placeholder={'Copia de Excel y pega aquí. Columnas: Fecha, Monto, Tipo (Disposición/Amortización; vacío = amortización)\n15/01/2026\t250000\tAmortización'}
          />
          <button type="button" className={btnClass} onClick={importPaste} disabled={!pasteText.trim()}>Agregar movimientos</button>
        </div>
      )}

      {message && <p className="text-[11px] font-semibold text-slate-500">{message}</p>}

      {sorted.length === 0 ? (
        <p className="text-[11px] font-semibold text-slate-400">
          Sin movimientos: el saldo se captura a mano. Agrega disposiciones/amortizaciones y el saldo y la utilización se calculan solos.
        </p>
      ) : (
        <div className="space-y-1">
          {sorted.map(m => (
            <div key={m.id} className="grid grid-cols-[110px_1fr_1fr_28px] items-center gap-1">
              <input className={inputClass} type="date" value={m.fecha} onChange={e => patchOne(m.id, { fecha: e.target.value })} />
              <select className={inputClass} value={m.tipo} onChange={e => patchOne(m.id, { tipo: e.target.value as LineMovementType })}>
                <option value="disposicion">Disposición (+)</option>
                <option value="amortizacion">Amortización (−)</option>
              </select>
              <input
                className={inputClass}
                type="number"
                min="0"
                value={m.monto || ''}
                onChange={e => patchOne(m.id, { monto: Math.abs(Number(e.target.value) || 0) })}
                placeholder="Monto"
              />
              <button type="button" onClick={() => onChange(movements.filter(x => x.id !== m.id))} className="rounded-md p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default LineMovementsEditor;
