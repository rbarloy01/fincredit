export type AiProvider = 'openai' | 'gemini' | 'custom';

export interface AiSettings {
  provider: AiProvider;
  model: string;
  openaiApiKey: string;
  geminiApiKey: string;
  customEndpoint: string;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: 'openai',
  model: 'gpt-5',
  openaiApiKey: '',
  geminiApiKey: '',
  customEndpoint: '',
};

export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';

export function loadAiSettings(): AiSettings {
  if (typeof window === 'undefined') return DEFAULT_AI_SETTINGS;

  localStorage.removeItem('OPENAI_API_KEY');
  localStorage.removeItem('GEMINI_API_KEY');
  return {
    provider: (localStorage.getItem('AI_PROVIDER') as AiProvider) || DEFAULT_AI_SETTINGS.provider,
    model: localStorage.getItem('AI_MODEL') || DEFAULT_AI_SETTINGS.model,
    openaiApiKey: '',
    geminiApiKey: '',
    customEndpoint: localStorage.getItem('AI_ENDPOINT') || '',
  };
}

export function saveAiSettings(settings: AiSettings) {
  localStorage.setItem('AI_PROVIDER', settings.provider);
  localStorage.setItem('AI_MODEL', settings.model);
  localStorage.removeItem('OPENAI_API_KEY');
  localStorage.removeItem('GEMINI_API_KEY');
  localStorage.setItem('AI_ENDPOINT', settings.customEndpoint.trim());
}
