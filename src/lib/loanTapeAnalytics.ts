import { LoanTape_DB } from '../db/index';
import { StructuredLoanTapeAnalysis } from '../services/ai';

export interface StandardLoan {
  loan_id: string | null;
  client: string | null;
  amount: number | null;
  outstanding_balance: number | null;
  interest_rate: number | null;
  loan_status: string | null;
  start_date: string | null;
  end_date: string | null;
  loan_type: string | null;
  days_overdue: number | null;
  currency: string | null;
  industry: string | null;
  state: string | null;
  file_date: string | null;
}

export interface MappingNote {
  source_header: string;
  target_term: keyof StandardLoan;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

type Severity = 'high' | 'medium' | 'low';

const SYNONYMS: Record<keyof StandardLoan, string[]> = {
  loan_id: ['contrato', 'loan id', 'loan number', 'loan no', 'folio', 'numero credito', 'no contrato', 'id prestamo', 'operacion'],
  client: ['cliente', 'client', 'customer', 'razon social', 'nombre', 'client id', 'apellidos'],
  amount: ['amount', 'loan amount', 'lended amount', 'principal', 'original amount', 'monto original', 'monto otorgado', 'monto maximo', 'costo'],
  outstanding_balance: ['capital balance', 'saldo capital', 'saldo insoluto', 'capital por pagar', 'saldo insoluto capital'],
  interest_rate: ['interest rate', 'tasa', 'tasa interes', 'rate', 'rate %'],
  loan_status: ['status', 'estado', 'loan status', 'estatus'],
  start_date: ['start date', 'origination date', 'fecha inicio', 'fecha otorgamiento', 'disbursement date'],
  end_date: ['end date', 'maturity date', 'fecha vencimiento', 'fecha fin', 'due date'],
  loan_type: ['loan type', 'producto', 'product', 'product type', 'tipo contrato', 'tipo credito', 'tipo prestamo', 'tipo producto', 'linea', 'modalidad', 'subproducto', 'segmento', 'programa', 'plan', 'esquema'],
  days_overdue: ['days overdue', 'days past due', 'dpd', 'mora dias', 'dias atraso', 'dias de atraso', 'dias vencidos', 'delinquent days'],
  currency: ['currency', 'moneda', 'divisa'],
  industry: ['industry', 'giro', 'sector', 'industria'],
  state: ['state', 'provincia', 'estado residencia', 'estado de residencia', 'region'],
  file_date: ['file date', 'fecha archivo', 'fecha corte', 'fecha reporte'],
};

const PAID_STATUSES = ['paid', 'fully paid', 'paid off', 'closed', 'canceled', 'cancelled', 'liquidated', 'liquidado', 'pagado'];

function normalize(value: any): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[%#]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseNumber(value: any): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value).trim();
  if (!raw) return null;
  const negative = /^\(.*\)$/.test(raw);
  const cleaned = raw.replace(/[,$%\s]/g, '').replace(/[()]/g, '');
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

function excelSerialToDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
}

function parseDate(value: any): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return excelSerialToDate(value);
  const raw = String(value).trim();
  if (!raw) return null;
  const direct = raw.match(/(20\d{2})[-/_.](\d{1,2})[-/_.](\d{1,2})/);
  if (direct) return `${direct[1]}-${direct[2].padStart(2, '0')}-${direct[3].padStart(2, '0')}`;
  const mx = raw.match(/(\d{1,2})[-/_.](\d{1,2})[-/_.](20\d{2})/);
  if (mx) return `${mx[3]}-${mx[2].padStart(2, '0')}-${mx[1].padStart(2, '0')}`;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function parseFileDate(fileName?: string): string | null {
  const raw = fileName || '';
  const ymd = raw.match(/(20\d{2})[-_. ]?(\d{2})[-_. ]?(\d{2})/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  const yymmdd = raw.match(/\b(\d{2})[-_. ]?(\d{2})[-_. ]?(\d{2})\b/);
  if (yymmdd) {
    const year = Number(yymmdd[1]) >= 70 ? `19${yymmdd[1]}` : `20${yymmdd[1]}`;
    return `${year}-${yymmdd[2]}-${yymmdd[3]}`;
  }
  return null;
}

function pickColumns(headers: string[]) {
  const mapping: Partial<Record<keyof StandardLoan, string>> = {};
  const notes: MappingNote[] = [];
  const used = new Set<string>();
  const normalized = headers.map(h => ({ header: h, norm: normalize(h) }));

  const capitalVigente = normalized.find(h => h.norm.includes('capital vigente'))?.header;
  const capitalVencido = normalized.find(h => h.norm.includes('capital vencido'))?.header;

  for (const target of Object.keys(SYNONYMS) as Array<keyof StandardLoan>) {
    if (target === 'file_date') continue;
    if (target === 'outstanding_balance' && capitalVigente && capitalVencido) continue;
    const terms = SYNONYMS[target].map(normalize);
    const exact = normalized.find(h => !used.has(h.header) && terms.includes(h.norm));
    const fuzzy = exact || normalized.find(h => !used.has(h.header) && terms.some(t => h.norm.includes(t) || t.includes(h.norm)));
    if (fuzzy) {
      mapping[target] = fuzzy.header;
      used.add(fuzzy.header);
      notes.push({ source_header: fuzzy.header, target_term: target, confidence: exact ? 'high' : 'medium', reasoning: 'Header matched loan tape synonym' });
    }
  }

  if (capitalVigente && capitalVencido) {
    notes.push({ source_header: `${capitalVigente} + ${capitalVencido}`, target_term: 'outstanding_balance', confidence: 'high', reasoning: 'Prioritized sum of capital vigente and capital vencido' });
  }

  return { mapping, notes, capitalVigente, capitalVencido };
}

export function standardizeLoanTape(rows: any[], fileName?: string) {
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  const { mapping, notes, capitalVigente, capitalVencido } = pickColumns(headers);
  const fallbackFileDate = parseFileDate(fileName);

  const standardized: StandardLoan[] = rows.map(row => {
    const get = (key: keyof StandardLoan) => mapping[key] ? row[mapping[key] as string] : null;
    const capitalA = capitalVigente ? parseNumber(row[capitalVigente]) : null;
    const capitalB = capitalVencido ? parseNumber(row[capitalVencido]) : null;
    const balance = capitalA !== null || capitalB !== null
      ? (capitalA || 0) + (capitalB || 0)
      : parseNumber(get('outstanding_balance'));

    return {
      loan_id: get('loan_id') ? String(get('loan_id')).trim() : null,
      client: get('client') ? String(get('client')).trim() : null,
      amount: parseNumber(get('amount')),
      outstanding_balance: balance,
      interest_rate: parseNumber(get('interest_rate')),
      loan_status: get('loan_status') ? String(get('loan_status')).trim() : null,
      start_date: parseDate(get('start_date')),
      end_date: parseDate(get('end_date')),
      loan_type: get('loan_type') ? String(get('loan_type')).trim() : null,
      days_overdue: parseNumber(get('days_overdue')),
      currency: get('currency') ? String(get('currency')).trim() : 'MXN',
      industry: get('industry') ? String(get('industry')).trim() : null,
      state: get('state') ? String(get('state')).trim() : null,
      file_date: parseDate(get('file_date')) || fallbackFileDate,
    };
  }).filter(row => Object.values(row).some(v => v !== null && v !== ''));

  return { standardized, mappingReport: notes };
}

function activeRows(rows: StandardLoan[]) {
  return rows.filter(r => !PAID_STATUSES.includes(normalize(r.loan_status)));
}

function latestRows(rows: StandardLoan[]) {
  const dates = Array.from(new Set(rows.map(r => r.file_date).filter(Boolean) as string[])).sort();
  const latest = dates[dates.length - 1] || null;
  return { latest, rows: latest ? rows.filter(r => r.file_date === latest) : rows };
}

function sum(rows: StandardLoan[]) {
  return rows.reduce((acc, r) => acc + (r.outstanding_balance || 0), 0);
}

function pct(value: number, total: number) {
  return total > 0 ? value / total : 0;
}

function fmtMoney(value: number) {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(value);
}

function fmtPct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function quality(rows: StandardLoan[]) {
  const total = sum(rows);
  const groups = {
    vigente: rows.filter(r => (r.days_overdue || 0) === 0),
    atrasada: rows.filter(r => (r.days_overdue || 0) >= 1 && (r.days_overdue || 0) <= 90),
    vencida: rows.filter(r => (r.days_overdue || 0) > 90),
  };
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => {
    const balance = sum(v);
    return [k, { count: v.length, balance, pct: pct(balance, total) }];
  }));
}

function dpdDistribution(rows: StandardLoan[]) {
  const total = sum(rows);
  const buckets = [
    { bucket: '0 dias', min: 0, max: 0 },
    { bucket: '1-30', min: 1, max: 30 },
    { bucket: '31-60', min: 31, max: 60 },
    { bucket: '61-90', min: 61, max: 90 },
    { bucket: '91-180', min: 91, max: 180 },
    { bucket: '>180', min: 181, max: Infinity },
  ];
  return buckets.map(b => {
    const items = rows.filter(r => (r.days_overdue || 0) >= b.min && (r.days_overdue || 0) <= b.max);
    const balance = sum(items);
    return { bucket: b.bucket, count: items.length, balance, pct: pct(balance, total) };
  });
}

function groupBy(rows: StandardLoan[], field: keyof StandardLoan, limit = 10) {
  const total = sum(rows);
  const map = new Map<string, StandardLoan[]>();
  for (const row of rows) {
    const key = String(row[field] || '').trim();
    if (!key || ['total', 'top', 'otros'].includes(normalize(key))) continue;
    map.set(key, [...(map.get(key) || []), row]);
  }
  return Array.from(map.entries())
    .map(([name, items]) => {
      const balance = sum(items);
      return {
        name,
        count: items.length,
        balance,
        pct: pct(balance, total),
        severity: field === 'client' && pct(balance, total) > 0.2 ? 'high' : field === 'client' && pct(balance, total) > 0.1 ? 'medium' : 'low',
      };
    })
    .sort((a, b) => b.balance - a.balance)
    .slice(0, limit);
}

function loanTypeProfile(rows: StandardLoan[]) {
  const total = sum(rows);
  const map = new Map<string, StandardLoan[]>();
  for (const row of rows) {
    const key = String(row.loan_type || '').trim();
    if (!key) continue;
    map.set(key, [...(map.get(key) || []), row]);
  }
  return Array.from(map.entries()).map(([name, items]) => {
    const balance = sum(items);
    const avg = (field: keyof StandardLoan) => {
      const values = items.map(i => Number(i[field])).filter(Number.isFinite);
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    };
    const terms = items.map(i => {
      if (!i.start_date || !i.end_date) return null;
      const a = new Date(i.start_date).getTime();
      const b = new Date(i.end_date).getTime();
      return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / (86400 * 1000 * 30.44) : null;
    }).filter((v): v is number => v !== null);
    return {
      name,
      count: items.length,
      balance,
      pct: pct(balance, total),
      avg_interest_rate: avg('interest_rate'),
      avg_term_months: terms.length ? terms.reduce((a, b) => a + b, 0) / terms.length : null,
      avg_days_overdue: avg('days_overdue'),
      min_amount: Math.min(...items.map(i => i.amount || 0).filter(v => v > 0)),
      max_amount: Math.max(...items.map(i => i.amount || 0).filter(v => v > 0)),
      avg_amount: avg('amount'),
    };
  }).sort((a, b) => b.balance - a.balance);
}

function buckets(rows: StandardLoan[], field: 'amount' | 'outstanding_balance') {
  const values = rows.map(r => r[field]).filter((v): v is number => v !== null && Number.isFinite(v));
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const hi = min === max ? min + 1 : max;
  const total = rows.reduce((acc, row) => acc + (row[field] || 0), 0);
  return Array.from({ length: 5 }, (_, i) => {
    const lo = min + i * (hi - min) / 5;
    const upper = min + (i + 1) * (hi - min) / 5;
    const items = rows.filter(r => {
      const value = r[field];
      return value !== null && value >= lo && (i === 4 ? value <= upper : value < upper);
    });
    const balance = items.reduce((acc, row) => acc + (row[field] || 0), 0);
    return { bucket: `${fmtMoney(lo)} - ${fmtMoney(upper)}`, count: items.length, balance, pct: pct(balance, total) };
  });
}

function validate(rows: StandardLoan[]) {
  const issues: Array<{ loan_id: string; rule_id: string; field: string; message: string; severity: Severity }> = [];
  const byDateId = new Set<string>();
  const duplicates = new Set<string>();

  rows.forEach((r, index) => {
    const loanId = r.loan_id || `fila ${index + 1}`;
    const critical: Array<keyof StandardLoan> = ['loan_id', 'client', 'amount', 'outstanding_balance', 'interest_rate', 'loan_type', 'days_overdue', 'start_date', 'end_date'];
    critical.forEach(field => {
      if (r[field] === null || r[field] === undefined || r[field] === '') {
        issues.push({ loan_id: loanId, rule_id: 'missing', field, message: `Campo requerido sin mapear o vacío: ${field}`, severity: 'high' });
      }
    });
    if ((r.amount || 0) <= 0) issues.push({ loan_id: loanId, rule_id: 'amount_positive', field: 'amount', message: 'amount debe ser mayor a cero', severity: 'high' });
    if ((r.outstanding_balance || 0) < 0) issues.push({ loan_id: loanId, rule_id: 'balance_non_negative', field: 'outstanding_balance', message: 'outstanding_balance no puede ser negativo', severity: 'high' });
    if (r.amount !== null && r.outstanding_balance !== null && r.outstanding_balance > r.amount) issues.push({ loan_id: loanId, rule_id: 'balance_lte_amount', field: 'outstanding_balance', message: 'outstanding_balance excede amount', severity: 'high' });
    if ((r.interest_rate || 0) < 0) issues.push({ loan_id: loanId, rule_id: 'rate_non_negative', field: 'interest_rate', message: 'interest_rate no puede ser negativa', severity: 'high' });
    if ((r.days_overdue || 0) < 0) issues.push({ loan_id: loanId, rule_id: 'dpd_non_negative', field: 'days_overdue', message: 'days_overdue no puede ser negativo', severity: 'high' });
    if (r.start_date && r.end_date && r.end_date <= r.start_date) issues.push({ loan_id: loanId, rule_id: 'date_order', field: 'end_date', message: 'end_date debe ser posterior a start_date', severity: 'high' });
    if (r.loan_id) {
      const key = `${r.file_date || 'no_date'}::${r.loan_id}`;
      if (byDateId.has(key)) duplicates.add(key);
      byDateId.add(key);
    }
  });

  duplicates.forEach(key => issues.push({ loan_id: key.split('::')[1], rule_id: 'duplicate_loan_id', field: 'loan_id', message: 'loan_id duplicado dentro del mismo file_date', severity: 'high' }));
  return issues;
}

function anomalies(rows: StandardLoan[]) {
  const dates = Array.from(new Set(rows.map(r => r.file_date).filter(Boolean) as string[])).sort();
  if (dates.length < 2) return {};
  const previousDate = dates[dates.length - 2];
  const latestDate = dates[dates.length - 1];
  const prev = activeRows(rows.filter(r => r.file_date === previousDate));
  const latest = activeRows(rows.filter(r => r.file_date === latestDate));
  const prevMap = new Map(prev.filter(r => r.loan_id).map(r => [r.loan_id as string, r]));
  const latestMap = new Map(latest.filter(r => r.loan_id).map(r => [r.loan_id as string, r]));

  const latestTotal = sum(latest);
  const previousTotal = sum(prev);
  const latestMonth = latestDate.slice(0, 7);
  const previousTime = new Date(previousDate).getTime();
  const latestTime = new Date(latestDate).getTime();
  const new_loans = latest.filter(r => r.loan_id && !prevMap.has(r.loan_id)).map(r => ({
    loan_id: r.loan_id,
    outstanding_balance: r.outstanding_balance,
    start_date: r.start_date,
    category: r.start_date?.slice(0, 7) === latestMonth ? 'Expected' : 'Not Expected',
    percentage: pct(r.outstanding_balance || 0, latestTotal),
  }));
  const disappeared_loans = prev.filter(r => r.loan_id && !latestMap.has(r.loan_id)).map(r => {
    const endTime = r.end_date ? new Date(r.end_date).getTime() : 0;
    return {
      loan_id: r.loan_id,
      outstanding_balance: r.outstanding_balance,
      end_date: r.end_date,
      category: endTime > latestTime ? 'Early payment' : endTime > previousTime ? 'On time' : 'Delayed',
      days_overdue_prev: r.days_overdue,
      percentage: pct(r.outstanding_balance || 0, previousTotal),
    };
  });
  const ended_loans = latest.filter(r => r.end_date && r.end_date < latestDate).map(r => ({ loan_id: r.loan_id, outstanding_balance: r.outstanding_balance, end_date: r.end_date, days_overdue: r.days_overdue }));
  const dpd_improvement: any[] = [];
  const dpd_deterioration: any[] = [];
  const dpd_inconsistency: any[] = [];
  const condition_changes: any[] = [];

  latestMap.forEach((current, id) => {
    const prior = prevMap.get(id);
    if (!prior) return;
    const prevDpd = prior.days_overdue || 0;
    const latestDpd = current.days_overdue || 0;
    if (prevDpd >= 1 && latestDpd === 0) dpd_improvement.push({ loan_id: id, days_overdue_prev: prevDpd, days_overdue_latest: latestDpd });
    if (prevDpd === 0 && latestDpd >= 1) dpd_deterioration.push({ loan_id: id, days_overdue_prev: prevDpd, days_overdue_latest: latestDpd });
    if (prevDpd > 0 && latestDpd > 0 && (prevDpd === latestDpd || Math.abs(latestDpd - prevDpd) > 30)) {
      dpd_inconsistency.push({ loan_id: id, days_overdue_prev: prevDpd, days_overdue_latest: latestDpd, delta_days_overdue: latestDpd - prevDpd, category: prevDpd === latestDpd ? 'No change in days' : 'Increment bigger than monthly cadence' });
    }
    (['start_date', 'end_date', 'loan_type', 'industry', 'currency', 'state', 'client'] as Array<keyof StandardLoan>).forEach(field => {
      if ((prior[field] || '') !== (current[field] || '')) condition_changes.push({ loan_id: id, field_changed: field, value_prev: prior[field], value_latest: current[field] });
    });
  });

  return { new_loans, disappeared_loans, ended_loans, dpd_improvement, dpd_deterioration, dpd_inconsistency, condition_changes };
}

export function analyzeLoanTapesLocally(tapes: LoanTape_DB[], selectedTapeId?: string): StructuredLoanTapeAnalysis {
  const allStandardized = tapes.flatMap(tape => {
    const data = tape.extractedData;
    const stored = data?._standardized;
    if (Array.isArray(stored)) return stored as StandardLoan[];
    const rows = Array.isArray(data) ? data : (data?.rows || []);
    return standardizeLoanTape(rows, tape.fileName).standardized;
  });
  const selected = tapes.find(t => t.id === selectedTapeId);
  const selectedRows = selected
    ? (selected.extractedData?._standardized || standardizeLoanTape(Array.isArray(selected.extractedData) ? selected.extractedData : (selected.extractedData?.rows || []), selected.fileName).standardized)
    : allStandardized;
  const active = activeRows(allStandardized);
  const { rows: latest } = latestRows(active.length ? active : selectedRows);
  const q: any = quality(latest);
  const dpd = dpdDistribution(latest);
  const total = sum(latest);
  const loanCount = new Set(latest.map(r => r.loan_id).filter(Boolean)).size;
  const clientCount = new Set(latest.map(r => r.client).filter(Boolean)).size;
  const validation = validate(selectedRows);
  const concentrations = {
    by_client: groupBy(latest, 'client', 20),
    by_loan_type: loanTypeProfile(latest),
    by_state: groupBy(latest, 'state', 20),
    by_industry: groupBy(latest, 'industry', 20),
    buckets_outstanding: buckets(latest, 'outstanding_balance'),
    buckets_amount: buckets(latest, 'amount'),
  };
  const vencidaPct = q.vencida?.pct || 0;
  const atrasadaPct = q.atrasada?.pct || 0;
  const maxClientPct = concentrations.by_client[0]?.pct || 0;
  const riskScore = Math.min(100, Math.round((vencidaPct * 100 * 4) + (atrasadaPct * 100 * 1.5) + (maxClientPct > 0.3 ? 15 : 0) + (validation.length ? 10 : 0)));
  const overallStatus = vencidaPct > 0.1 || riskScore >= 70 ? 'critical' : vencidaPct >= 0.05 || atrasadaPct > 0.2 || riskScore >= 40 ? 'warning' : 'good';

  const findings = [
    ...validation.slice(0, 10).map(v => ({ severity: v.severity, category: 'Calidad de Datos', title: v.rule_id, detail: `${v.loan_id}: ${v.message}`, recommendation: 'Revisar mapeo o dato fuente.' })),
    ...concentrations.by_client.filter(c => c.severity !== 'low').slice(0, 5).map(c => ({ severity: c.severity, category: 'Concentración', title: `Concentración en ${c.name}`, detail: `${fmtPct(c.pct)} del saldo de cartera`, recommendation: 'Revisar límite contractual por acreditado.' })),
  ];

  return {
    overallStatus,
    riskScore,
    executiveSummary: `Análisis local generado con ${loanCount} créditos, ${clientCount} clientes y saldo total ${fmtMoney(total)}. Cartera vigente ${fmtPct(q.vigente?.pct || 0)}, atrasada ${fmtPct(atrasadaPct)} y vencida ${fmtPct(vencidaPct)}.`,
    trendDirection: 'stable',
    portfolioQuality: q,
    dpd_distribution: dpd,
    concentrations,
    anomalies: anomalies(active),
    validation,
    metrics: [
      { name: 'Saldo total outstanding', latestValue: fmtMoney(total), trend: 'stable', status: overallStatus, congruent: true },
      { name: 'Numero de creditos', latestValue: String(loanCount), trend: 'stable', status: 'good', congruent: true },
      { name: 'Numero de clientes', latestValue: String(clientCount), trend: 'stable', status: 'good', congruent: true },
      { name: '% cartera vencida', latestValue: fmtPct(vencidaPct), trend: 'stable', status: vencidaPct > 0.1 ? 'critical' : vencidaPct >= 0.05 ? 'warning' : 'good', congruent: true },
      { name: '% cartera atrasada', latestValue: fmtPct(atrasadaPct), trend: 'stable', status: atrasadaPct > 0.2 ? 'warning' : 'good', congruent: true },
      { name: 'Concentracion max cliente', latestValue: fmtPct(maxClientPct), trend: 'stable', status: maxClientPct > 0.2 ? 'critical' : maxClientPct > 0.1 ? 'warning' : 'good', congruent: true },
    ],
    findings,
    congruencyChecks: [],
  };
}
