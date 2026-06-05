import React, { useState, useEffect } from 'react';
import { auth, Session } from './services/auth';
import LoginPage from './components/auth/LoginPage';
import ClientList from './components/clients/ClientList';
import ClientForm from './components/clients/ClientForm';
import ClientDetail from './components/clients/ClientDetail';
import SettingsPage from './components/settings/SettingsPage';
import { Client, CustomField } from './db/index';
import { AISettings, loadAISettings } from './services/ai';
import { Building2, Settings, LogOut, ShieldCheck, Moon, Sun } from 'lucide-react';

type Route = 'clients' | 'client_new' | 'client_edit' | 'client_detail' | 'settings';

const App: React.FC = () => {
  const [session, setSession] = useState<Session | null>(null);
  const [route, setRoute] = useState<Route>('clients');
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [editingClient, setEditingClient] = useState<Client | undefined>(undefined);
  const [aiSettings, setAiSettings] = useState<AISettings>(loadAISettings);
  const [initializing, setInitializing] = useState(true);
  const [theme, setTheme] = useState<'day' | 'night'>(() => (localStorage.getItem('finmonitor_theme') as 'day' | 'night') || 'day');

  useEffect(() => {
    auth.createFirstUser().then(() => {
      const s = auth.getSession();
      setSession(s);
      setInitializing(false);
    }).catch(err => {
      console.error('Initialization error:', err);
      setInitializing(false);
    });
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

  if (initializing) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg">
            <ShieldCheck className="w-8 h-8 text-white" />
          </div>
          <p className="text-slate-400 text-sm">Iniciando FinMonitor...</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return <LoginPage onLogin={handleLogin} />;
  }

  const navItems = [
    { id: 'clients' as Route, label: 'Clientes', icon: Building2 },
    ...(session.role === 'manager' ? [{ id: 'settings' as Route, label: 'Configuración', icon: Settings }] : []),
  ];

  return (
    <div className={`finmonitor-shell theme-${theme} flex h-screen bg-slate-50 overflow-hidden`}>
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col shadow-sm flex-shrink-0">
        {/* Logo */}
        <div className="p-6 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-indigo-600 rounded-xl flex items-center justify-center shadow-md">
              <ShieldCheck className="w-5 h-5 text-white" />
            </div>
            <div>
              <span className="text-lg font-black text-slate-900 tracking-tight">FinMonitor</span>
              <p className="text-[10px] text-slate-400 font-medium leading-none mt-0.5">Crédito IFNB</p>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {navItems.map(item => (
            <button
              key={item.id}
              onClick={() => setRoute(item.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${
                route === item.id || (route === 'client_detail' && item.id === 'clients') || (route === 'client_new' && item.id === 'clients') || (route === 'client_edit' && item.id === 'clients')
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200'
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
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
              {theme === 'day' ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-indigo-300" />}
              {theme === 'day' ? 'Modo día' : 'Modo noche'}
            </span>
            <span className="text-[10px] uppercase tracking-widest">{theme === 'day' ? 'Light' : 'Dark'}</span>
          </button>
          <div className="bg-slate-50 rounded-xl p-3 mb-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-indigo-200 rounded-full flex items-center justify-center text-indigo-800 font-black text-sm">
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
      <main className="flex-1 overflow-y-auto">
        {(route === 'clients') && (
          <ClientList
            session={session}
            onSelectClient={handleSelectClient}
            onNewClient={handleNewClient}
          />
        )}

        {(route === 'client_new' || route === 'client_edit') && (
          <ClientForm
            session={session}
            initialData={editingClient}
            onSave={handleSaveClient}
            onCancel={() => setRoute('clients')}
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
          />
        )}

        {route === 'settings' && (
          <SettingsPage
            session={session}
            onSettingsChange={handleSettingsChange}
          />
        )}
      </main>
    </div>
  );
};

export default App;
