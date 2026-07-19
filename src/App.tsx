import React, { Component, Suspense, useState, useEffect, type ReactNode } from 'react';
import { auth, Session } from './services/auth';
import LoginPage from './components/auth/LoginPage';
import ClientList from './components/clients/ClientList';
import { Client, CustomField, db, RolloutGuardFeature, RolloutGuardResult } from './db/index';
import { AISettings, loadAISettings } from './services/ai';
import { Activity, AlertTriangle, BarChart3, Building2, ClipboardList, Inbox, Layers3, Settings, LogOut, RefreshCw, ShieldAlert, ShieldCheck, Moon, Sun, Sparkles } from 'lucide-react';
import { isSupabaseConfigured, supabaseConfigError } from './lib/supabase';
import { lazyWithChunkRetry, resetChunkRetryStateForCurrentBuild } from './lib/lazyWithChunkRetry';

const ClientForm = lazyWithChunkRetry(() => import('./components/clients/ClientForm'), 'client-form');
const ClientDetail = lazyWithChunkRetry(() => import('./components/clients/ClientDetail'), 'client-detail');
const SettingsPage = lazyWithChunkRetry(() => import('./components/settings/SettingsPage'), 'settings');
const BenchmarkingPage = lazyWithChunkRetry(() => import('./components/benchmarking/BenchmarkingPage'), 'benchmarking');
const AccountConsolidationPage = lazyWithChunkRetry(() => import('./components/consolidation/AccountConsolidationPage'), 'consolidation');
const IngestionInboxPage = lazyWithChunkRetry(() => import('./components/ingestion/IngestionInboxPage'), 'ingestion');
const LifecyclePage = lazyWithChunkRetry(() => import('./components/lifecycle/LifecyclePage'), 'lifecycle');
const CrmDashboardPage = lazyWithChunkRetry(() => import('./components/crm/CrmDashboardPage'), 'crm-dashboard');
const CompanyDefaultPage = lazyWithChunkRetry(() => import('./components/zscore/CompanyDefaultPage'), 'zscore');

type Route = 'clients' | 'client_new' | 'client_edit' | 'client_detail' | 'crm' | 'benchmarking' | 'consolidation' | 'lifecycle' | 'zscore' | 'ingestion' | 'settings';

resetChunkRetryStateForCurrentBuild();

const RouteFallback = () => (
  <div className="flex min-h-[60vh] items-center justify-center">
    <svg className="animate-spin h-8 w-8 text-indigo-500" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  </div>
);

const RolloutMigrationError: React.FC<{
  title: string;
  result: RolloutGuardResult;
  onRetry: () => void;
}> = ({ title, result, onRetry }) => (
  <div className="min-h-screen bg-slate-50 p-8">
    <div className="mx-auto max-w-3xl rounded-2xl border border-amber-200 bg-white p-6 shadow-sm">
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-black uppercase tracking-widest text-amber-600">Migraciones pendientes</p>
          <h1 className="mt-1 text-xl font-black text-slate-900">No se puede abrir {title}</h1>
          <p className="mt-2 text-sm font-semibold leading-6 text-slate-600">
            Supabase todavía no tiene todo el esquema que esta vista necesita. Aplica estos archivos SQL en orden y vuelve a cargar la app.
          </p>
          <div className="mt-5 space-y-3">
            {result.missing.map(item => (
              <div key={item.file} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="font-mono text-sm font-black text-slate-900">{item.file}</p>
                <p className="mt-1 text-xs font-semibold text-slate-500">{item.reason}</p>
              </div>
            ))}
          </div>
          <button
            onClick={onRetry}
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-black text-white hover:bg-amber-500"
          >
            <RefreshCw className="h-4 w-4" />
            Volver a verificar
          </button>
        </div>
      </div>
    </div>
  </div>
);

const RolloutGuardedRoute: React.FC<{
  feature: RolloutGuardFeature;
  title: string;
  children: ReactNode;
}> = ({ feature, title, children }) => {
  const [checking, setChecking] = useState(true);
  const [result, setResult] = useState<RolloutGuardResult>({ missing: [], unverified: [] });
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const check = async () => {
      setChecking(true);
      setError('');
      try {
        const next = await db.checkRolloutMigrations(feature);
        if (active) setResult(next);
      } catch (err: any) {
        if (active) setError(err.message || 'No se pudieron verificar las migraciones.');
      } finally {
        if (active) setChecking(false);
      }
    };
    void check();
    return () => { active = false; };
  }, [feature, attempt]);

  if (checking) return <RouteFallback />;

  if (error) {
    return (
      <div className="min-h-screen bg-slate-50 p-8">
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-rose-700">
          <p className="font-black">No se pudieron verificar las migraciones</p>
          <p className="mt-1 text-sm font-semibold">{error}</p>
          <button
            onClick={() => setAttempt(prev => prev + 1)}
            className="mt-4 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-black text-white hover:bg-rose-500"
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  if (result.missing.length) {
    return <RolloutMigrationError title={title} result={result} onRetry={() => setAttempt(prev => prev + 1)} />;
  }

  return <>{children}</>;
};

const MissingSupabaseConfig = () => (
  <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
    <div className="w-full max-w-lg rounded-3xl border border-amber-500/30 bg-slate-900 p-8 text-center shadow-2xl">
      <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500">
        <ShieldCheck className="h-7 w-7 text-white" />
      </div>
      <h1 className="text-2xl font-black tracking-tight text-white">FinMonitor necesita configuración</h1>
      <p className="mt-3 text-sm font-semibold leading-6 text-slate-300">
        {supabaseConfigError}
      </p>
      <div className="mt-6 rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-left font-mono text-xs text-slate-300">
        <p>VITE_SUPABASE_URL</p>
        <p>VITE_SUPABASE_ANON_KEY</p>
        <p>SUPABASE_URL</p>
        <p>SUPABASE_SERVICE_KEY</p>
      </div>
      <p className="mt-4 text-xs font-bold text-slate-500">
        Agrega estas variables en Vercel Project Settings y redeploy.
      </p>
    </div>
  </div>
);

class RouteErrorBoundary extends Component<
  { children: ReactNode; onReset: () => void },
  { error: Error | null }
> {
  declare props: { children: ReactNode; onReset: () => void };
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('Route render error:', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="m-8 rounded-2xl border border-rose-200 bg-rose-50 p-6">
        <h2 className="text-sm font-black uppercase tracking-widest text-rose-900">No se pudo mostrar esta vista</h2>
        <p className="mt-2 text-sm font-bold text-rose-700">{this.state.error.message || 'Error inesperado al renderizar.'}</p>
        <button
          onClick={this.props.onReset}
          className="mt-4 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-black text-white hover:bg-rose-500"
        >
          Volver a clientes
        </button>
      </div>
    );
  }
}

const App: React.FC = () => {
  const [session, setSession] = useState<Session | null>(null);
  const [route, setRoute] = useState<Route>('clients');
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [editingClient, setEditingClient] = useState<Client | undefined>(undefined);
  const [aiSettings, setAiSettings] = useState<AISettings>(loadAISettings);
  const [initializing, setInitializing] = useState(true);
  const [theme, setTheme] = useState<'day' | 'night'>(() => (localStorage.getItem('finmonitor_theme') as 'day' | 'night') || 'day');

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setInitializing(false);
      return;
    }

    let active = true;
    const initialize = async () => {
      try {
        await Promise.race([
          auth.createFirstUser(),
          new Promise<void>((_, reject) => {
            window.setTimeout(() => reject(new Error('Tiempo de espera agotado al restaurar la sesión')), 6000);
          }),
        ]);
      } catch (err) {
        console.error('Initialization error:', err);
      } finally {
        if (active) {
          setSession(auth.getSession());
          setInitializing(false);
        }
      }
    };
    initialize();
    return () => { active = false; };
  }, []);

  const handleLogin = (s: Session) => {
    setSession(s);
    setRoute('clients');
  };

  const handleLogout = () => {
    auth.logout();
    setSession(null);
    setRoute('clients');
  };

  const handleSelectClient = (clientId: string) => {
    setSelectedClientId(clientId);
    setRoute('client_detail');
  };

  const handleNewClient = () => {
    setEditingClient(undefined);
    setRoute('client_new');
  };

  const handleEditClient = (client: Client) => {
    setEditingClient(client);
    setSelectedClientId(client.id);
    setRoute('client_edit');
  };

  const handleSaveClient = async (client: Client, _customFields: CustomField[]) => {
    setSelectedClientId(client.id);
    setEditingClient(undefined);
    setRoute('client_detail');
  };

  const handleSettingsChange = (s: AISettings) => setAiSettings(s);

  const toggleTheme = () => {
    setTheme(prev => {
      const next = prev === 'day' ? 'night' : 'day';
      localStorage.setItem('finmonitor_theme', next);
      return next;
    });
  };

  if (!isSupabaseConfigured) return <MissingSupabaseConfig />;

  if (initializing) {
    return (
      <div className="bluebonnet-auth min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-indigo-500/30">
            <ShieldCheck className="w-8 h-8 text-white" />
          </div>
          <p className="text-slate-400 text-sm font-bold">Iniciando FinMonitor...</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return <LoginPage onLogin={handleLogin} />;
  }

  if (session.role === 'pending') {
    return (
      <div className="bluebonnet-auth min-h-screen bg-slate-950 flex items-center justify-center px-4">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-3xl p-10 text-center shadow-2xl">
          <div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-lg shadow-indigo-500/30">
            <ShieldCheck className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-black text-white tracking-tight">Acceso pendiente</h1>
          <p className="text-slate-400 text-sm mt-3 leading-6">
            Tu cuenta de Google ya fue registrada, pero un manager debe aprobar tu acceso antes de ver la información del sistema.
          </p>
          <div className="mt-6 rounded-2xl bg-slate-800 border border-slate-700 px-4 py-3">
            <p className="text-xs text-slate-500 font-bold uppercase tracking-widest">Cuenta</p>
            <p className="text-sm text-slate-200 font-bold mt-1 break-all">{session.userEmail}</p>
          </div>
          <button
            onClick={handleLogout}
            className="mt-6 w-full bg-white hover:bg-slate-100 text-slate-900 font-black py-3 rounded-xl text-sm shadow-lg"
          >
            Cerrar sesión
          </button>
        </div>
      </div>
    );
  }

  const navItems = [
    { id: 'clients' as Route, label: 'Clientes', icon: Building2 },
    { id: 'crm' as Route, label: 'CRM', icon: ClipboardList },
    { id: 'benchmarking' as Route, label: 'Benchmarking', icon: BarChart3 },
    { id: 'consolidation' as Route, label: 'Consolidación', icon: Layers3 },
    { id: 'lifecycle' as Route, label: 'Línea de vida', icon: Activity },
    { id: 'zscore' as Route, label: 'Z-Score', icon: ShieldAlert },
    ...(session.role === 'manager' ? [{ id: 'ingestion' as Route, label: 'Ingestion', icon: Inbox }] : []),
    ...(session.role === 'manager' ? [{ id: 'settings' as Route, label: 'Configuración', icon: Settings }] : []),
  ];
  const activeNavItem = navItems.find(item =>
    route === item.id ||
    (['client_detail', 'client_new', 'client_edit'].includes(route) && item.id === 'clients')
  );

  return (
    <div className={`finmonitor-shell theme-${theme} flex h-screen overflow-hidden`}>
      {/* Sidebar */}
      <aside className="app-sidebar w-[17.5rem] bg-white border-r border-slate-200 flex flex-col shadow-sm flex-shrink-0">
        {/* Logo */}
        <div className="p-6 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-md shadow-indigo-200">
              <ShieldCheck className="w-5 h-5 text-white" />
            </div>
            <div>
              <span className="text-xl font-black text-slate-900 tracking-tight">FinMonitor</span>
              <p className="text-[10px] text-indigo-600 font-black leading-none mt-1 uppercase tracking-widest">Credit OS</p>
            </div>
          </div>
          <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Workspace</p>
              <Sparkles className="h-3.5 w-3.5 text-indigo-600" />
            </div>
            <p className="mt-1 text-sm font-black text-slate-900">Monitoreo activo</p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-1.5 overflow-y-auto">
          {navItems.map(item => (
            <button
              key={item.id}
              onClick={() => setRoute(item.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-bold transition-all ${
                route === item.id || (route === 'client_detail' && item.id === 'clients') || (route === 'client_new' && item.id === 'clients') || (route === 'client_edit' && item.id === 'clients')
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200 translate-x-1'
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900 border border-transparent hover:border-indigo-100'
              }`}
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </button>
          ))}
        </nav>

        {/* User info */}
        <div className="p-4 border-t border-slate-100">
          <button
            onClick={toggleTheme}
            className="mb-3 w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-xs font-black bg-slate-50 text-slate-600 hover:bg-slate-100 transition-all border border-slate-100"
          >
            <span className="flex items-center gap-2">
              {theme === 'day' ? <Sun className="w-4 h-4 text-cyan-500" /> : <Moon className="w-4 h-4 text-indigo-300" />}
              {theme === 'day' ? 'Modo día' : 'Modo noche'}
            </span>
            <span className="text-[10px] uppercase tracking-widest">{theme === 'day' ? 'Light' : 'Dark'}</span>
          </button>
          <div className="bg-slate-50 rounded-2xl p-3 mb-3 border border-slate-100">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-indigo-200 rounded-full flex items-center justify-center text-indigo-800 font-black text-sm ring-2 ring-white">
                {session.userName.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-slate-900 text-xs truncate">{session.userName}</p>
                <p className="text-[10px] text-slate-500 truncate">{session.userEmail}</p>
              </div>
            </div>
            <div className="mt-2">
              <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                session.role === 'manager'
                  ? 'bg-indigo-100 text-indigo-800'
                  : 'bg-slate-200 text-slate-600'
              }`}>
                {session.role === 'manager' ? 'Manager' : 'Analista'}
              </span>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2 text-slate-500 hover:text-rose-600 text-xs font-bold px-3 py-2 rounded-lg hover:bg-rose-50 transition-all"
          >
            <LogOut className="w-3.5 h-3.5" />
            Cerrar Sesión
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="app-main flex-1 overflow-y-auto">
        <div className="app-topbar sticky top-0 z-30 border-b border-slate-200 bg-white/80 px-8 py-4 backdrop-blur-xl">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">FinMonitor</p>
              <h2 className="mt-1 text-lg font-black tracking-tight text-slate-900">{activeNavItem?.label || 'Vista'}</h2>
            </div>
            <div className="hidden items-center gap-3 md:flex">
              <div className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-black text-slate-500">
                {session.role === 'manager' ? 'Manager' : 'Analista'}
              </div>
              <div className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-black text-emerald-700">
                Sistema listo
              </div>
            </div>
          </div>
        </div>
        <RouteErrorBoundary key={route} onReset={() => setRoute('clients')}>
        <Suspense fallback={<RouteFallback />}>
          {(route === 'clients') && (
            <ClientList
              session={session}
              onSelectClient={handleSelectClient}
              onNewClient={handleNewClient}
            />
          )}

          {route === 'crm' && (
            <RolloutGuardedRoute feature="crm" title="CRM">
              <CrmDashboardPage onSelectClient={handleSelectClient} />
            </RolloutGuardedRoute>
          )}

          {route === 'benchmarking' && (
            <BenchmarkingPage />
          )}

          {route === 'consolidation' && (
            <AccountConsolidationPage aiSettings={aiSettings} session={session} />
          )}

          {route === 'lifecycle' && (
            <RolloutGuardedRoute feature="lifecycle" title="Línea de vida">
              <LifecyclePage />
            </RolloutGuardedRoute>
          )}

          {route === 'zscore' && (
            <CompanyDefaultPage />
          )}

          {route === 'ingestion' && session.role === 'manager' && (
            <IngestionInboxPage session={session} />
          )}

          {(route === 'client_new' || route === 'client_edit') && (
            <ClientForm
              session={session}
              aiSettings={aiSettings}
              initialData={editingClient}
              onSave={handleSaveClient}
              onCancel={() => {
                if (route === 'client_edit' && selectedClientId) {
                  setEditingClient(undefined);
                  setRoute('client_detail');
                } else {
                  setRoute('clients');
                }
              }}
            />
          )}

          {route === 'client_detail' && selectedClientId && (
            <ClientDetail
              clientId={selectedClientId}
              session={session}
              aiSettings={aiSettings}
              onBack={() => setRoute('clients')}
              onDeleted={() => {
                setSelectedClientId(null);
                setRoute('clients');
              }}
              onEdit={handleEditClient}
            />
          )}

          {route === 'settings' && (
            <SettingsPage
              session={session}
              onSettingsChange={handleSettingsChange}
            />
          )}
        </Suspense>
        </RouteErrorBoundary>
      </main>
    </div>
  );
};

export default App;
