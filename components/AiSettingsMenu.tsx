import React, { useState } from 'react';
import { AiSettings, DEFAULT_GEMINI_MODEL, saveAiSettings } from '../types/ai';

interface AiSettingsMenuProps {
  settings: AiSettings;
  onSave: (settings: AiSettings) => void;
}

const providerLabels = {
  openai: 'ChatGPT / OpenAI',
  gemini: 'Gemini',
  custom: 'Custom endpoint',
};

const AiSettingsMenu: React.FC<AiSettingsMenuProps> = ({ settings, onSave }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState<AiSettings>(settings);

  const handleSave = () => {
    saveAiSettings(draft);
    onSave(draft);
    setIsOpen(false);
  };

  return (
    <div className="px-6 py-5 border-t border-slate-100">
      <button
        onClick={() => setIsOpen(true)}
        className="w-full flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left hover:border-bluebonnet transition-all"
      >
        <div className="w-9 h-9 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center text-bluebonnet font-black text-[10px]">
          AI
        </div>
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest leading-none">Modelo Activo</p>
          <p className="text-xs font-bold text-slate-900 truncate">{providerLabels[settings.provider]} - {settings.model}</p>
        </div>
      </button>

      {isOpen && (
        <div className="fixed inset-0 bg-slate-950/40 backdrop-blur-sm z-[80] flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-xl rounded-[2rem] shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-6 border-b border-slate-100">
              <h2 className="text-xl font-black text-slate-900">AI Settings</h2>
              <p className="text-xs text-slate-500 font-bold mt-1">Provider can be changed anytime.</p>
            </div>

            <div className="p-6 space-y-4">
              <label className="block">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Provider</span>
                <select
                  value={draft.provider}
                  onChange={e => {
                    const provider = e.target.value as AiSettings['provider'];
                    setDraft({
                      ...draft,
                      provider,
                      model: provider === 'openai' ? 'gpt-5' : provider === 'gemini' ? DEFAULT_GEMINI_MODEL : draft.model,
                    });
                  }}
                  className="mt-2 w-full bg-slate-50 border border-slate-200 px-4 py-3 rounded-xl font-bold outline-none focus:ring-2 focus:ring-bluebonnet"
                >
                  <option value="openai">ChatGPT / OpenAI</option>
                  <option value="gemini">Gemini</option>
                  <option value="custom">Custom endpoint</option>
                </select>
              </label>

              <label className="block">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Model</span>
                <input
                  value={draft.model}
                  onChange={e => setDraft({ ...draft, model: e.target.value })}
                  className="mt-2 w-full bg-slate-50 border border-slate-200 px-4 py-3 rounded-xl font-mono text-sm font-bold outline-none focus:ring-2 focus:ring-bluebonnet"
                />
              </label>

              {draft.provider === 'openai' && (
                <div>
                  <label className="block">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">OpenAI API Key</span>
                    <input
                      type="password"
                      value={draft.openaiApiKey}
                      onChange={e => setDraft({ ...draft, openaiApiKey: e.target.value })}
                      placeholder="sk-..."
                      className="mt-2 w-full bg-slate-50 border border-slate-200 px-4 py-3 rounded-xl font-mono text-sm outline-none focus:ring-2 focus:ring-bluebonnet"
                    />
                  </label>
                  <p className="mt-2 text-[11px] text-slate-500 font-medium">
                    OpenAI API usage is billed by OpenAI to the key owner. The app stores this key locally in this browser.
                  </p>
                </div>
              )}

              {draft.provider === 'gemini' && (
                <label className="block">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Gemini API Key</span>
                  <input
                    type="password"
                    value={draft.geminiApiKey}
                    onChange={e => setDraft({ ...draft, geminiApiKey: e.target.value })}
                    className="mt-2 w-full bg-slate-50 border border-slate-200 px-4 py-3 rounded-xl font-mono text-sm outline-none focus:ring-2 focus:ring-bluebonnet"
                  />
                </label>
              )}

              {draft.provider === 'custom' && (
                <label className="block">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Endpoint</span>
                  <input
                    value={draft.customEndpoint}
                    onChange={e => setDraft({ ...draft, customEndpoint: e.target.value })}
                    placeholder="http://localhost:8000/ai"
                    className="mt-2 w-full bg-slate-50 border border-slate-200 px-4 py-3 rounded-xl font-mono text-sm outline-none focus:ring-2 focus:ring-bluebonnet"
                  />
                </label>
              )}
            </div>

            <div className="p-6 border-t border-slate-100 flex gap-3">
              <button onClick={() => setIsOpen(false)} className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-black">
                Cancel
              </button>
              <button onClick={handleSave} className="flex-1 py-3 rounded-xl bg-bluebonnet text-white font-black shadow-lg shadow-[#0018E633]">
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AiSettingsMenu;
