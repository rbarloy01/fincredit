import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInline, parseMarkdown } from '../src/lib/markdown';

test('headings, bold and lists are parsed (the raw ### and ** never reach the screen)', () => {
  const blocks = parseMarkdown('### Resumen\n\nEl **ROA** subió a *19.0%*.\n\n- uno\n- dos con `código`\n\n1. primero\n2. segundo');
  assert.deepEqual(blocks.map(b => b.t), ['h', 'p', 'ul', 'ol']);
  const h = blocks[0] as any; assert.equal(h.level, 3); assert.equal(h.c[0].v, 'Resumen');
  const p = blocks[1] as any; assert.deepEqual(p.c.map((n: any) => n.t), ['text', 'b', 'text', 'i', 'text']);
  assert.equal((blocks[2] as any).items.length, 2);
});

test('tables are parsed with header, rows and alignment', () => {
  const [t] = parseMarkdown('| Periodo | ROA |\n|:--|--:|\n| mar-26 | 20.2% |\n| abr-26 | **19.0%** |') as any[];
  assert.equal(t.t, 'table');
  assert.equal(t.head.length, 2);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.align, ['left', 'right']);
  assert.equal(t.rows[1][1][0].t, 'b');
});

test('unbalanced markers stay literal and links only allow http(s)', () => {
  assert.deepEqual(parseInline('2 ** 3 y snake_case_name'), [{ t: 'text', v: '2 ** 3 y snake_case_name' }]);
  const nodes = parseInline('ver [doc](https://a.mx/x) y [mal](javascript:alert(1))');
  assert.equal(nodes.filter(n => n.t === 'a').length, 1);
});

test('code fences keep their content verbatim', () => {
  const [c] = parseMarkdown('```\na * b ** c\n```') as any[];
  assert.equal(c.t, 'code');
  assert.equal(c.v, 'a * b ** c');
});

test('a paragraph split over several lines is one paragraph and indented lines continue a list item', () => {
  const blocks = parseMarkdown('línea uno\nlínea dos\n\n- item\n  continúa');
  assert.equal((blocks[0] as any).c.map((n: any) => n.v).join(''), 'línea uno línea dos');
  assert.equal((blocks[1] as any).items.length, 1);
});
