import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const isSupabaseConfigured = Boolean(url && key);
export const supabaseConfigError = isSupabaseConfigured
  ? null
  : 'Faltan VITE_SUPABASE_URL y/o VITE_SUPABASE_ANON_KEY en el ambiente de Vercel.';

export const supabase = createClient(
  url || 'https://missing-supabase-url.supabase.co',
  key || 'missing-supabase-anon-key',
);
