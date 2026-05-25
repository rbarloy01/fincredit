import React, { useState } from 'react';
import { AccessUser, loadAccessUsers, saveAccessUsers } from '../types/access';

const AccessSettingsMenu: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [users, setUsers] = useState<AccessUser[]>(() => loadAccessUsers());
  const [email, setEmail] = useState('');

  const persist = (next: AccessUser[]) => {
    setUsers(next);
    saveAccessUsers(next);
  };

  const addUser = () => {
    const clean = email.trim().toLowerCase();
    if (!clean) return;
    persist([...users.filter(user => user.email !== clean), { email: clean, role: 'analyst' }]);
    setEmail('');
  };

  return (
    <div className="px-6 pb-5">
      <button
        onClick={() => setIsOpen(true)}
        className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left hover:border-bluebonnet transition-all"
      >
        <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest leading-none">Accesos</p>
        <p className="text-xs font-bold text-slate-900 truncate">{users.length} usuario(s)</p>
      </button>

      {isOpen && (
        <div className="fixed inset-0 bg-slate-950/40 backdrop-blur-sm z-[80] flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-lg rounded-[2rem] shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-6 border-b border-slate-100">
              <h2 className="text-xl font-black text-slate-900">Accesos</h2>
              <p className="text-xs text-slate-500 font-bold mt-1">Lista local para preparar control SaaS.</p>
            </div>
            <div className="p-6 space-y-4">
              {users.map(user => (
                <div key={user.email} className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3">
                  <span className="text-sm font-bold text-slate-800">{user.email}</span>
                  <select
                    value={user.role}
                    onChange={e => persist(users.map(item => item.email === user.email ? { ...item, role: e.target.value as AccessUser['role'] } : item))}
                    className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-bold"
                  >
                    <option value="admin">Admin</option>
                    <option value="analyst">Analyst</option>
                    <option value="viewer">Viewer</option>
                  </select>
                </div>
              ))}
              <div className="flex gap-2">
                <input
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="correo@syscap.com.mx"
                  className="flex-1 bg-slate-50 border border-slate-200 px-4 py-3 rounded-xl text-sm outline-none focus:ring-2 focus:ring-bluebonnet"
                />
                <button onClick={addUser} className="px-4 rounded-xl bg-bluebonnet text-white text-xs font-black">
                  Agregar
                </button>
              </div>
            </div>
            <div className="p-6 border-t border-slate-100">
              <button onClick={() => setIsOpen(false)} className="w-full py-3 rounded-xl bg-slate-100 text-slate-600 font-black">
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AccessSettingsMenu;
