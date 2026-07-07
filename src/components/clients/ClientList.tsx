import React, { useState, useEffect, useMemo } from 'react';
import { db, Client } from '../../db/index';
import { Session } from '../../services/auth';
import { Plus, Search, Building2, Hash, Briefcase, TrendingUp, ChevronRight, AlertTriangle, FileClock, CalendarClock, Trash2 } from 'lucide-react';
import { evaluateCovenantAuto } from '../../lib/financialMetrics';
import WorkingOverlay from '../common/WorkingOverlay';

interface Props {
  session: Session;
  onSelectClient: (clientId: string) => void;
  onNewClient: () => void;
}

function scoreBadgeClass(score: string) {
  const value = Number(score);
  if (!Number.isFinite(value)) return 'bg-slate-100 text-slate-600 border-slate-200';
  if (value >= 80) return 'bg-emerald-100 text-emerald-800 border-emerald-200';
  if (value >= 60) return 'bg-blue-100 text-blue-800 border-blue-200';
  if (value >= 40) return 'bg-amber-100 text-amber-800 border-amber-200';
  if (value >= 20) return 'bg-orange-100 text-orange-800 border-orange-200';
  return 'bg-rose-100 text-rose-800 border-rose-200';
}

function fmtCurrency(value: number, currency: string): string {
  const prefix = currency === 'MXN' ? '$' : currency === 'USD' ? 'USD ' : '€';
  if (value >= 1_000_000) return `${prefix}${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${prefix}${(value / 1_000).toFixed(1)}K`;
  return `${prefix}${value.toLocaleString('es-MX')}`;
}

const ClientList: React.FC<Props> = ({ session, onSelectClient, onNewClient }) => {
  const [clients, setClients] = useState<Client[]>([]);
  const [watch, setWatch] = useState({ breaches: 0, overdueDocs: 0, missingTapes: 0, maturities: 0 });
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadClients = async () => {
    setLoading(true);
    try {
      const list = await db.getClients();
      setClients(list);
    } catch (err) {
      console.error('Error loading clients:', err);
      setClients([]);
      setWatch({ breaches: 0, overdueDocs: 0, missingTapes: 0, maturities: 0 });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadClients(); }, []);

  useEffect(() => {
    let cancelled = false;
    if (clients.length === 0) {
      setWatch({ breaches: 0, overdueDocs: 0, missingTapes: 0, maturities: 0 });
      return () => { cancelled = true; };
    }

    const loadWatch = async () => {
      try {
        const rows = await Promise.all(clients.map(async client => {
          const [statements, covenants, tapes] = await Promise.all([
            db.getStatements(client.id),
            db.getCovenants(client.id),
            db.getLoanTapes(client.id),
          ]);
          const breaches = covenants.filter(c => evaluateCovenantAuto(c, statements).status === 'incumple').length;
          const latestStmt = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate)).at(-1);
          const daysNoFinancials = latestStmt ? (Date.now() - new Date(latestStmt.periodDate).getTime()) / 86400000 : Infinity;
          const overdueDocs = daysNoFinancials > 45 ? 1 : 0;
          const missingTapes = tapes.length === 0 ? 1 : 0;
          return { breaches, overdueDocs, missingTapes };
        }));

        if (cancelled) return;
        setWatch({
          breaches: rows.reduce((s, r) => s + r.breaches, 0),
          overdueDocs: rows.reduce((s, r) => s + r.overdueDocs, 0),
          missingTapes: rows.reduce((s, r) => s + r.missingTapes, 0),
          maturities: 0,
        });
      } catch (err) {
        if (!cancelled) console.error('Error loading portfolio indicators:', err);
      }
    };

    void loadWatch();
    return () => { cancelled = true; };
  }, [clients]);

  const handleDeleteClient = async (client: Client) => {
    if (session.role !== 'manager') return;
    if (!confirm(`¿Eliminar cliente "${client.name}" y toda su información cargada?`)) return;
    setDeletingId(client.id);
    try {
      await db.deleteClient(client.id);
      await loadClients();
    } catch (err: any) {
      alert(`Error al eliminar cliente: ${err.message}`);
    } finally {
      setDeletingId(null);
    }
  };

  const filtered = useMemo(() => clients.filter(c => {
    const q = search.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      (c.taxId || '').toLowerCase().includes(q) ||
      c.industry.toLowerCase().includes(q) ||
      c.analystName.toLowerCase().includes(q)
    );
  }), [clients, search]);

  const totalCredit = clients.reduce((s, c) => s + (c.totalCreditValue || 0), 0);
  const hasAlerts = watch.breaches + watch.overdueDocs + watch.missingTapes > 0;

  return (
    <div className="portfolio-page flex-1 min-h-screen px-5 py-6 sm:px-8 lg:px-10">
      <WorkingOverlay
        show={!!deletingId}
        title="Eliminando cliente"
        messages={['Almost there...', 'Working on it...', 'Borrando documentos ligados...', 'Limpiando covenants...', 'Actualizando portafolio...']}
      />
      {/* Header */}
      <div className="portfolio-hero mb-7 overflow-hidden rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm sm:p-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-indigo-700">
              <span className={`h-2 w-2 rounded-full ${hasAlerts ? 'bg-amber-500' : 'bg-emerald-500'}`} />
              {hasAlerts ? 'Revisión requerida' : 'Portafolio estable'}
            </div>
            <h1 className="text-3xl font-black tracking-tight text-slate-900 sm:text-4xl">Portafolio de Clientes</h1>
            <p className="mt-2 max-w-2xl text-sm font-semibold leading-6 text-slate-500">
              {clients.length} cliente{clients.length !== 1 ? 's' : ''} registrado{clients.length !== 1 ? 's' : ''}, con alertas, documentos y exposición listos para revisión.
            </p>
          </div>
          {session.role === 'manager' && (
            <button
              onClick={onNewClient}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-5 py-3 text-sm font-black text-white shadow-lg shadow-indigo-200 transition-all hover:bg-indigo-500 sm:w-auto"
            >
              <Plus className="w-4 h-4" />
              Nuevo Cliente
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 mb-6 sm:grid-cols-2 xl:grid-cols-4">
        <div className="stat-card bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-xs font-black text-slate-400 uppercase tracking-wider">Portafolio monitoreado</p>
          <p className="text-2xl font-black text-slate-900 mt-1">{fmtCurrency(totalCredit, 'MXN')}</p>
        </div>
        <div className="stat-card bg-white border border-rose-200 rounded-2xl p-4">
          <p className="text-xs font-black text-rose-500 uppercase tracking-wider flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" />Breaches hoy</p>
          <p className="text-2xl font-black text-rose-700 mt-1">{watch.breaches}</p>
        </div>
        <div className="stat-card bg-white border border-amber-200 rounded-2xl p-4">
          <p className="text-xs font-black text-amber-600 uppercase tracking-wider flex items-center gap-1"><FileClock className="w-3.5 h-3.5" />EFF vencidos</p>
          <p className="text-2xl font-black text-amber-700 mt-1">{watch.overdueDocs}</p>
        </div>
        <div className="stat-card bg-white border border-indigo-200 rounded-2xl p-4">
          <p className="text-xs font-black text-indigo-600 uppercase tracking-wider flex items-center gap-1"><CalendarClock className="w-3.5 h-3.5" />Loan tape faltante</p>
          <p className="text-2xl font-black text-indigo-700 mt-1">{watch.missingTapes}</p>
        </div>
      </div>

      {/* Search */}
      <div className="relative mb-6">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar por nombre, RFC, industria o analista..."
          className="w-full bg-white border border-slate-200 text-slate-900 placeholder-slate-400 rounded-2xl pl-11 pr-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-all shadow-sm"
        />
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-24">
          <svg className="animate-spin h-8 w-8 text-indigo-500" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        </div>
      )}

      {/* Empty state */}
      {!loading && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Building2 className="w-12 h-12 text-slate-300 mb-4" />
          {search ? (
            <>
              <p className="text-slate-500 font-semibold">No se encontraron clientes</p>
              <p className="text-slate-400 text-sm mt-1">Intenta con otro término de búsqueda</p>
            </>
          ) : (
            <>
              <p className="text-slate-500 font-semibold">Sin clientes registrados</p>
              {session.role === 'manager' && (
                <button
                  onClick={onNewClient}
                  className="mt-4 flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-5 py-3 rounded-xl text-sm transition-all"
                >
                  <Plus className="w-4 h-4" />
                  Crear primer cliente
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* Grid */}
      {!loading && filtered.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-5">
          {filtered.map(client => (
            <div
              key={client.id}
              onClick={() => onSelectClient(client.id)}
              className="client-card bg-white border border-slate-200 rounded-2xl p-6 text-left hover:border-indigo-300 hover:shadow-lg hover:shadow-indigo-50 transition-all group cursor-pointer"
            >
              {/* Top row */}
              <div className="flex items-start justify-between mb-4">
                <div className="w-11 h-11 bg-indigo-100 rounded-2xl flex items-center justify-center">
                  <Building2 className="w-5 h-5 text-indigo-600" />
                </div>
                <div className="flex items-center gap-2">
                  {client.score && (
                    <span className={`text-xs font-black px-2.5 py-1 rounded-lg border ${scoreBadgeClass(client.score)}`}>
                      {client.score}/100
                    </span>
                  )}
                  <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-indigo-500 transition-colors" />
                </div>
              </div>

              {/* Name */}
              <h3 className="font-black text-slate-900 text-lg leading-tight mb-1 truncate">{client.name}</h3>

              {/* Meta */}
              <div className="space-y-1.5 mt-3">
                <div className="flex items-center gap-2 text-slate-500 text-xs">
                  <Hash className="w-3 h-3 flex-shrink-0" />
                  <span className="font-mono">{client.taxId || 'Sin RFC'}</span>
                </div>
                <div className="flex items-center gap-2 text-slate-500 text-xs">
                  <Briefcase className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{client.industry}</span>
                </div>
                <div className="flex items-center gap-2 text-slate-500 text-xs">
                  <TrendingUp className="w-3 h-3 flex-shrink-0" />
                  <span className="font-semibold text-slate-700">
                    {fmtCurrency(client.totalCreditValue, client.currency)}
                  </span>
                  <span className="text-slate-400">línea total</span>
                </div>
              </div>

              {/* Bottom */}
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-100">
                <div className="flex gap-1">
                  {client.creditType?.slice(0, 3).map(ct => (
                    <span key={ct} className="text-[10px] bg-slate-100 text-slate-600 px-2 py-1 rounded-lg font-semibold">
                      {ct}
                    </span>
                  ))}
                </div>
                <span className="text-[10px] text-slate-400 font-medium">{client.analystName}</span>
              </div>
              {session.role === 'manager' && (
                <button
                  onClick={e => {
                    e.stopPropagation();
                    handleDeleteClient(client);
                  }}
                  disabled={deletingId === client.id}
                  className="mt-4 flex items-center gap-1.5 text-xs font-black text-slate-400 hover:text-rose-600 disabled:opacity-40"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Eliminar cliente
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ClientList;
