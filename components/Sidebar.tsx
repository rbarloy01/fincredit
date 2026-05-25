
import React from 'react';
import { ICONS } from '../constants';
import { AppRoute, Company } from '../types';
import { AiSettings } from '../types/ai';
import AiSettingsMenu from './AiSettingsMenu';
import AccessSettingsMenu from './AccessSettingsMenu';

interface SidebarProps {
  currentRoute: AppRoute;
  onNavigate: (route: AppRoute) => void;
  onAddProfile: () => void;
  companies: Company[];
  selectedCompanyId: string | null;
  onSelectCompany: (id: string) => void;
  aiSettings: AiSettings;
  onSaveAiSettings: (settings: AiSettings) => void;
}

const Sidebar: React.FC<SidebarProps> = ({ 
  currentRoute, 
  onNavigate, 
  onAddProfile, 
  companies, 
  selectedCompanyId, 
  onSelectCompany,
  aiSettings,
  onSaveAiSettings
}) => {
  const items = [
    { id: AppRoute.DASHBOARD, label: 'Tablero', icon: ICONS.Dashboard },
    { id: AppRoute.MONITORING_MODEL, label: 'Modelo', icon: ICONS.LoanTape },
    { id: AppRoute.COMPANIES, label: 'Portafolio', icon: ICONS.Companies },
  ];

  // Group companies by client
  const clients = Object.entries(companies.reduce((acc, co) => {
    if (!acc[co.clientId]) acc[co.clientId] = { name: co.name, contracts: [] };
    acc[co.clientId].contracts.push(co);
    return acc;
  }, {} as Record<string, { name: string; contracts: Company[] }>));

  return (
    <aside className="w-72 bg-white border-r border-slate-200 h-screen sticky top-0 flex flex-col shadow-xl z-[40]">
      <div className="p-8 border-b border-slate-50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-bluebonnet rounded-2xl flex items-center justify-center text-white font-black text-xl shadow-lg shadow-[#0018E633]">F</div>
          <span className="text-2xl font-black text-slate-900 tracking-tighter">FinAnalyzer</span>
        </div>
      </div>
      <nav className="flex-1 p-6 space-y-3 overflow-y-auto">
        <button
          onClick={onAddProfile}
          className="w-full flex items-center gap-4 px-6 py-4 rounded-[1.25rem] transition-all duration-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 mb-6 border border-emerald-100"
        >
          <div className="text-emerald-500">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </div>
          <span className="font-black text-sm uppercase tracking-widest">Nueva Entidad</span>
        </button>

        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className={`w-full flex items-center gap-4 px-6 py-4 rounded-[1.25rem] transition-all duration-300 group ${
              currentRoute === item.id 
                ? 'bg-bluebonnet text-white shadow-xl shadow-[#0018E633] scale-[1.02]' 
                : 'text-slate-400 hover:bg-slate-50 hover:text-slate-900'
            }`}
          >
            <div className={`transition-colors ${currentRoute === item.id ? 'text-white' : 'text-slate-300 group-hover:text-bluebonnet'}`}>
              <item.icon />
            </div>
            <span className="font-black text-sm uppercase tracking-widest">{item.label}</span>
          </button>
        ))}

        <div className="pt-6 mt-6 border-t border-slate-100">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4 px-4">Clientes y Contratos</p>
          <div className="space-y-4">
            {clients.map(([clientId, client]) => {
              const clientData = client as { name: string; contracts: Company[] };
              return (
                <div key={clientId} className="space-y-1">
                  <div className="px-4 py-2 flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-slate-300"></div>
                    <span className="text-xs font-black text-slate-900 uppercase tracking-tight truncate">{clientData.name}</span>
                  </div>
                  <div className="pl-6 space-y-1">
                    {clientData.contracts.map(contract => (
                      <button
                        key={contract.id}
                        onClick={() => {
                          onSelectCompany(contract.id);
                          onNavigate(AppRoute.DASHBOARD);
                        }}
                        className={`w-full text-left px-4 py-2 rounded-xl text-[11px] font-bold transition-all truncate ${
                          selectedCompanyId === contract.id
                            ? 'bg-blue-50 text-bluebonnet border border-blue-100'
                            : 'text-slate-500 hover:bg-slate-50'
                        }`}
                      >
                        {contract.contractName}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </nav>
      
      <div className="p-6 mt-auto">
        <div className="bg-slate-900 rounded-[2rem] p-6 text-white shadow-2xl relative overflow-hidden group">
           <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/10 rounded-full -mr-16 -mt-16 blur-2xl transition-all group-hover:scale-110"></div>
           <p className="text-[10px] font-black uppercase text-bluebonnet tracking-[0.2em] mb-4">Risk Audit Core</p>
           <p className="text-sm font-bold leading-snug mb-6">Extrae modelos de PDF, Imágenes o Excel al instante.</p>
           <button 
             onClick={() => (window as any).location.reload()} 
             className="w-full bg-white/10 hover:bg-white/20 text-white py-3 rounded-xl text-xs font-black uppercase transition-all"
           >
             Sincronizar
           </button>
        </div>
      </div>

      <AiSettingsMenu settings={aiSettings} onSave={onSaveAiSettings} />
      <AccessSettingsMenu />
    </aside>
  );
};

export default Sidebar;
