// Small, dependency-free Markdown parser for the AI assistant's answers (headings, bold/italic/code, lists, tables, quotes).
// It produces a plain AST that the UI turns into React elements, so model output is never injected as HTML.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'b' | 'i'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'a'; href: string; v: string };

export type Block =
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'ul' | 'ol'; items: Inline[][] }
  | { t: 'quote'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'hr' }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][]; align: Array<'left' | 'right' | 'center'> };

const TOKEN = /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|\*[^*\s][^*\n]*?\*|(?<![A-Za-z0-9])_[^_\s][^_\n]*?_(?![A-Za-z0-9]))/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ t: 'text', v: text.slice(last, idx) });
    const tok = m[0];
    if (tok.startsWith('**') || tok.startsWith('__')) out.push({ t: 'b', c: parseInline(tok.slice(2, -2)) });
    else if (tok.startsWith('`')) out.push({ t: 'code', v: tok.slice(1, -1) });
    else if (tok.startsWith('[')) { const mm = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(tok)!; out.push({ t: 'a', v: mm[1], href: mm[2] }); }
    else out.push({ t: 'i', c: parseInline(tok.slice(1, -1)) });
    last = idx + tok.length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

const splitRow = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const isSeparator = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { blocks.push({ t: 'p', c: parseInline(para.join(' ').trim()) }); para = []; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      blocks.push({ t: 'code', v: code.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (line.includes('|') && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left') as 'left' | 'right' | 'center');
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]).map(parseInline));
      i--;
      blocks.push({ t: 'table', head: head.map(parseInline), rows, align });
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { flush(); blocks.push({ t: 'h', level: h[1].length, c: parseInline(h[2]) }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ t: 'hr' }); continue; }
    if (/^\s*>\s?/.test(line)) { flush(); blocks.push({ t: 'quote', c: parseInline(line.replace(/^\s*>\s?/, '')) }); continue; }
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flush();
      const kind = ul ? 'ul' : 'ol';
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = (kind === 'ul' ? /^\s*[-*•]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/).exec(lines[i]);
        if (m) { items.push(parseInline(m[1])); i++; continue; }
        // an indented line continues the previous item
        if (items.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s/.test(lines[i])) { items[items.length - 1] = [...items[items.length - 1], { t: 'text', v: ' ' }, ...parseInline(lines[i].trim())]; i++; continue; }
        break;
      }
      i--;
      blocks.push({ t: kind, items });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}
