import React, { useState, useEffect } from 'react';
import { auth, Session } from '../../services/auth';
import { db } from '../../db/index';
import { Lock, Mail, Eye, EyeOff, ShieldCheck } from 'lucide-react';

interface Props {
  onLogin: (session: Session) => void;
}

const LoginPage: React.FC<Props> = ({ onLogin }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isFirstTime, setIsFirstTime] = useState(false);

  useEffect(() => {
    db.getUsers().then(users => {
      setIsFirstTime(users.length === 0);
    });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const session = await auth.login(email, password);
      onLogin(session);
    } catch (err: any) {
      setError(err.message || 'Error al iniciar sesión');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setError('');
    setLoading(true);
    try {
      await auth.loginWithGoogle();
    } catch (err: any) {
      setError(err.message || 'Error al iniciar con Google');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      {/* Background gradient blobs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-indigo-600/20 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-indigo-800/20 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 w-full max-w-md">
        {/* Card */}
        <div className="bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl shadow-black/60 p-10">
          {/* Logo */}
          <div className="flex flex-col items-center mb-10">
            <div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center mb-4 shadow-lg shadow-indigo-500/30">
              <ShieldCheck className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-3xl font-black text-white tracking-tight">FinMonitor</h1>
            <p className="text-slate-400 text-sm mt-1 text-center">Sistema de Monitoreo de Crédito IFNB</p>
          </div>

          {/* First-time notice */}
          {isFirstTime && (
            <div className="bg-indigo-950/60 border border-indigo-700/50 rounded-2xl p-4 mb-6">
              <p className="text-indigo-300 text-xs font-bold uppercase tracking-widest mb-2">Primera configuración</p>
              <p className="text-indigo-200 text-sm">
                Acceso inicial con credenciales predeterminadas:
              </p>
              <div className="mt-2 space-y-1">
                <p className="text-indigo-100 text-sm font-mono">admin@finmonitor.mx</p>
                <p className="text-indigo-100 text-sm font-mono">Admin1234!</p>
              </div>
              <p className="text-indigo-400 text-xs mt-2">Cambia tu contraseña en Configuración después de ingresar.</p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="bg-rose-950/60 border border-rose-700/50 rounded-2xl px-4 py-3 mb-6">
              <p className="text-rose-300 text-sm">{error}</p>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            <button
              type="button"
              onClick={handleGoogle}
              disabled={loading}
              className="w-full bg-white hover:bg-slate-100 disabled:opacity-60 text-slate-900 font-black py-3.5 rounded-xl transition-all duration-200 text-sm flex items-center justify-center gap-3 shadow-lg"
            >
              <span className="w-5 h-5 rounded-full bg-white border border-slate-200 flex items-center justify-center font-black text-sm text-blue-600">G</span>
              Continuar con Google
            </button>

            <div className="flex items-center gap-3">
              <div className="h-px bg-slate-800 flex-1" />
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">o con password</span>
              <div className="h-px bg-slate-800 flex-1" />
            </div>

            {/* Email */}
            <div>
              <label className="block text-slate-300 text-xs font-bold uppercase tracking-widest mb-2">
                Correo Electrónico
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                  <Mail className="w-4 h-4 text-slate-500" />
                </div>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="usuario@empresa.mx"
                  required
                  className="w-full bg-slate-800 border border-slate-700 text-white placeholder-slate-500 rounded-xl pl-11 pr-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block text-slate-300 text-xs font-bold uppercase tracking-widest mb-2">
                Contraseña
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                  <Lock className="w-4 h-4 text-slate-500" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  className="w-full bg-slate-800 border border-slate-700 text-white placeholder-slate-500 rounded-xl pl-11 pr-12 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute inset-y-0 right-4 flex items-center text-slate-500 hover:text-slate-300 transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 disabled:cursor-not-allowed text-white font-black py-3.5 rounded-xl transition-all duration-200 text-sm uppercase tracking-widest shadow-lg shadow-indigo-500/20 mt-2"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  Verificando...
                </span>
              ) : (
                'Iniciar Sesión'
              )}
            </button>
          </form>

          {/* Footer */}
          <p className="text-slate-600 text-xs text-center mt-8">
            FinMonitor &copy; {new Date().getFullYear()} — Uso interno exclusivo
          </p>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
