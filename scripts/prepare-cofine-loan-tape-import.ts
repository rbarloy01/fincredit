import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { importLoanTapeSheets } from '../src/lib/loanTapeImport';

type Payload = {
  clientName: string;
  fileName: string;
  name: string;
  tapeType: 'credito' | 'factoraje' | 'otro';
  extractedData: {
    _standardized: any[];
    _mappingReport: any[];
    _import: any;
  };
};

function usage() {
  console.error('Usage: node prepare-cofine-loan-tape-import.mjs --out /tmp/cofine.json <xlsx...>');
}

const args = process.argv.slice(2);
let outPath = '';
const files: string[] = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--out') {
    outPath = args[i + 1] || '';
    i += 1;
  } else {
    files.push(args[i]);
  }
}

if (!outPath || !files.length) {
  usage();
  process.exit(1);
}

let previousTotal: number | null = null;
const payloads: Payload[] = [];

for (const file of files.sort()) {
  const fileName = path.basename(file);
  const workbook = XLSX.readFile(file, { cellDates: true });
  const sheets = workbook.SheetNames.map(name => ({
    name,
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, blankrows: false, defval: null }) as any[][],
  }));
  const result = importLoanTapeSheets(sheets, fileName, { previousTotal });
  previousTotal = result.reconciliation.totalBalance;
  const firstType = String(result.standardized.find(row => row.loan_type)?.loan_type || '').toLowerCase();
  const tapeType = /factoraje|factor|cedente/.test(firstType) ? 'factoraje' : (result.standardized.length ? 'credito' : 'otro');
  payloads.push({
    clientName: 'COFINE',
    fileName,
    name: fileName.replace(/\.[^.]+$/, ''),
    tapeType,
    extractedData: {
      _standardized: result.standardized,
      _mappingReport: result.mappingReport,
      _import: result.reconciliation,
    },
  });
  console.error(`${fileName}: ${result.reconciliation.totalRows} filas · ${Math.round(result.reconciliation.totalBalance).toLocaleString('es-MX')} · ${result.reconciliation.severity}`);
}

fs.writeFileSync(outPath, JSON.stringify(payloads));
console.error(`Wrote ${payloads.length} payload(s) to ${outPath}`);
