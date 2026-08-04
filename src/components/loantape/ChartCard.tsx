import React, { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { loadExportModule } from '../../lib/exportLoader';
import { reserveDownloadTarget } from '../../lib/browserDownload';

interface Props {
  title: string;
  subtitle?: string;
  fileName: string;
  captureId?: string;
  registerNode?: (id: string, node: HTMLElement | null) => void;
  right?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

// Card wrapper for a cockpit chart: title + subtitle, a "PNG" export button
// (captures the titled chart region via the shared html2canvas exporter), and
// optional registration of its DOM node so the parent can embed it into Excel.
export default function ChartCard({ title, subtitle, fileName, captureId, registerNode, right, className, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!registerNode || !captureId) return;
    registerNode(captureId, ref.current);
    return () => registerNode(captureId, null);
  }, [registerNode, captureId]);

  const exportPng = async () => {
    if (!ref.current) return;
    setBusy(true);
    const target = reserveDownloadTarget();
    try {
      const { exportToPng } = await loadExportModule();
      await exportToPng(ref.current, fileName, target);
    } catch (e: any) {
      alert(`No se pudo exportar la imagen: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`relative bg-white border border-slate-200 rounded-2xl p-5 ${className || ''}`}>
      <div className="absolute top-3 right-3 flex items-center gap-2 z-10">
        {right}
        <button
          onClick={exportPng}
          disabled={busy}
          title="Exportar esta gráfica como imagen PNG"
          className="flex items-center gap-1 text-[11px] font-bold text-slate-500 hover:text-indigo-600 bg-white border border-slate-200 rounded-lg px-2 py-1 disabled:opacity-50"
        >
          <Download className="w-3.5 h-3.5" /> {busy ? '…' : 'PNG'}
        </button>
      </div>
      <div ref={ref} className="bg-white">
        <p className="text-xs font-black text-slate-700 uppercase tracking-widest pr-16">{title}</p>
        {subtitle && <p className="text-xs text-slate-500 mt-0.5 pr-16">{subtitle}</p>}
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}
