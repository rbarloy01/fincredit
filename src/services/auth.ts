import { supabase } from '../lib/supabase';

export type Role = 'manager' | 'analyst';

const SESSION_KEY = 'finmonitor_session';

export interface Session {
  userId: string;
  userName: string;
  userEmail: string;
  role: Role;
}

export const auth = {
  async createFirstUser(): Promise<void> {
    // Users are managed in Supabase Auth — restore session if Supabase has one
    const { data: { session } } = await supabase.auth.getSession();
    if (session && !sessionStorage.getItem(SESSION_KEY)) {
      const { data: profile } = await supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
      const fmSession: Session = {
        userId: session.user.id,
        userName: profile?.name || session.user.email || '',
        userEmail: session.user.email || '',
        role: (profile?.role as Role) || 'analyst',
      };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(fmSession));
    }
  },

  async login(email: string, password: string): Promise<Session> {
    const { data, error } = await supabase.auth.signInWithPassword({ email: email.toLowerCase().trim(), password });
    if (error || !data.user) throw new Error('Correo electrónico o contraseña incorrectos.');
    const { data: profile } = await supabase.from('profiles').select('*').eq('id', data.user.id).maybeSingle();
    const session: Session = {
      userId: data.user.id,
      userName: profile?.name || data.user.email || '',
      userEmail: data.user.email || '',
      role: (profile?.role as Role) || 'analyst',
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
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
