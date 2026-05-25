import React, { useState, useEffect } from 'react';
import { db, User } from '../../db/index';
import { Session, auth } from '../../services/auth';
import { AIProvider, AISettings, loadAISettings, saveAISettings, testConnection } from '../../services/ai';
import { Key, Users, Save, Plus, Trash2, Eye, EyeOff, Check, X, Info, Zap } from 'lucide-react';

interface Props {
  session: Session;
  onSettingsChange: (s: AISettings) => void;
}

const PROVIDERS: { id: AIProvider; label: string; placeholder: string; color: string }[] = [
  { id: 'gemini', label: 'Google Gemini', placeholder: 'AIzaSy...', color: 'bg-blue-100 text-blue-800 border-blue-200' },
  { id: 'claude', label: 'Anthropic Claude', placeholder: 'sk-ant-api03-...', color: 'bg-violet-100 text-violet-800 border-violet-200' },
  { id: 'openai', label: 'OpenAI GPT-4o', placeholder: 'sk-proj-...', color: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
];

const SettingsPage: React.FC<Props> = ({ session, onSettingsChange }) => {
  const [aiSettings, setAiSettings] = useState<AISettings>(loadAISettings);
  const [showKey, setShowKey] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);
  const [testMsg, setTestMsg] = useState('');

  const [users, setUsers] = useState<User[]>([]);
  const [showNewUser, setShowNewUser] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'manager' | 'analyst'>('analyst');
  const [creatingUser, setCreatingUser] = useState(false);
  const [userError, setUserError] = useState('');

  useEffect(() => {
    if (session.role === 'manager') db.getUsers().then(setUsers);
  }, [session.role]);

  const handleSave = () => {
    saveAISettings(aiSettings);
    onSettingsChange(aiSettings);
    setKeySaved(true);
    setTimeout(() => setKeySaved(false), 2000);
  };

  const handleTest = async () => {
    if (!aiSettings.apiKey.trim()) return;
    setTesting(true); setTestResult(null); setTestMsg('');
    try {
      const result = await testConnection(aiSettings);
      setTestResult(result.includes('OK') || result.length > 0 ? 'success' : 'error');
      setTestMsg(result.includes('OK') ? 'Conexión exitosa' : result.slice(0, 60));
    } catch (e: any) {
      setTestResult('error');
      setTestMsg(e.message?.slice(0, 80) || 'Error de conexión');
    } finally {
      setTesting(false);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setUserError('');
    if (!newName.trim() || !newEmail.trim() || !newPassword.trim()) { setUserError('Todos los campos son requeridos'); return; }
    if (newPassword.length < 8) { setUserError('Contraseña mínimo 8 caracteres'); return; }
    setCreatingUser(true);
    try {
      await db.createUser({ name: newName.trim(), email: newEmail.toLowerCase().trim(), password: newPassword, role: newRole });
      setNewName(''); setNewEmail(''); setNewPassword(''); setNewRole('analyst'); setShowNewUser(false);
      setUsers(await db.getUsers());
    } catch (err: any) {
      setUserError(err.message || 'Error al crear usuario');
    } finally { setCreatingUser(false); }
  };

  const handleDeleteUser = async (userId: string) => {
    if (userId === session.userId) { alert('No puedes eliminar tu propia cuenta'); return; }
    if (!confirm('¿Eliminar este usuario?')) return;
    await db.deleteUser(userId);
    setUsers(prev => prev.filter(u => u.id !== userId));
  };

  const inp = 'bg-slate-50 border border-slate-200 text-slate-900 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-all w-full';
  const lbl = 'block text-slate-700 text-xs font-bold uppercase tracking-wider mb-2';
  const currentProvider = PROVIDERS.find(p => p.id === aiSettings.provider)!;

  return (
    <div className="flex-1 bg-slate-50 min-h-screen p-8">
      <div className="max-w-2xl space-y-6">
        <div className="mb-8">
          <h1 className="text-2xl font-black text-slate-900 tracking-tight">Configuración</h1>
          <p className="text-slate-500 text-sm mt-1">Administra preferencias del sistema</p>
        </div>

        {/* AI Provider */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-8 h-8 bg-indigo-100 rounded-lg flex items-center justify-center">
              <Zap className="w-4 h-4 text-indigo-600" />
            </div>
            <h2 className="text-sm font-black text-slate-900 uppercase tracking-widest">Motor de Inteligencia Artificial</h2>
          </div>

          {/* Provider selector */}
          <div className="mb-5">
            <label className={lbl}>Proveedor</label>
            <div className="grid grid-cols-3 gap-3">
              {PROVIDERS.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setAiSettings(s => ({ ...s, provider: p.id, apiKey: '' }))}
                  className={`px-4 py-3 rounded-xl text-sm font-bold border-2 transition-all text-left ${
                    aiSettings.provider === p.id
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-800'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* API Key */}
          <div className="space-y-4">
            <div>
              <label className={lbl}>{currentProvider.label} — API Key</label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={aiSettings.apiKey}
                  onChange={e => setAiSettings(s => ({ ...s, apiKey: e.target.value }))}
                  placeholder={currentProvider.placeholder}
                  className={`${inp} pr-12`}
                />
                <button type="button" onClick={() => setShowKey(v => !v)} className="absolute inset-y-0 right-4 text-slate-400 hover:text-slate-700">
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-slate-400 mt-2 flex items-center gap-1">
                <Info className="w-3 h-3" />
                La API Key se guarda localmente en tu navegador
              </p>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={handleSave} className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-4 py-2.5 rounded-xl text-sm transition-all">
                {keySaved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                {keySaved ? 'Guardada' : 'Guardar'}
              </button>
              <button onClick={handleTest} disabled={testing || !aiSettings.apiKey.trim()} className="flex items-center gap-2 bg-white border border-slate-200 text-slate-700 font-bold px-4 py-2.5 rounded-xl text-sm hover:bg-slate-50 disabled:opacity-50 transition-all">
                {testing ? <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg> : null}
                Test Conexión
              </button>
              {testResult === 'success' && <span className="flex items-center gap-1.5 text-emerald-700 font-bold text-sm"><Check className="w-4 h-4" />{testMsg || 'Conexión exitosa'}</span>}
              {testResult === 'error' && <span className="flex items-center gap-1.5 text-rose-700 font-bold text-sm"><X className="w-4 h-4" />{testMsg || 'Error de conexión'}</span>}
            </div>
          </div>
        </div>

        {/* User management */}
        {session.role === 'manager' && (
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-indigo-100 rounded-lg flex items-center justify-center"><Users className="w-4 h-4 text-indigo-600" /></div>
                <h2 className="text-sm font-black text-slate-900 uppercase tracking-widest">Usuarios</h2>
              </div>
              <button onClick={() => setShowNewUser(v => !v)} className="flex items-center gap-2 text-indigo-600 hover:text-indigo-700 text-sm font-bold transition-colors">
                <Plus className="w-4 h-4" />Nuevo Usuario
              </button>
            </div>
            {showNewUser && (
              <form onSubmit={handleCreateUser} className="bg-slate-50 rounded-xl p-5 mb-5 space-y-4 border border-slate-200">
                <h3 className="text-xs font-black text-slate-700 uppercase tracking-widest">Crear Usuario</h3>
                {userError && <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-rose-700 text-sm">{userError}</div>}
                <div className="grid grid-cols-2 gap-4">
                  <div><label className={lbl}>Nombre</label><input className={inp} value={newName} onChange={e => setNewName(e.target.value)} placeholder="Nombre completo" required /></div>
                  <div><label className={lbl}>Correo</label><input type="email" className={inp} value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="usuario@empresa.mx" required /></div>
                  <div><label className={lbl}>Contraseña</label><input type="password" className={inp} value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Mínimo 8 caracteres" required /></div>
                  <div><label className={lbl}>Rol</label>
                    <select className={inp} value={newRole} onChange={e => setNewRole(e.target.value as 'manager'|'analyst')}>
                      <option value="analyst">Analista</option>
                      <option value="manager">Manager</option>
                    </select>
                  </div>
                </div>
                <div className="flex gap-3">
                  <button type="button" onClick={() => { setShowNewUser(false); setUserError(''); }} className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-700 text-sm font-bold hover:bg-white">Cancelar</button>
                  <button type="submit" disabled={creatingUser} className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-black disabled:opacity-60">{creatingUser ? 'Creando...' : 'Crear Usuario'}</button>
                </div>
              </form>
            )}
            <div className="space-y-2">
              {users.map(user => (
                <div key={user.id} className="flex items-center gap-4 bg-slate-50 rounded-xl px-4 py-3 border border-slate-100">
                  <div className="w-8 h-8 bg-indigo-200 rounded-full flex items-center justify-center text-indigo-800 font-black text-sm">{user.name.charAt(0).toUpperCase()}</div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-slate-900 text-sm truncate">{user.name}</p>
                    <p className="text-xs text-slate-500 truncate">{user.email}</p>
                  </div>
                  <span className={`text-xs font-black px-2.5 py-1 rounded-full border ${user.role === 'manager' ? 'bg-indigo-100 text-indigo-800 border-indigo-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                    {user.role === 'manager' ? 'Manager' : 'Analista'}
                  </span>
                  {user.id === session.userId ? (
                    <span className="text-xs text-slate-400">(tú)</span>
                  ) : (
                    <button onClick={() => handleDeleteUser(user.id)} className="text-slate-300 hover:text-rose-500 transition-colors"><Trash2 className="w-4 h-4" /></button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <h2 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-4">Acerca de</h2>
          <div className="space-y-2 text-sm text-slate-600">
            <div className="flex justify-between"><span className="font-semibold text-slate-700">Sistema</span><span>FinMonitor — Monitoreo de Crédito IFNB</span></div>
            <div className="flex justify-between"><span className="font-semibold text-slate-700">Versión</span><span>1.1.0</span></div>
            <div className="flex justify-between"><span className="font-semibold text-slate-700">Motor IA activo</span><span className="capitalize">{currentProvider.label}</span></div>
            <div className="flex justify-between"><span className="font-semibold text-slate-700">Almacenamiento</span><span>Supabase PostgreSQL</span></div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
