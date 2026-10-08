import React from 'react';
import { BookOpen, Keyboard, PlayCircle, X } from 'lucide-react';
import { GLOSSARY, SHORTCUTS } from '../../lib/onboarding';

interface Props { onClose: () => void; onRestartTour: () => void }

const HelpCenter: React.FC<Props> = ({ onClose, onRestartTour }) => (
  <div className="print:hidden fixed inset-0 z-[65] flex items-center justify-center bg-slate-900/50 p-4" role="dialog" aria-modal="true" aria-label="Ayuda" onClick={onClose}>
    <section className="flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-indigo-600" />
          <h2 className="text-lg font-black text-slate-900">Ayuda y reglas de la app</h2>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { onClose(); onRestartTour(); }} className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-black text-white hover:bg-indigo-500"><PlayCircle className="h-4 w-4" />Repetir el recorrido</button>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Cerrar"><X className="h-4 w-4" /></button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Glosario y reglas de negocio</p>
        <dl className="mt-2 divide-y divide-slate-100">
          {GLOSSARY.map(entry => (
            <div key={entry.term} className="py-3">
              <dt className="text-sm font-black text-slate-900">{entry.term}</dt>
              <dd className="mt-1 text-[13px] leading-relaxed text-slate-600">{entry.text}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-slate-400"><Keyboard className="h-3.5 w-3.5" />Atajos</p>
        <dl className="mt-2 space-y-1.5">
          {SHORTCUTS.map(s => (
            <div key={s.term} className="flex items-center gap-3 text-[13px]"><dt className="min-w-[96px] rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-center font-mono text-xs font-black text-slate-700">{s.term}</dt><dd className="text-slate-600">{s.text}</dd></div>
          ))}
        </dl>
      </div>
    </section>
  </div>
);

export default HelpCenter;
