
export interface FinancialStatement {
  id: string;
  companyId: string;
  period: string; // e.g., "FY2023", "Q3 2024"
  uploadDate: string;
  data: {
    revenue: number;
    cogs: number;
    operatingExpenses: number;
    ebitda: number;
    interestExpense: number;
    netIncome: number;
    currentAssets: number;
    currentLiabilities: number;
    totalDebt: number;
    totalAssets: number;
    equity: number;
  };
  rawLineItems?: RawFinancialLineItem[];
  mappingSuggestions?: FinancialMappingSuggestion[];
  approvedMappings?: Record<string, keyof FinancialStatement['data'] | 'ignore'>;
}

export interface RawFinancialLineItem {
  name: string;
  value: number;
  source?: string;
}

export interface FinancialMappingSuggestion {
  rawName: string;
  suggestedAccount: keyof FinancialStatement['data'] | 'ignore';
  reason?: string;
}

export interface PaymentRecord {
  month: string;
  principalStatus: 'paid' | 'unpaid' | 'none';
  interestStatus: 'paid' | 'unpaid' | 'none';
}

export interface Covenant {
  id: string;
  name: string;
  formula: string;
  threshold: string;
  operator: 'gt' | 'lt' | 'gte' | 'lte';
  description: string;
}

export interface ManualCovenantValue {
  covenantId: string;
  month: string;
  value: string;
  status: 'good' | 'warning' | 'bad';
}

export interface AforoRecord {
  month: string;
  value: string;
  status: 'good' | 'warning' | 'bad';
}

export interface DocumentationItem {
  id: string;
  name: string;
  date: string;
  periodicity: string;
  isCompliant: boolean;
  comments?: string;
}

export interface ConditionItem {
  id: string;
  name: string;
  isCompliant: boolean;
  comments?: string;
}

export type Frequency = 'mensual' | 'trimestral';
export type Currency = 'MXN' | 'USD' | 'EUR';

export interface Company {
  id: string;
  clientId: string;
  name: string; // This will now represent the client name
  contractName: string; // This will represent the specific contract
  industry: string;
  score: string;
  logo?: string;
  logoLeft?: string;
  logoRight?: string;
  totalCreditValue: number;
  currentDue: number;
  initialBalance: number;
  currency?: Currency;
  maxAmount: number;
  delinquencyDays: number;
  delinquencyMonths12: number;
  paymentHistory: PaymentRecord[];
  opinion: string;
  covenants: Covenant[];
  manualCovenantData: ManualCovenantValue[];
  aforoHistory: AforoRecord[];
  aforoRequerido: string;
  documentation: DocumentationItem[];
  condicionesHacer: ConditionItem[];
  condicionesNoHacer: ConditionItem[];
  statements: FinancialStatement[];
  loanTapeSnapshots?: LoanTapeSnapshot[];
  loanTapeAnalysis?: string;
  analystName?: string;
  reportDate?: string;
  frequency?: Frequency;
  lastPeriod?: string;
  covenantFrequency?: Frequency;
  covenantLastPeriod?: string;
  lastUpdated?: string;
  creditType?: ('Simple' | 'Revolvente' | 'Flex')[];
}

export interface ExtractionResult {
  period: string;
  data: FinancialStatement['data'];
  rawLineItems?: RawFinancialLineItem[];
  mappingSuggestions?: FinancialMappingSuggestion[];
  covenantValues?: { name: string; value: string }[];
}

export interface ContractExtractionResult {
  condicionesHacer: string[];
  condicionesNoHacer: string[];
  covenants: { name: string; threshold: string; description: string }[];
}

export enum AppRoute {
  DASHBOARD = 'dashboard',
  MONITORING_MODEL = 'monitoring_model',
  COMPANIES = 'companies',
  REPORT = 'report'
}

export interface LoanTapeSnapshot {
  id: string;
  name: string; 
  date: string;
  totalPoolBalance: number;
  loanCount: number;
  avgBalance: number;
  avgApr: number;
  weightedAvgLife: number; 
  delinquency1_30?: number; // Count or percentage? Let's use percentage to match the dashboard
  delinquency31_60?: number;
  delinquency61_90?: number;
  delinquency30Plus: number; 
  delinquency60Plus: number;
  delinquency90Plus: number;
  
  // Origination (Current Month)
  newCréditos?: number;
  newClientes?: number;
  biggestPortfolioPct?: number;

  // Concentration
  top3Pct?: number;
  top5Pct?: number;
  top10Pct?: number;

  // Categorization (Loans Desaparecidos)
  expectedVencimiento?: number;
  earlyPayments?: number;
  moraCastigo?: number;

  lastUpdated: string;
  data?: any[]; 
  analysis?: string; 
  chartImage?: string; 
}
