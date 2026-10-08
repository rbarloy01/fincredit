import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Copy, Eraser, Minus, Send, X } from 'lucide-react';
import { db, Client, Covenant_DB, FinancialStatement_DB, LoanTape_DB, Transaction } from '../../db/index';
import { AISettings, askClientAssistant } from '../../services/ai';
import { ASSISTANT_SYSTEM_PROMPT, buildClientContext, buildPortfolioContext } from '../../lib/clientContext';
import { ALL_SYSTEM_PROMPT, BENCHMARK_SYSTEM_PROMPT, buildBenchmarkContext, type BenchmarkInput } from '../../lib/benchmarkContext';
import { assessStatementQuality, QUALITY_SETTING_KEY, usableStatements, type StatementQuality, type StatementQualityRecord } from '../../lib/statementQuality';
import { loadExportModule } from '../../lib/exportLoader';
import MarkdownText from '../common/MarkdownText';

// Global assistant: a floating panel available on every screen. It can be opened and closed at will (button or ⌘/Ctrl+J),
// keeps its conversation per scope, and follows the client you are looking at (or answers about the whole portfolio).

interface Props {
  aiSettings: AISettings;
  currentClientId: string | null;      // client open in the app right now, if any
}

interface Msg { role: 'user' | 'assistant'; content: string }
interface ClientData {
  statements: FinancialStatement_DB[]; covenants: Covenant_DB[]; transactions: Transaction[]; loanTapes: LoanTape_DB[];
  qualityRecords: Record<string, StatementQualityRecord>; groupOverrides: Record<string, string>;
  qualityByStatement: Record<string, StatementQuality>; loadedAt: number;
}

const ALL = 'all';              // everything: client master data + benchmark
const BENCHMARK = 'benchmark';  // how clients compare with each other
const isGlobalScope = (scope: string) => scope === ALL || scope === BENCHMARK;
const OPEN_KEY = 'finmonitor_assistant_open';
const CHATS_KEY = 'finmonitor_assistant_chats';
const CACHE_MS = 2 * 60 * 1000;

const SUGGESTIONS_BENCHMARK = ['¿Cómo está el ICAP de cada cliente contra la mediana de la muestra?', '¿Qué clientes están por debajo del cuartil 25 en ROA?', '¿Quiénes tienen más apalancamiento que el resto y cuánto?', '¿Cómo se comparan las industrias entre sí?'];
const SUGGESTIONS_ALL = ['¿Cuáles son los clientes que más atención requieren hoy y por qué?', '¿Quién está peor ubicado contra el benchmark y de qué clientes tiene más línea?'];
const SUGGESTIONS_FICHA = ['¿Qué clientes están en monitoreo y cuáles dormidos o terminados?', '¿Cuáles son los 5 clientes con mayor línea y qué analista los lleva?', '¿Cuánta línea tengo por industria?'];
const SUGGESTIONS_FS = ['¿Cómo evolucionó el ROA y el ROE entre los últimos periodos y por qué?', '¿Qué tan confiables son los estados financieros cargados?', '¿Cuál es el nivel de apalancamiento y capitalización?'];
const SUGGESTIONS_LT = ['¿Por qué la cartera vigente es tan alta y cuánta está realmente al corriente?', '¿Dónde está la mayor concentración: por cliente, por grupo económico o por producto?', '¿Qué créditos me preocupan más y por qué?', '¿Qué análisis del loan tape no se pudo hacer por datos faltantes?'];

const safe = {
  get(key: string): string | null { try { return window.localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string) { try { window.localStorage.setItem(key, value); } catch { /* storage blocked */ } },
  getSession(key: string): string | null { try { return window.sessionStorage.getItem(key); } catch { return null; } },
  setSession(key: string, value: string) { try { window.sessionStorage.setItem(key, value); } catch { /* storage blocked */ } },
};

function loadChats(): Record<string, Msg[]> {
  try { return JSON.parse(safe.getSession(CHATS_KEY) || '{}') || {}; } catch { return {}; }
}

const AssistantDock: React.FC<Props> = ({ aiSettings, currentClientId }) => {
  const [open, setOpen] = useState(() => safe.get(OPEN_KEY) === '1');
  const [scope, setScope] = useState<string>(currentClientId || ALL);
  const [manualScope, setManualScope] = useState(false);
  const [clients, setClients] = useState<Client[]>([]);
  const [data, setData] = useState<Record<string, ClientData>>({});
  const [chats, setChats] = useState<Record<string, Msg[]>>(loadChats);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showContext, setShowContext] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inflight = useRef<Set<string>>(new Set());

  const setOpenPersist = useCallback((next: boolean | ((v: boolean) => boolean)) => {
    setOpen(prev => { const v = typeof next === 'function' ? next(prev) : next; safe.set(OPEN_KEY, v ? '1' : '0'); return v; });
  }, []);

  // ⌘/Ctrl + J toggles the panel from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); setOpenPersist(v => !v); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpenPersist]);

  // Follow the client being viewed, unless the user picked a scope by hand.
  useEffect(() => {
    if (currentClientId) { setScope(currentClientId); setManualScope(false); }
    else if (!manualScope) setScope(ALL);
  }, [currentClientId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || clients.length) return;
    let active = true;
    db.getClients().then(list => { if (active) setClients(list); }).catch(() => undefined);
    return () => { active = false; };
  }, [open, clients.length]);

  const [bench, setBench] = useState<{ inputs: BenchmarkInput[]; loadedAt: number } | null>(null);
  const [benchLoading, setBenchLoading] = useState(false);
  const benchInflight = useRef(false);

  // Benchmark needs every client's statements: load them only when a global scope is open, and keep them for a few minutes.
  useEffect(() => {
    if (!open || !isGlobalScope(scope) || !clients.length) return;
    if (bench && Date.now() - bench.loadedAt < 5 * 60 * 1000) return;
    if (benchInflight.current) return;
    benchInflight.current = true;
    setBenchLoading(true);
    let active = true;
    db.getStatementsForClients(clients.map(c => c.id))
      .then(byClient => { if (active) setBench({ inputs: clients.map(c => ({ client: c, statements: byClient[c.id] || [] })), loadedAt: Date.now() }); })
      .catch(err => { if (active) setError(err?.message || 'No se pudo cargar la información para el benchmark.'); })
      .finally(() => { benchInflight.current = false; if (active) setBenchLoading(false); });
    return () => { active = false; benchInflight.current = false; setBenchLoading(false); };
  }, [open, scope, clients]); // eslint-disable-line react-hooks/exhaustive-deps

  const client = useMemo(() => clients.find(c => c.id === scope) || null, [clients, scope]);

  // Load the client's data only while the panel is open (it can be heavy), with a short cache.
  useEffect(() => {
    if (!open || isGlobalScope(scope)) return;
    const cached = data[scope];
    if (cached && Date.now() - cached.loadedAt < CACHE_MS) return;
    if (inflight.current.has(scope)) return;
    inflight.current.add(scope);
    setLoading(true);
    let active = true;
    (async () => {
      const [statements, covenants, transactions, loanTapes, qualityRecords, groupOverrides] = await Promise.all([
        db.getStatements(scope), db.getCovenants(scope), db.getTransactions(scope), db.getLoanTapesForDetail(scope),
        db.getClientSetting<Record<string, StatementQualityRecord>>(scope, QUALITY_SETTING_KEY, {}),
        db.getClientSetting<Record<string, string>>(scope, 'loan_tape_group_overrides', {}),
      ]);
      const usable = usableStatements(statements, qualityRecords || {});
      const qualityByStatement: Record<string, StatementQuality> = {};
      try {
        const mod = await loadExportModule();
        const sorted = [...usable].sort((a, b) => a.periodDate.localeCompare(b.periodDate));
        sorted.slice(-4).forEach(stmt => { qualityByStatement[stmt.id] = assessStatementQuality(stmt, sorted.filter(o => o.id !== stmt.id), mod.computeStatementReconciliation(stmt)); });
      } catch { /* quality notes are optional context */ }
      if (active) setData(prev => ({ ...prev, [scope]: { statements, covenants, transactions, loanTapes, qualityRecords: qualityRecords || {}, groupOverrides: groupOverrides || {}, qualityByStatement, loadedAt: Date.now() } }));
    })().catch(err => { if (active) setError(err?.message || 'No se pudo cargar la información del cliente.'); })
      .finally(() => { inflight.current.delete(scope); if (active) setLoading(false); });
    return () => { active = false; inflight.current.delete(scope); setLoading(false); };
  }, [open, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  const clientData = isGlobalScope(scope) ? null : data[scope] || null;
  const pack = useMemo(() => {
    if (scope === BENCHMARK) return bench ? buildBenchmarkContext(bench.inputs) : null;
    if (scope === ALL) {
      if (!clients.length || !bench) return null;
      const ficha = buildPortfolioContext(clients);
      const benchmark = buildBenchmarkContext(bench.inputs);
      const text = `${ficha.text}\n\n══ BENCHMARK ENTRE CLIENTES ══\n${benchmark.text}`;
      return { text, approxTokens: Math.ceil(text.length / 3.6), sections: [...ficha.sections, ...benchmark.sections], notes: [...ficha.notes, ...benchmark.notes] };
    }
    if (!client || !clientData) return null;
    const analysis = usableStatements<FinancialStatement_DB>(clientData.statements, clientData.qualityRecords);
    return buildClientContext({
      client, statements: analysis, allStatementsCount: clientData.statements.length, qualityRecords: clientData.qualityRecords,
      qualityByStatement: clientData.qualityByStatement, covenants: clientData.covenants, transactions: clientData.transactions,
      loanTapes: clientData.loanTapes, groupOverrides: clientData.groupOverrides,
    });
  }, [scope, clients, client, clientData, bench]);

  const messages = chats[scope] || [];
  const updateChat = (key: string, fn: (m: Msg[]) => Msg[]) => setChats(prev => {
    const next = { ...prev, [key]: fn(prev[key] || []).slice(-40) };
    safe.setSession(CHATS_KEY, JSON.stringify(next));
    return next;
  });

  useEffect(() => { if (open) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages.length, busy, open, scope]);

  const suggestions = scope === BENCHMARK
    ? SUGGESTIONS_BENCHMARK
    : scope === ALL
      ? [...SUGGESTIONS_ALL, ...SUGGESTIONS_FICHA]
      : [...(clientData?.statements.length ? SUGGESTIONS_FS : []), ...(clientData?.loanTapes.length ? SUGGESTIONS_LT : [])].slice(0, 5);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy || !pack) return;
    const key = scope;
    setError(''); setInput('');
    const history = messages;
    updateChat(key, m => [...m, { role: 'user', content: q }]);
    setBusy(true);
    try {
      const global = isGlobalScope(key);
      const system = key === BENCHMARK ? BENCHMARK_SYSTEM_PROMPT : key === ALL ? ALL_SYSTEM_PROMPT : ASSISTANT_SYSTEM_PROMPT;
      const answer = await askClientAssistant(aiSettings, system, pack.text, history, q, global ? 'CONTEXTO' : 'CONTEXTO DEL CLIENTE');
      updateChat(key, m => [...m, { role: 'assistant', content: answer.trim() }]);
    } catch (err: any) {
      setError(err?.message || 'No se pudo obtener respuesta. Revisa la configuración de IA (Configuración → tarea "Asistente").');
    } finally {
      setBusy(false);
    }
  };

  const scopeName = scope === ALL ? 'Todo: cartera y benchmark' : scope === BENCHMARK ? 'Benchmark entre clientes' : client?.name || 'Cliente';

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpenPersist(true)}
          data-tour="assistant"
          title="Abrir asistente IA (⌘/Ctrl+J)"
          className="print:hidden fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-3 text-sm font-black text-white shadow-xl shadow-indigo-300/40 hover:bg-indigo-500"
        >
          <Bot className="h-5 w-5" />
          <span className="hidden sm:inline">Asistente IA</span>
          {messages.length > 0 && <span className="rounded-full bg-white/25 px-1.5 text-[10px]">{messages.length}</span>}
        </button>
      )}

      {open && (
        <section
          role="dialog"
          aria-label="Asistente IA"
          className="print:hidden fixed bottom-5 right-5 z-40 flex h-[min(640px,calc(100vh-2.5rem))] w-[min(440px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/20"
        >
          <header className="flex items-center gap-2 border-b border-slate-200 bg-indigo-600 px-4 py-3 text-white">
            <Bot className="h-5 w-5 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-black leading-tight">Asistente IA</p>
              <p className="truncate text-[11px] font-semibold text-indigo-100">{scopeName}</p>
            </div>
            {messages.length > 0 && (
              <button onClick={() => { updateChat(scope, () => []); setError(''); }} title="Limpiar conversación" className="rounded-lg p-1.5 hover:bg-white/15"><Eraser className="h-4 w-4" /></button>
            )}
            <button onClick={() => setOpenPersist(false)} title="Minimizar (la conversación se conserva)" className="rounded-lg p-1.5 hover:bg-white/15"><Minus className="h-4 w-4" /></button>
            <button onClick={() => setOpenPersist(false)} title="Cerrar" className="rounded-lg p-1.5 hover:bg-white/15"><X className="h-4 w-4" /></button>
          </header>

          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2">
            <label htmlFor="assistant-scope" className="text-[10px] font-black uppercase tracking-widest text-slate-400">Sobre</label>
            <select
              id="assistant-scope"
              value={scope}
              onChange={e => { setScope(e.target.value); setManualScope(true); setError(''); setShowContext(false); }}
              className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-indigo-200"
            >
              <option value={ALL}>Todo (cartera + benchmark)</option>
              <option value={BENCHMARK}>Benchmark (clientes entre sí)</option>
              <option disabled>──────────</option>
              {[...clients].sort((a, b) => a.name.localeCompare(b.name)).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {pack && <button onClick={() => setShowContext(v => !v)} className="whitespace-nowrap rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-black text-slate-500 hover:bg-slate-50">{showContext ? 'Ocultar' : 'Contexto'}</button>}
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {pack && (
              <p className="text-[10px] font-semibold leading-snug text-slate-400">
                Responde solo con lo que la app ya calculó · contexto ≈ {pack.approxTokens.toLocaleString('es-MX')} tokens, enviado al proveedor de IA configurado.
                {pack.notes.length > 0 && <> {pack.notes.join(' ')}</>}
              </p>
            )}
            {showContext && pack && <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-[10px] leading-relaxed text-slate-700">{pack.text}</pre>}
            {!pack && <p className="text-xs font-bold text-slate-400">{isGlobalScope(scope) ? (benchLoading || clients.length ? 'Preparando el benchmark de todos los clientes…' : 'Cargando clientes…') : 'Cargando información del cliente…'}</p>}

            {pack && messages.length === 0 && (
              <div>
                <p className="text-xs font-bold text-slate-500">Pregunta lo que necesites. Algunas ideas:</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {suggestions.map(q => <button key={q} onClick={() => void ask(q)} disabled={busy} className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-left text-[11px] font-bold text-indigo-700 hover:bg-indigo-100 disabled:opacity-50">{q}</button>)}
                  {suggestions.length === 0 && <p className="text-xs font-semibold text-slate-400">Este cliente aún no tiene estados financieros ni loan tapes cargados.</p>}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`min-w-0 max-w-[92%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${m.role === 'user' ? 'whitespace-pre-wrap bg-indigo-600 text-white' : 'bg-slate-100 text-slate-800'}`}>
                  {m.role === 'assistant' ? <MarkdownText text={m.content} /> : m.content}
                  {m.role === 'assistant' && <button onClick={() => void navigator.clipboard?.writeText(m.content)} className="mt-1.5 flex items-center gap-1 text-[10px] font-bold text-slate-400 hover:text-slate-700" title="Copiar respuesta"><Copy className="h-3 w-3" />Copiar</button>}
                </div>
              </div>
            ))}
            {busy && <p className="text-xs font-bold text-slate-400">Analizando…</p>}
            {error && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{error}</p>}
            <div ref={endRef} />
          </div>

          <form onSubmit={e => { e.preventDefault(); void ask(input); }} className="flex gap-2 border-t border-slate-200 p-3">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(input); } }}
              rows={2}
              placeholder={scope === BENCHMARK ? 'Ej. ¿Qué clientes están por debajo de la mediana en ICAP?' : scope === ALL ? 'Ej. ¿Qué clientes requieren más atención?' : 'Ej. ¿Qué pasó con la cartera vencida entre los dos últimos cortes?'}
              className="min-w-0 flex-1 resize-none rounded-xl border border-slate-300 bg-white px-3 py-2 text-[13px] font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-indigo-200"
            />
            <button type="submit" disabled={busy || !input.trim() || !pack} title="Enviar" className="flex items-center justify-center rounded-xl bg-indigo-600 px-3.5 text-white hover:bg-indigo-500 disabled:opacity-50"><Send className="h-4 w-4" /></button>
          </form>
        </section>
      )}
    </>
  );
};

export default AssistantDock;
