import {
  normalizeFinancialNumberString,
  parseFinancialNumber,
  parseNullableFinancialNumber,
} from '../src/lib/numberParsing';
import {
  buildFichaContractual,
  buildMonitoreo,
  buildTransacciones,
} from '../src/lib/export';
import type {
  Client,
  Covenant_DB,
  FinancialStatement_DB,
  Transaction,
} from '../src/db';
import { normalizeFinancialWriteValue } from '../src/db';

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

const parserCases: Array<[unknown, number]> = [
  ['1,234,567.89', 1234567.89],
  ['1.234.567,89', 1234567.89],
  ['12.5%', 12.5],
  ['(1,234.50)', -1234.5],
  ['MXN 2,500', 2500],
  ['', 0],
  ['   ', 0],
];

for (const [input, expected] of parserCases) {
  assertEqual(parseFinancialNumber(input), expected, `parse ${JSON.stringify(input)}`);
}
assertEqual(parseNullableFinancialNumber('   '), null, 'nullable blank');
assertEqual(normalizeFinancialNumberString('(12.5%)'), '-12.5', 'canonical threshold');
assertEqual(normalizeFinancialWriteValue('1,250,000.50'), 1250000.5, 'Supabase numeric write');
assertEqual(normalizeFinancialWriteValue('(25%)'), -25, 'Supabase percentage write');
assertEqual(normalizeFinancialWriteValue(''), 0, 'Supabase blank write');

const transaction = {
  id: 'tx-1',
  clientId: 'client-1',
  name: 'Crédito',
  description: '',
  date: '',
  creditType: 'Simple',
  originalAmount: '1,250,000.50' as unknown as number,
  currency: 'MXN',
  signedAt: '',
  maturityAt: '',
  createdBy: '',
  createdAt: '',
} satisfies Transaction;

const client = {
  id: 'client-1',
  name: 'Prueba',
  taxId: '',
  industry: '',
  score: '',
  currency: 'MXN',
  totalCreditValue: '(2,500,000)' as unknown as number,
  creditType: [],
  contractName: '',
  analystName: '',
  createdBy: '',
  createdAt: '',
  paymentHistory: [],
  currentDue: 0,
  maxDefaultDays: 0,
  maxDefaultAmount: 0,
  defaultFrequency12m: 0,
  opinion: '',
  aforoRequerido: '',
  aforoHistory: [],
  documentation: [],
  reportDate: '',
  frequency: 'mensual',
  lastPeriod: '',
} satisfies Client;

const covenant = {
  id: 'cov-1',
  clientId: 'client-1',
  name: 'Margen',
  type: 'financial',
  formula: 'mapped:ebitda',
  threshold: '12.5%',
  operator: 'gte',
  description: '',
  isCustom: true,
  createdAt: '',
} satisfies Covenant_DB;

const statement = {
  id: 'stmt-1',
  clientId: 'client-1',
  period: '2026-03',
  periodDate: '2026-03-31',
  uploadDate: '',
  fileName: '',
  rawLineItems: [],
  mappedData: {
    revenue: 0,
    cogs: 0,
    operatingExpenses: 0,
    ebitda: 20,
    interestExpense: 0,
    netIncome: 0,
    currentAssets: 0,
    currentLiabilities: 0,
    totalDebt: 0,
    totalAssets: 0,
    equity: 0,
  },
  extraAccounts: [],
} satisfies FinancialStatement_DB;

const transactionSheet = buildTransacciones([transaction]);
assertEqual(transactionSheet.rows[3][2], 1250000.5, 'transaction export amount');

const clientSheet = buildFichaContractual(client, [transaction], [covenant]);
assertEqual(clientSheet.rows[7][1], -2500000, 'client export credit line');
const covenantHeader = clientSheet.rows.findIndex(row => row[0] === 'Covenant');
assertEqual(clientSheet.rows[covenantHeader + 1][3], 12.5, 'contract sheet threshold');

const monitoringSheet = buildMonitoreo([covenant], [statement]);
const monitoringHeader = monitoringSheet.rows.find(row => row[0] === 'COVENANT');
const thresholdColumn = monitoringHeader?.findIndex(cell => cell === 'UMBRAL') ?? -1;
assertEqual(thresholdColumn, 4, 'monitoring threshold column');
const covenantRow = monitoringSheet.rows.find(row => row[0] === covenant.name);
assertEqual(covenantRow?.[thresholdColumn], 12.5, 'monitoring threshold');
const complianceRow = monitoringSheet.rows.find(row => row[2] === 'Cumplimiento');
assertEqual(
  complianceRow?.[thresholdColumn + 1],
  '=IFERROR(IF(F5>=12.5,"CUMPLE","INCUMPLE"),"")',
  'monitoring formula threshold',
);

console.log('Financial number normalization verification passed.');
