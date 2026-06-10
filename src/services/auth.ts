import { supabase } from '../lib/supabase';
import type { User as SupabaseUser } from '@supabase/supabase-js';

export type Role = 'manager' | 'analyst';

const SESSION_KEY = 'finmonitor_session';

export interface Session {
  userId: string;
  userName: string;
  userEmail: string;
  role: Role;
}

function profileName(user: SupabaseUser): string {
  return user.user_metadata?.full_name || user.user_metadata?.name || user.email || 'Usuario';
}

async function ensureOrg(user: SupabaseUser): Promise<string | null> {
  try {
    const response = await fetch('/api/admin/org/ensure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: user.id,
        userEmail: user.email || '',
        userName: profileName(user),
        role: 'analyst',
        organizationName: 'Syscap',
        slug: 'syscap',
      }),
    });
    const json = await response.json().catch(() => ({}));
    return response.ok ? json.orgId || null : null;
  } catch {
    return null;
  }
}

async function ensureProfile(user: SupabaseUser): Promise<any> {
  const { data: existing } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (existing) {
    const orgId = existing.org_id || await ensureOrg(user);
    return { ...existing, org_id: orgId || undefined };
  }

  const orgId = await ensureOrg(user);
  const row: any = {
    id: user.id,
    name: profileName(user),
    email: user.email || '',
    role: 'analyst',
    ...(orgId ? { org_id: orgId } : {}),
  };
  let { data, error } = await supabase.from('profiles').insert(row).select().single();
  if (error && /schema cache|column .*email|email.*column|org_id.*column|column .*org_id/i.test(error.message || '')) {
    const retry = await supabase.from('profiles').insert({ id: row.id, name: row.name, role: row.role }).select().single();
    data = retry.data;
    error = retry.error;
  }
  if (error) throw new Error(`No se pudo crear perfil OAuth: ${error.message}`);
  return data;
}

function toSession(user: SupabaseUser, profile: any): Session {
  return {
    userId: user.id,
    userName: profile?.name || user.user_metadata?.full_name || user.email || '',
    userEmail: user.email || profile?.email || '',
    role: (profile?.role as Role) || 'analyst',
  };
}

export const auth = {
  async createFirstUser(): Promise<void> {
    // Users are managed in Supabase Auth — restore session if Supabase has one
    const { data: { session } } = await supabase.auth.getSession();
    if (session && !sessionStorage.getItem(SESSION_KEY)) {
      const profile = await ensureProfile(session.user);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(toSession(session.user, profile)));
    }
  },

  async login(email: string, password: string): Promise<Session> {
    const { data, error } = await supabase.auth.signInWithPassword({ email: email.toLowerCase().trim(), password });
    if (error || !data.user) throw new Error('Correo electrónico o contraseña incorrectos.');
    const profile = await ensureProfile(data.user);
    const session = toSession(data.user, profile);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
  },

  async loginWithGoogle(): Promise<void> {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (error) throw new Error(error.message || 'No se pudo iniciar sesión con Google');
  },

  logout(): void {
    supabase.auth.signOut();
    sessionStorage.removeItem(SESSION_KEY);
  },

  getSession(): Session | null {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw) as Session; } catch { return null; }
  },

  isManager(): boolean {
    return auth.getSession()?.role === 'manager';
  },

  requireAuth(): Session {
    const session = auth.getSession();
    if (!session) throw new Error('No autenticado. Por favor inicie sesión.');
    return session;
  },

  // kept for compatibility — no longer hashes, Supabase handles it
  async hashPassword(password: string): Promise<string> {
    return password;
  },
};
