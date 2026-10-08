import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Pin, Sparkles, X } from 'lucide-react';
import { db } from '../../db/index';
import { favoritesDefaultKey, indicatorKey } from '../../lib/indicatorInsights';
import { FAVORITE_PRESETS, INDICATOR_GROUPS, ONBOARDING_VERSION, TOUR_STEPS, applyPreset, onboardingKey, type OnboardingRecord, type TourRoute } from '../../lib/onboarding';

interface Props {
  userId: string;
  userName: string;
  initialFavorites?: string[];
  onNavigate: (route: TourRoute) => void;
  onClose: () => void;
}

interface Rect { top: number; left: number; width: number; height: number }
const PAD = 8;

const OnboardingTour: React.FC<Props> = ({ userId, userName, initialFavorites = [], onNavigate, onClose }) => {
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<string[]>(initialFavorites);
  const [rect, setRect] = useState<Rect | null>(null);
  const [saving, setSaving] = useState(false);
  const step = TOUR_STEPS[index];
  const last = index === TOUR_STEPS.length - 1;

  const persist = useCallback(async (record: OnboardingRecord) => {
    setSaving(true);
    try {
      await db.setOrgSetting(userId, onboardingKey(userId), record);
    } catch { /* the tour must never block the app */ }
    setSaving(false);
  }, [userId]);

  const saveFavorites = useCallback(async () => {
    const keys = picked.map(name => indicatorKey({ name }));
    try { localStorage.setItem(favoritesDefaultKey(userId), JSON.stringify(keys)); } catch { /* storage blocked */ }
    try { await db.setOrgSetting(userId, favoritesDefaultKey(userId), keys); } catch { /* local default still applies */ }
  }, [picked, userId]);

  const finish = useCallback(async (skipped: boolean) => {
    if (!skipped && picked.length) await saveFavorites();
    await persist({ version: ONBOARDING_VERSION, ...(skipped ? { skippedAt: new Date().toISOString() } : { completedAt: new Date().toISOString() }), favorites: picked });
    onClose();
  }, [onClose, persist, picked, saveFavorites]);

  const go = useCallback((next: number) => {
    const target = Math.min(Math.max(next, 0), TOUR_STEPS.length - 1);
    if (TOUR_STEPS[index].kind === 'favorites' && next > index && picked.length) void saveFavorites();
    setIndex(target);
  }, [index, picked.length, saveFavorites]);

  useEffect(() => { if (step.route) onNavigate(step.route); }, [step.route]); // eslint-disable-line react-hooks/exhaustive-deps

  // Highlight the real element of the step. Sidebar items can sit below the fold of the menu's own scroll area, so scroll
  // them into view first; if they are still clipped by an ancestor, drop the highlight and center the card instead.
  const clippedByAncestor = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(`${o.overflowY} ${o.overflowX}`)) {
        const pr = p.getBoundingClientRect();
        if (r.top < pr.top - 1 || r.bottom > pr.bottom + 1 || r.left < pr.left - 1 || r.right > pr.right + 1) return true;
      }
    }
    return r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth;
  };
  const measure = useCallback(() => {
    if (!step.target) { setRect(null); return; }
    const el = document.querySelector(`[data-tour="${step.target}"]`) as HTMLElement | null;
    if (!el) { setRect(null); return; }
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    if (clippedByAncestor(el)) { setRect(null); return; }
    const r = el.getBoundingClientRect();
    setRect({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 });
  }, [step.target]);
  useLayoutEffect(() => {
    measure();
    const timers = [120, 400, 900].map(ms => window.setTimeout(measure, ms)); // the screen behind (lazy route) settles later
    window.addEventListener('resize', measure);
    return () => { timers.forEach(window.clearTimeout); window.removeEventListener('resize', measure); };
  }, [measure]);

  // Position the card with its REAL height so it never falls off the bottom of the window.
  const cardRef = useRef<HTMLElement | null>(null);
  const [cardH, setCardH] = useState(360);
  useLayoutEffect(() => { if (cardRef.current) setCardH(cardRef.current.offsetHeight); }, [index, picked.length, rect]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.tagName === 'INPUT';
      if (e.key === 'ArrowRight' && !typing) { e.preventDefault(); last ? void finish(false) : go(index + 1); }
      if (e.key === 'ArrowLeft' && !typing) { e.preventDefault(); go(index - 1); }
      if (e.key === 'Escape') void finish(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finish, go, index, last]);

  const cardStyle = useMemo<React.CSSProperties>(() => {
    const width = step.kind === 'favorites' ? 640 : 420;
    if (!rect) return { left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: `min(${width}px, calc(100vw - 2rem))` };
    const viewportW = window.innerWidth; const viewportH = window.innerHeight;
    const fitsRight = rect.left + rect.width + 16 + width < viewportW;
    const left = fitsRight ? rect.left + rect.width + 16 : Math.max(16, rect.left - width - 16);
    const top = Math.min(Math.max(16, rect.top), Math.max(16, viewportH - cardH - 16));
    return { left, top, width: `min(${width}px, calc(100vw - 2rem))` };
  }, [rect, step.kind, cardH]);

  const toggle = (name: string) => setPicked(prev => (prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]));

  return (
    <div className="print:hidden fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label="Recorrido de bienvenida">
      {rect ? (
        <div className="pointer-events-none absolute rounded-2xl ring-2 ring-indigo-400 transition-all" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height, boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.62)' }} />
      ) : (
        <div className="absolute inset-0 bg-slate-900/60" />
      )}

      <section ref={cardRef} className="absolute max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl" style={cardStyle}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-indigo-600">
            <Sparkles className="h-3.5 w-3.5" /> Paso {index + 1} de {TOUR_STEPS.length}
          </div>
          <button onClick={() => void finish(true)} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Saltar el recorrido (puedes repetirlo desde Ayuda y tour)"><X className="h-4 w-4" /></button>
        </div>

        <h2 className="mt-2 text-xl font-black leading-tight text-slate-900">{index === 0 ? `Hola, ${userName.split(' ')[0] || 'analista'}. ` : ''}{step.title}</h2>
        <p className="mt-1.5 text-sm font-semibold text-slate-600">{step.lead}</p>
        <ul className="mt-3 space-y-2">
          {step.bullets.map(b => (
            <li key={b} className="flex gap-2 text-[13px] leading-relaxed text-slate-700"><span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-indigo-400" />{b}</li>
          ))}
        </ul>

        {step.kind === 'favorites' && (
          <div className="mt-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Selección sugerida</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {FAVORITE_PRESETS.map(p => (
                <button key={p.id} onClick={() => setPicked(applyPreset(p.id))} title={p.hint} className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-[11px] font-black text-indigo-700 hover:bg-indigo-100">{p.label}</button>
              ))}
              {picked.length > 0 && <button onClick={() => setPicked([])} className="rounded-full border border-slate-200 px-3 py-1.5 text-[11px] font-black text-slate-500 hover:bg-slate-50">Limpiar</button>}
            </div>
            <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
              {INDICATOR_GROUPS.map(group => (
                <div key={group.title}>
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{group.title}</p>
                  <div className="mt-1.5 space-y-1">
                    {group.items.map(name => {
                      const on = picked.includes(name);
                      return (
                        <button key={name} type="button" onClick={() => toggle(name)} aria-pressed={on} className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs font-bold transition-colors ${on ? 'border-indigo-300 bg-indigo-50 text-indigo-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                          <Pin className={`h-3.5 w-3.5 flex-shrink-0 ${on ? 'fill-current text-indigo-600' : 'text-slate-300'}`} />{name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] font-semibold text-slate-400">{picked.length ? `${picked.length} seleccionado${picked.length === 1 ? '' : 's'}.` : 'Puedes continuar sin elegir y marcarlos después con el pin.'}</p>
          </div>
        )}

        <div className="mt-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            {TOUR_STEPS.map((s, i) => <button key={s.id} onClick={() => go(i)} aria-label={`Ir al paso ${i + 1}`} className={`h-1.5 rounded-full transition-all ${i === index ? 'w-5 bg-indigo-600' : 'w-1.5 bg-slate-300 hover:bg-slate-400'}`} />)}
          </div>
          <div className="flex items-center gap-2">
            {index > 0 && <button onClick={() => go(index - 1)} className="flex items-center gap-1 rounded-xl border border-slate-200 px-3 py-2 text-xs font-black text-slate-600 hover:bg-slate-50"><ChevronLeft className="h-3.5 w-3.5" />Anterior</button>}
            {last
              ? <button onClick={() => void finish(false)} disabled={saving} className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white hover:bg-indigo-500 disabled:opacity-60"><Check className="h-3.5 w-3.5" />Terminar</button>
              : <button onClick={() => go(index + 1)} className="flex items-center gap-1 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white hover:bg-indigo-500">Siguiente<ChevronRight className="h-3.5 w-3.5" /></button>}
          </div>
        </div>
        <button onClick={() => void finish(true)} className="mt-3 text-[11px] font-bold text-slate-400 hover:text-slate-600">Saltar recorrido</button>
      </section>
    </div>
  );
};

export default OnboardingTour;
