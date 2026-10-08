import React from 'react';
import { parseMarkdown, type Block, type Inline } from '../../lib/markdown';

const Inlines: React.FC<{ nodes: Inline[] }> = ({ nodes }) => (
  <>
    {nodes.map((n, i) => {
      switch (n.t) {
        case 'b': return <strong key={i} className="font-black"><Inlines nodes={n.c} /></strong>;
        case 'i': return <em key={i}><Inlines nodes={n.c} /></em>;
        case 'code': return <code key={i} className="rounded bg-slate-200/70 px-1 py-0.5 font-mono text-[0.92em]">{n.v}</code>;
        case 'a': return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer" className="font-bold text-indigo-600 underline">{n.v}</a>;
        default: return <React.Fragment key={i}>{n.v}</React.Fragment>;
      }
    })}
  </>
);

const HEADING_CLASS = ['text-[15px]', 'text-sm', 'text-[13px]', 'text-[13px]', 'text-xs', 'text-xs'];

const BlockView: React.FC<{ block: Block }> = ({ block }) => {
  switch (block.t) {
    case 'h': return <p className={`${HEADING_CLASS[block.level - 1]} font-black text-slate-900`}><Inlines nodes={block.c} /></p>;
    case 'p': return <p><Inlines nodes={block.c} /></p>;
    case 'ul': return <ul className="list-disc space-y-1 pl-5">{block.items.map((it, i) => <li key={i}><Inlines nodes={it} /></li>)}</ul>;
    case 'ol': return <ol className="list-decimal space-y-1 pl-5">{block.items.map((it, i) => <li key={i}><Inlines nodes={it} /></li>)}</ol>;
    case 'quote': return <blockquote className="border-l-2 border-indigo-300 pl-3 text-slate-600"><Inlines nodes={block.c} /></blockquote>;
    case 'code': return <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-100">{block.v}</pre>;
    case 'hr': return <hr className="border-slate-200" />;
    case 'table': return (
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full border-collapse text-[11px]">
          <thead><tr className="bg-slate-50">{block.head.map((c, i) => <th key={i} style={{ textAlign: block.align[i] || 'left' }} className="border-b border-slate-200 px-2 py-1.5 font-black text-slate-700"><Inlines nodes={c} /></th>)}</tr></thead>
          <tbody>{block.rows.map((r, ri) => <tr key={ri} className="border-b border-slate-100 last:border-0">{r.map((c, ci) => <td key={ci} style={{ textAlign: block.align[ci] || 'left' }} className="px-2 py-1.5 align-top text-slate-700"><Inlines nodes={c} /></td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
};

const MarkdownText: React.FC<{ text: string }> = ({ text }) => {
  const blocks = React.useMemo(() => parseMarkdown(text), [text]);
  return <div className="space-y-2.5">{blocks.map((b, i) => <BlockView key={i} block={b} />)}</div>;
};

export default MarkdownText;
