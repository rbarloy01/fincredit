import React, { useEffect, useState } from 'react';

interface Props {
  show: boolean;
  title?: string;
  messages?: string[];
}

const DEFAULT_MESSAGES = [
  'Almost there...',
  'Working on it...',
  'Reading the files...',
  'Extracting structured data...',
  'Finishing the checks...',
  'Still moving...',
  'Doing the heavy lifting...',
  'Polishing the numbers...',
  'Keeping the spreadsheet calm...',
  'Almost ready to hand it over...',
  'Checking consistency...',
  'One more pass...',
  'Preparing the next screen...',
];

const WorkingOverlay: React.FC<Props> = ({ show, title = 'Processing', messages = DEFAULT_MESSAGES }) => {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (!show) return;
    setIdx(0);
    const timer = window.setInterval(() => setIdx(i => (i + 1) % messages.length), 2200);
    return () => window.clearInterval(timer);
  }, [show, messages.length]);

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/45 backdrop-blur-sm">
      <div className="w-[min(360px,calc(100vw-32px))] rounded-2xl bg-white border border-slate-200 shadow-2xl px-7 py-6 text-center">
        <div className="relative mx-auto mb-4 h-14 w-14">
          <div className="absolute inset-0 rounded-full border-4 border-slate-100" />
          <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-indigo-600 border-r-indigo-300 animate-spin" />
          <div className="absolute inset-3 rounded-full bg-indigo-50" />
        </div>
        <p className="text-sm font-black uppercase tracking-widest text-slate-900">{title}</p>
        <p className="mt-2 text-sm font-semibold text-slate-500">{messages[idx]}</p>
        <div className="mt-5 flex justify-center gap-1.5">
          {messages.slice(0, 4).map((_, i) => (
            <span key={i} className={`h-1.5 rounded-full transition-all ${i === idx % 4 ? 'w-6 bg-indigo-600' : 'w-1.5 bg-slate-200'}`} />
          ))}
        </div>
      </div>
    </div>
  );
};

export default WorkingOverlay;
