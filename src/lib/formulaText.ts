// "deuda total entre ebitda" → ["ref:totalDebt", "/", "ref:ebitda"]. Pure so the covenant builder can parse as the user types.

export interface FormulaAlias { key: string; label: string }
export interface ParsedFormulaText { tokens: string[]; missing: string[] }

const clean = (v: string) => v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const OPERATORS = ['+', '-', '*', '/', '^', '(', ')'];

const OPERATOR_WORDS: Array<[RegExp, string]> = [
  [/\belevado a\b|\ba la potencia\b|\bpotencia\b|\^/gi, '^'],
  [/\bentre\b|\bdividido por\b|\bdividido entre\b|\bsobre\b|÷|\//gi, '/'],
  [/\bpor\b|\bmultiplicado por\b|\bveces\b|×|\*/gi, '*'],
  [/\bmenos\b|\brestando\b|\bresta\b|-/gi, '-'],
  [/\bmas\b|\bsumando\b|\bsuma\b|\bmás\b|\+/gi, '+'],
  [/\(/g, '('],
  [/\)/g, ')'],
];

export function parseFormulaText(prompt: string, aliases: FormulaAlias[], toNumber: (s: string) => number | null = s => { const n = Number(s.replace(/,/g, '')); return Number.isFinite(n) && s.trim() !== '' ? n : null; }): ParsedFormulaText {
  const sorted = [...aliases].sort((a, b) => b.label.length - a.label.length);
  const strip = (v: string) => v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  let text = ` ${strip(prompt)} `;
  // 1) Recognize FULL account names first, so words like "y" / "por" inside "Bancos y fondos CP" are never read as operators.
  const found: string[] = [];
  for (const alias of sorted) {
    const words = clean(alias.label).split(' ').filter(Boolean);
    if (!words.length) continue;
    const re = new RegExp(`(?<![a-z0-9])${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9]+')}(?![a-z0-9])`, 'g');
    text = text.replace(re, () => { found.push(alias.key); return ` @@${found.length - 1}@@ `; });
  }
  // 2) operator words and symbols
  for (const [re, op] of OPERATOR_WORDS) text = text.replace(re, ` ${op} `);
  const parts = text.split(/\s+/).filter(Boolean);
  const tokens: string[] = [];
  const missing: string[] = [];
  let buffer: string[] = [];
  const flush = () => {
    const raw = buffer.join(' ');
    const phrase = clean(raw);
    buffer = [];
    if (!phrase) return;
    const asNumber = toNumber(raw);
    if (asNumber !== null && /^[\d.,\s]+$/.test(raw)) { tokens.push(`num:${asNumber}`); return; }
    // fuzzy: labels that contain the phrase, or contain every word of it
    const hit = sorted.find(a => clean(a.label).includes(phrase)) || sorted.find(a => phrase.split(' ').every(w => clean(a.label).includes(w)));
    if (hit) tokens.push(`ref:${hit.key}`);
    else missing.push(phrase);
  };
  for (const part of parts) {
    const m = /^@@(\d+)@@$/.exec(part);
    if (m) { flush(); tokens.push(`ref:${found[Number(m[1])]}`); }
    else if (OPERATORS.includes(part)) { flush(); tokens.push(part); }
    else buffer.push(part);
  }
  flush();
  return { tokens, missing };
}
