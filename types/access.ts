export interface AccessUser {
  email: string;
  role: 'admin' | 'analyst' | 'viewer';
}

const ACCESS_KEY = 'FINANALYZER_ACCESS_USERS';

export const DEFAULT_ACCESS_USERS: AccessUser[] = [
  { email: 'rbarron@syscap.com.mx', role: 'admin' },
];

export function loadAccessUsers(): AccessUser[] {
  if (typeof window === 'undefined') return DEFAULT_ACCESS_USERS;
  try {
    const saved = localStorage.getItem(ACCESS_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    const merged = [...DEFAULT_ACCESS_USERS, ...(Array.isArray(parsed) ? parsed : [])];
    return merged.filter((user, index, arr) => arr.findIndex(item => item.email === user.email) === index);
  } catch {
    return DEFAULT_ACCESS_USERS;
  }
}

export function saveAccessUsers(users: AccessUser[]) {
  localStorage.setItem(ACCESS_KEY, JSON.stringify(users));
}
