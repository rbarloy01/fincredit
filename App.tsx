
import React, { useState, useEffect, useMemo } from 'react';
import Sidebar from './components/Sidebar';
import FileUpload from './components/FileUpload';
import FinancialTable from './components/FinancialTable';
import CovenantAlerts from './components/CovenantAlerts';
import ReportView from './components/ReportView';
import LoanTapeDashboardSection from './components/LoanTapeDashboardSection';
import MonitoringModelSection from './components/MonitoringModelSection';
import { Company, AppRoute, FinancialStatement, ExtractionResult, ContractExtractionResult, PaymentRecord, ManualCovenantValue, AforoRecord, DocumentationItem, Covenant, Frequency, ConditionItem } from './types';
import { DEFAULT_COVENANTS, ICONS } from './constants';
import { GeminiService } from './services/geminiService';
import { AiSettings, loadAiSettings } from './types/ai';
import { loadCompaniesFromDb, saveCompaniesToDb } from './services/appDatabase';

const App: React.FC = () => {
  const [route, setRoute] = useState<AppRoute>(AppRoute.DASHBOARD);
  const [companies, setCompanies] = useState<Company[]>(() => {
    const saved = localStorage.getItem('finanalyzer_data_final_v2');
    if (saved) {
      try {
        let parsed = JSON.parse(saved);
        if (!Array.isArray(parsed)) return [];
        
          // Data Migration: Ensure all arrays exist
          return parsed.map((company: any) => {
            const updated = { ...company };
            
            if (!updated.clientId) {
              // Generate a stable clientId based on name if missing
              updated.clientId = updated.name.replace(/\s+/g, '').toUpperCase().substring(0, 6);
            }
            if (!updated.contractName) {
              updated.contractName = "Contrato General";
            }

            if (!updated.currency) {
              updated.currency = 'MXN';
            }

            const monthMap: { [key: string]: number } = {
              'ene': 0, 'feb': 1, 'mar': 2, 'abr': 3, 'may': 4, 'jun': 5,
              'jul': 6, 'ago': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dic': 11
            };
            const toDate = (m: string) => {
              if (!m || (!m.includes('-') && !m.includes(' '))) return 0;
              const separator = m.includes('-') ? '-' : ' ';
              const [mon, yr] = m.split(separator);
              return new Date(2000 + parseInt(yr), monthMap[mon.toLowerCase()] ?? 0, 1).getTime();
            };

            // Force 6 months limit for history and ensure newest first
            if (Array.isArray(updated.paymentHistory) && updated.paymentHistory.length > 0) {
              // Normalize months to uppercase
              updated.paymentHistory = updated.paymentHistory.map((p: any) => ({ ...p, month: p.month.toUpperCase() }));
              // Sort them descending
              updated.paymentHistory.sort((a: any, b: any) => toDate(b.month) - toDate(a.month));
              if (updated.paymentHistory.length > 6) {
                updated.paymentHistory = updated.paymentHistory.slice(0, 6);
              }
            }
            if (Array.isArray(updated.aforoHistory)) {
              updated.aforoHistory = updated.aforoHistory.map((a: any) => {
                let status = a.status;
                if (status === undefined) {
                  status = a.isGood ? 'good' : 'bad';
                }
                return { ...a, month: a.month.toUpperCase(), status };
              });
              // Sort them descending
              updated.aforoHistory.sort((a: any, b: any) => toDate(b.month) - toDate(a.month));
              if (updated.aforoHistory.length > 6) {
                updated.aforoHistory = updated.aforoHistory.slice(0, 6);
              }
            }

            if (Array.isArray(updated.manualCovenantData)) {
              updated.manualCovenantData = updated.manualCovenantData.map((d: any) => {
                let status = d.status;
                if (status === undefined) {
                  status = d.isGood ? 'good' : 'bad';
                }
                return { ...d, status };
              });
            }

            if (!Array.isArray(updated.documentation)) {
            updated.documentation = [
              { id: '1', name: 'Estados Financieros', date: 'nov-25', periodicity: 'Mensual', isCompliant: true, comments: '' },
              { id: '2', name: 'Loan Tape', date: 'dic-25', periodicity: 'Mensual', isCompliant: true, comments: '' },
              { id: '3', name: 'Reporte Buró de Crédito', date: 'dic-25', periodicity: 'Trimestral', isCompliant: true, comments: '' },
              { id: '4', name: 'Reporte Syntage', date: 'jul-25', periodicity: 'Mensual', isCompliant: true, comments: '' },
              { id: '5', name: 'Desglose de Pasivos', date: 'nov-25', periodicity: 'Mensual', isCompliant: true, comments: '' },
            ];
          }
          if (!Array.isArray(updated.condicionesHacer)) {
            updated.condicionesHacer = [
              { id: '1', name: 'Mantener seguros vigentes', isCompliant: true, comments: '' },
              { id: '2', name: 'Notificar cambios en accionistas', isCompliant: true, comments: '' },
            ];
          }
          if (!Array.isArray(updated.condicionesNoHacer)) {
            updated.condicionesNoHacer = [];
          }
          if (!Array.isArray(updated.loanTapeSnapshots)) {
            updated.loanTapeSnapshots = [];
          }
          return updated;
        });
      } catch (e) {
        console.error("Failed to parse data", e);
        return [];
      }
    }
    return [];
  });

  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(() => {
    const saved = localStorage.getItem('finanalyzer_data_final_v2');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed[0].id;
      } catch (e) {}
    }
    return null;
  });

  const [tempExtraction, setTempExtraction] = useState<ExtractionResult | null>(null);
  const [isProcessingNew, setIsProcessingNew] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [isAddingCompany, setIsAddingCompany] = useState(false);
  const [aiSettings, setAiSettings] = useState<AiSettings>(() => loadAiSettings());
  const [newCompanyName, setNewCompanyName] = useState('');
  const [newClientId, setNewClientId] = useState('');
  const [newContractName, setNewContractName] = useState('');
  const [selectedExistingClientId, setSelectedExistingClientId] = useState<string>('new');
  const [isGeneratingOpinion, setIsGeneratingOpinion] = useState(false);
  const [selectedCovenantId, setSelectedCovenantId] = useState<string>('');

  const uniqueClients = useMemo(() => {
    const clients: { id: string, name: string }[] = [];
    const seen = new Set();
    companies.forEach(c => {
      if (!seen.has(c.clientId)) {
        seen.add(c.clientId);
        clients.push({ id: c.clientId, name: c.name });
      }
    });
    return clients;
  }, [companies]);

  const gemini = useMemo(() => new GeminiService(aiSettings), [aiSettings]);

  const generateInitialHistory = (baseDate?: string, frequency: Frequency = 'mensual'): PaymentRecord[] => {
    const months = [];
    let date: Date;
    
    if (baseDate) {
      // Try to parse "dic-25" or "DIC 25" format
      const separator = baseDate.includes('-') ? '-' : ' ';
      const parts = baseDate.split(separator);
      if (parts.length === 2) {
        const monthMap: { [key: string]: number } = {
          'ene': 0, 'feb': 1, 'mar': 2, 'abr': 3, 'may': 4, 'jun': 5,
          'jul': 6, 'ago': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dic': 11
        };
        const m = monthMap[parts[0].toLowerCase()] ?? 0;
        const y = 2000 + parseInt(parts[1]);
        date = new Date(y, m, 1);
      } else {
        date = new Date();
      }
    } else {
      date = new Date();
    }

    const step = frequency === 'mensual' ? 1 : 3;
    
    for (let i = 0; i < 6; i++) {
      const d = new Date(date.getFullYear(), date.getMonth() - (i * step), 1);
      const mLabel = d.toLocaleString('es-MX', { month: 'short' }).toUpperCase().replace('.', '');
      const yLabel = d.toLocaleString('es-MX', { year: '2-digit' });
      months.push({
        month: `${mLabel} ${yLabel}`,
        principalStatus: 'paid' as const,
        interestStatus: 'paid' as const,
      });
    }
    return months;
  };

  const generateInitialCovenantData = (covenants: Company['covenants'], history: PaymentRecord[]): ManualCovenantValue[] => {
    const data: ManualCovenantValue[] = [];
    covenants.forEach(c => {
      history.forEach(h => {
        data.push({
          covenantId: c.id,
          month: h.month,
          value: '0%',
          status: 'good'
        });
      });
    });
    return data;
  };

  const generateInitialAforoHistory = (history: PaymentRecord[]): AforoRecord[] => {
    return history.map(h => ({
      month: h.month,
      value: '1.40',
      status: 'good'
    }));
  };

  const initialDocs: DocumentationItem[] = [
    { id: '1', name: 'Estados Financieros', date: '2025-11-01', periodicity: 'Mensual', isCompliant: true, comments: '' },
    { id: '2', name: 'Loan Tape', date: '2025-12-01', periodicity: 'Mensual', isCompliant: true, comments: '' },
    { id: '3', name: 'Reporte Buró de Crédito', date: '2025-12-01', periodicity: 'Trimestral', isCompliant: true, comments: '' },
    { id: '4', name: 'Reporte Syntage', date: '2025-08-01', periodicity: 'Mensual', isCompliant: true, comments: '' },
    { id: '5', name: 'Desglose de Pasivos', date: '2025-11-01', periodicity: 'Mensual', isCompliant: true, comments: '' },
  ];

  const initialConditions: ConditionItem[] = [
    { id: '1', name: 'Mantener seguros vigentes', isCompliant: true, comments: '' },
    { id: '2', name: 'Notificar cambios en accionistas', isCompliant: true, comments: '' },
  ];

  // Load Persistence
  useEffect(() => {
    if (companies.length === 0) {
      const history = generateInitialHistory();
      const mockCompany: Company = {
        id: 'mock-1',
        clientId: 'VENTUS01',
        contractName: 'Contrato Maestro 2024',
        name: 'Ventus Leasyng',
        industry: 'Arrendamiento',
        score: 'A+',
        logoLeft: 'https://picsum.photos/seed/ventus/200/200',
        logoRight: 'https://picsum.photos/seed/axcess/200/200',
        totalCreditValue: 25000000,
        currentDue: 14363095,
        initialBalance: 25000000,
        maxAmount: 0,
        delinquencyDays: 0,
        delinquencyMonths12: 0,
        paymentHistory: history,
        opinion: "Ventus Leasyng mantiene un excelente historial de pagos, cubriendo puntualmente capital e intereses con un saldo actual de $14.3 millones. Su indicador de aforo se encuentra en un saludable 1.53, por encima del 1.3 requerido. No obstante, la empresa presenta señales de alerta en sus métricas internas al incumplir varios convenios clave: la capitalización está a la mitad del nivel pactado (9% vs 18%), la cartera vencida del 6.93% ya rebasa el límite del 5% y las reservas preventivas de apenas el 23% son insuficientes frente al 50% solicitado.",
        covenants: DEFAULT_COVENANTS,
        manualCovenantData: generateInitialCovenantData(DEFAULT_COVENANTS, history),
        aforoHistory: generateInitialAforoHistory(history),
        aforoRequerido: '1.3',
        currency: 'MXN',
        documentation: initialDocs,
        condicionesHacer: initialConditions,
        condicionesNoHacer: [],
        statements: [],
        loanTapeSnapshots: [
          {
            id: 'sn-1',
            name: 'Cierre Octubre 2025',
            date: '2025-10-31',
            totalPoolBalance: 15200000,
            loanCount: 1240,
            avgBalance: 12258,
            avgApr: 24.5,
            weightedAvgLife: 15.2,
            delinquency1_30: 2.1,
            delinquency31_60: 1.2,
            delinquency61_90: 0.9,
            delinquency30Plus: 4.2,
            delinquency60Plus: 2.1,
            delinquency90Plus: 1.1,
            newCréditos: 218,
            newClientes: 195,
            biggestPortfolioPct: 3.1,
            top3Pct: 8.2,
            top5Pct: 12.1,
            top10Pct: 19.4,
            expectedVencimiento: 310,
            earlyPayments: 65,
            moraCastigo: 22,
            lastUpdated: new Date().toISOString(),
            chartImage: 'https://picsum.photos/seed/chart1/400/400'
          },
          {
            id: 'sn-2',
            name: 'Cierre Noviembre 2025',
            date: '2025-11-30',
            totalPoolBalance: 14850000,
            loanCount: 1215,
            avgBalance: 12222,
            avgApr: 24.2,
            weightedAvgLife: 14.8,
            delinquency1_30: 2.3,
            delinquency31_60: 1.0,
            delinquency61_90: 1.8,
            delinquency30Plus: 5.1,
            delinquency60Plus: 2.8,
            delinquency90Plus: 1.8,
            newCréditos: 205,
            newClientes: 188,
            biggestPortfolioPct: 2.9,
            top3Pct: 7.9,
            top5Pct: 11.8,
            top10Pct: 18.9,
            expectedVencimiento: 295,
            earlyPayments: 72,
            moraCastigo: 25,
            lastUpdated: new Date().toISOString(),
            chartImage: 'https://picsum.photos/seed/chart2/400/400'
          },
          {
            id: 'sn-3',
            name: 'Cierre Diciembre 2025',
            date: '2025-12-31',
            totalPoolBalance: 14363095,
            loanCount: 1190,
            avgBalance: 12069,
            avgApr: 23.8,
            weightedAvgLife: 14.1,
            delinquency1_30: 3.3,
            delinquency31_60: 1.1,
            delinquency61_90: 2.4,
            delinquency30Plus: 6.8,
            delinquency60Plus: 3.5,
            delinquency90Plus: 2.4,
            newCréditos: 212,
            newClientes: 198,
            biggestPortfolioPct: 2.8,
            top3Pct: 7.8,
            top5Pct: 11.4,
            top10Pct: 18.6,
            expectedVencimiento: 318,
            earlyPayments: 76,
            moraCastigo: 27,
            lastUpdated: new Date().toISOString(),
            chartImage: 'https://picsum.photos/seed/chart3/400/400'
          }
        ],
        loanTapeAnalysis: "Se observa un deterioro progresivo en la calidad de la cartera en el último trimestre. El Pool Balance ha disminuido de $15.2M a $14.3M, mientras que la morosidad 90+ ha aumentado del 1.1% al 2.4%. El APR promedio también muestra una ligera tendencia a la baja (24.5% -> 23.8%), lo que podría impactar el margen financiero si no se ajustan las políticas de originación. La congruencia con el contrato se mantiene en términos de Pool Balance mínima, pero la morosidad está rozando los límites de los convenios financieros operativos.",
        frequency: 'mensual',
        lastPeriod: history[history.length - 1].month,
        covenantFrequency: 'mensual',
        covenantLastPeriod: history[history.length - 1].month,
        creditType: ['Simple']
      };
      setCompanies([mockCompany]);
      setSelectedCompanyId('mock-1');
    }
  }, []);

  useEffect(() => {
    loadCompaniesFromDb()
      .then(savedCompanies => {
        if (savedCompanies.length > 0 && companies.length === 0) {
          setCompanies(savedCompanies);
          setSelectedCompanyId(savedCompanies[0].id);
        }
      })
      .catch(error => console.error('Failed to load IndexedDB state', error));
  }, []);

  useEffect(() => {
    if (companies.length > 0) {
      localStorage.setItem('finanalyzer_data_final_v2', JSON.stringify(companies));
      saveCompaniesToDb(companies).catch(error => console.error('Failed to save IndexedDB state', error));
    }
  }, [companies]);

  const activeCompany = useMemo(() => {
    const found = companies.find(c => c.id === selectedCompanyId);
    return found || companies[0];
  }, [companies, selectedCompanyId]);

  const updateActiveCompany = (updates: Partial<Company>) => {
    if (!activeCompany) return;
    setCompanies(prev => prev.map(c => c.id === activeCompany.id ? { ...c, ...updates } : c));
  };

  const handleFinancialsExtracted = (result: ExtractionResult) => {
    setTempExtraction(result);
    setIsProcessingNew(true);
  };


  const getCovenantPeriods = (company: Company): string[] => {
    const freq = company.covenantFrequency || 'mensual';
    const last = company.covenantLastPeriod || 'dic-25';
    const history = generateInitialHistory(last, freq);
    return history.map(h => h.month);
  };

  const handleContractExtracted = (result: ContractExtractionResult) => {
    if (!selectedCompanyId) {
      alert("Por favor selecciona una empresa primero.");
      return;
    }

    const { 
      condicionesHacer = [], 
      condicionesNoHacer = [], 
      covenants = [] 
    } = result;

    if (condicionesHacer.length === 0 && condicionesNoHacer.length === 0 && covenants.length === 0) {
      alert("No se detectaron obligaciones ni covenants en el documento. \n\nPosibles causas:\n1. El archivo es un PDF escaneado (pruebe con una versión de mayor calidad).\n2. Las obligaciones están en anexos no incluidos en las primeras páginas.\n3. El formato del contrato es inusual.");
      return;
    }

    setCompanies(prev => prev.map(c => {
      if (c.id !== selectedCompanyId) return c;

      const newHacer = condicionesHacer.map(name => ({
        id: Math.random().toString(36).substr(2, 9),
        name,
        isCompliant: true,
        comments: 'Extraído de contrato'
      }));

      const newNoHacer = condicionesNoHacer.map(name => ({
        id: Math.random().toString(36).substr(2, 9),
        name,
        isCompliant: true,
        comments: 'Extraído de contrato'
      }));

      const newCovenants = covenants.map(nc => ({
        id: Math.random().toString(36).substr(2, 9),
        name: nc.name,
        threshold: nc.threshold,
        description: nc.description,
        formula: '',
        operator: 'gte' as const
      }));

      // Update manual covenant data for the new covenants
      const currentPeriods = getCovenantPeriods(c);
      const newManualData: ManualCovenantValue[] = [];
      newCovenants.forEach(nc => {
        currentPeriods.forEach(p => {
          newManualData.push({
            covenantId: nc.id,
            month: p,
            value: '',
            status: 'good'
          });
        });
      });

      return {
        ...c,
        condicionesHacer: [...(c.condicionesHacer || []), ...newHacer],
        condicionesNoHacer: [...(c.condicionesNoHacer || []), ...newNoHacer],
        covenants: [...(c.covenants || []), ...newCovenants],
        manualCovenantData: [...(c.manualCovenantData || []), ...newManualData]
      };
    }));

    alert(`¡Extracción completada con éxito! \n\nSe integraron al tablero:\n• ${condicionesHacer.length} Obligaciones de Hacer\n• ${condicionesNoHacer.length} Obligaciones de No Hacer\n• ${covenants.length} Covenants Financieros\n\nPuedes revisarlos en sus respectivas secciones.`);
  };

  const finalizeExtraction = () => {
    if (!tempExtraction || !activeCompany) return;
    const newStatement: FinancialStatement = {
      id: Math.random().toString(36).substr(2, 9),
      companyId: activeCompany.id,
      period: tempExtraction.period,
      uploadDate: new Date().toISOString(),
      data: tempExtraction.data,
      rawLineItems: tempExtraction.rawLineItems || [],
      mappingSuggestions: tempExtraction.mappingSuggestions || [],
      approvedMappings: Object.fromEntries((tempExtraction.mappingSuggestions || []).map(m => [m.rawName, m.suggestedAccount]))
    };
    
    // Update manual covenant data if any values were extracted
    let updatedManualCovenantData = [...activeCompany.manualCovenantData];
    if (tempExtraction.covenantValues) {
      tempExtraction.covenantValues.forEach(cv => {
        const cov = activeCompany.covenants.find(c => c.name.toLowerCase() === cv.name.toLowerCase());
        if (cov) {
          const index = updatedManualCovenantData.findIndex(md => md.covenantId === cov.id && md.month === tempExtraction.period);
          if (index !== -1) {
            updatedManualCovenantData[index] = { ...updatedManualCovenantData[index], value: cv.value };
          }
        }
      });
    }

    setCompanies(prev => prev.map(c => 
      c.id === activeCompany.id 
        ? { 
            ...c, 
            statements: [newStatement, ...c.statements].sort((a,b) => b.period.localeCompare(a.period)),
            manualCovenantData: updatedManualCovenantData
          }
        : c
    ));
    setTempExtraction(null);
    setIsProcessingNew(false);
  };

  const handleAddCompany = () => {
    const trimmedName = newCompanyName.trim();
    if (!trimmedName) return;
    
    const history = generateInitialHistory();
    const finalClientId = newClientId.trim() || Math.random().toString(36).substr(2, 6).toUpperCase();
    
    const newCo: Company = {
      id: Math.random().toString(36).substr(2, 9),
      clientId: finalClientId,
      name: trimmedName,
      contractName: newContractName.trim() || "Contrato General",
      industry: "Industria",
      score: 'N/A',
      logoLeft: '',
      logoRight: '',
      totalCreditValue: 0,
      currentDue: 0,
      initialBalance: 0,
      maxAmount: 0,
      delinquencyDays: 0,
      delinquencyMonths12: 0,
      paymentHistory: history,
      opinion: "",
      covenants: DEFAULT_COVENANTS,
      manualCovenantData: generateInitialCovenantData(DEFAULT_COVENANTS, history),
      aforoHistory: generateInitialAforoHistory(history),
      aforoRequerido: '1.3',
      documentation: initialDocs,
      condicionesHacer: initialConditions,
      condicionesNoHacer: [],
      statements: [],
      covenantFrequency: 'mensual',
      covenantLastPeriod: history[history.length - 1].month,
      creditType: ['Simple']
    };
    setCompanies(prev => [...prev, newCo]);
    setSelectedCompanyId(newCo.id);
    setIsAddingCompany(false);
    setNewCompanyName('');
    setNewClientId('');
    setNewContractName('');
    setSelectedExistingClientId('new');
    setRoute(AppRoute.DASHBOARD);
  };

  const deleteCompany = (id: string) => {
    const filtered = companies.filter(c => c.id !== id);
    setCompanies(filtered);
    if (selectedCompanyId === id) {
      setSelectedCompanyId(filtered.length > 0 ? filtered[0].id : null);
    }
  };

  const duplicateCompany = (co: Company) => {
    const newId = Math.random().toString(36).substr(2, 9);
    const newCo: Company = {
      ...co,
      id: newId,
      contractName: `${co.contractName} (Copia)`,
      lastUpdated: new Date().toISOString()
    };
    setCompanies(prev => [...prev, newCo]);
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>, side: 'left' | 'right') => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (side === 'left') updateActiveCompany({ logoLeft: reader.result as string });
        else updateActiveCompany({ logoRight: reader.result as string });
      };
      reader.readAsDataURL(file);
    }
  };

  const updateManualCovenant = (covenantId: string, month: string, field: 'value' | 'status', val: any) => {
    const newData = activeCompany.manualCovenantData.map(d => 
      (d.covenantId === covenantId && d.month === month) ? { ...d, [field]: val } : d
    );
    updateActiveCompany({ manualCovenantData: newData });
  };

  const updateCovenant = (covenantId: string, updates: Partial<Covenant>) => {
    const newCovenants = activeCompany.covenants.map(c => 
      c.id === covenantId ? { ...c, ...updates } : c
    );
    updateActiveCompany({ covenants: newCovenants });
  };

  const addCovenant = () => {
    const newId = Math.random().toString(36).substr(2, 9);
    const newCov: Covenant = {
      id: newId,
      name: "Nuevo Covenant",
      description: "Descripción del covenant",
      threshold: "",
      formula: "",
      operator: "gte"
    };
    
    const newCovenants = [...activeCompany.covenants, newCov];
    const newManualData = [
      ...activeCompany.manualCovenantData,
      ...activeCompany.paymentHistory.map(h => ({
        covenantId: newId,
        month: h.month,
        value: "",
        status: 'good'
      }))
    ];
    
    updateActiveCompany({ 
      covenants: newCovenants,
      manualCovenantData: newManualData
    });
  };

  const deleteCovenant = (covenantId: string) => {
    const newCovenants = activeCompany.covenants.filter(c => c.id !== covenantId);
    const newManualData = activeCompany.manualCovenantData.filter(d => d.covenantId !== covenantId);
    updateActiveCompany({ 
      covenants: newCovenants,
      manualCovenantData: newManualData
    });
  };

  const updateAforoHistory = (month: string, field: 'value' | 'status', val: any) => {
    const newData = activeCompany.aforoHistory.map(d => 
      d.month === month ? { ...d, [field]: val } : d
    );
    updateActiveCompany({ aforoHistory: newData });
  };

  const updateDocumentation = (id: string, field: keyof DocumentationItem, val: any) => {
    const newDocs = activeCompany.documentation.map(doc => 
      doc.id === id ? { ...doc, [field]: val } : doc
    );
    updateActiveCompany({ documentation: newDocs });
  };

  const updateCondition = (id: string, module: 'condicionesHacer' | 'condicionesNoHacer', field: keyof ConditionItem, val: any) => {
    const currentItems = activeCompany[module] || [];
    const newItems = currentItems.map(item => 
      item.id === id ? { ...item, [field]: val } : item
    );
    updateActiveCompany({ [module]: newItems });
  };

  const addDocumentationItem = () => {
    const newItem: DocumentationItem = {
      id: Math.random().toString(36).substr(2, 9),
      name: 'Nuevo Documento',
      date: '',
      periodicity: 'Mensual',
      isCompliant: true,
      comments: ''
    };
    updateActiveCompany({ documentation: [...activeCompany.documentation, newItem] });
  };

  const addConditionItem = (module: 'condicionesHacer' | 'condicionesNoHacer') => {
    const newItem: ConditionItem = {
      id: Math.random().toString(36).substr(2, 9),
      name: 'Nueva Condición',
      isCompliant: true,
      comments: ''
    };
    const currentItems = activeCompany[module] || [];
    updateActiveCompany({ [module]: [...currentItems, newItem] });
  };

  const deleteDocumentationItem = (id: string) => {
    updateActiveCompany({ documentation: activeCompany.documentation.filter(doc => doc.id !== id) });
  };

  const deleteConditionItem = (id: string, module: 'condicionesHacer' | 'condicionesNoHacer') => {
    const currentItems = activeCompany[module] || [];
    updateActiveCompany({ [module]: currentItems.filter(item => item.id !== id) });
  };

  const togglePayment = (index: number, field: 'principalStatus' | 'interestStatus') => {
    const history = [...activeCompany.paymentHistory];
    const current = history[index][field];
    history[index][field] = current === 'paid' ? 'unpaid' : (current === 'unpaid' ? 'none' : 'paid');
    updateActiveCompany({ paymentHistory: history });
  };

  const generateMailOpinion = async () => {
    setIsGeneratingOpinion(true);
    try {
      // Use the first statement if available, otherwise create a dummy one for the prompt
      const statement = activeCompany.statements.length > 0 
        ? activeCompany.statements[0] 
        : { 
            period: activeCompany.paymentHistory[0]?.month || 'Actual', 
            data: { 
              totalDebt: activeCompany.currentDue, 
              ebitda: 1, // Default to avoid division by zero
              interestExpense: 1,
              revenue: 0, cogs: 0, operatingExpenses: 0, netIncome: 0, currentAssets: 0, currentLiabilities: 0, totalAssets: 0, equity: 0
            } 
          };
      const op = await gemini.generateOpinion(activeCompany, statement as any);
      updateActiveCompany({ opinion: op });
    } catch (error) {
      console.error(error);
    } finally {
      setIsGeneratingOpinion(false);
    }
  };

  const recalculatePeriods = () => {
    if (!activeCompany) return;
    const newHistory = generateInitialHistory(activeCompany.lastPeriod, activeCompany.frequency);
    
    // We want to use exactly these 6 months, but preserve status if they already existed
    const existingHistory = activeCompany.paymentHistory || [];
    
    const limitedHistory = newHistory.map(nh => {
      const existing = existingHistory.find(eh => {
        // Normalize comparison by removing separators and case
        const norm = (s: string) => s.toLowerCase().replace(/[-\s]/g, '');
        return norm(eh.month) === norm(nh.month);
      });
      return existing ? { ...nh, principalStatus: existing.principalStatus, interestStatus: existing.interestStatus } : nh;
    });
    
    const newAforoHistory = limitedHistory.map(h => {
      const existing = activeCompany.aforoHistory.find(ah => {
        const norm = (s: string) => s.toLowerCase().replace(/[-\s]/g, '');
        return norm(ah.month) === norm(h.month);
      });
      return existing ? { ...existing, month: h.month } : { month: h.month, value: '1.40', status: 'good' };
    });

    updateActiveCompany({
      paymentHistory: limitedHistory,
      aforoHistory: newAforoHistory
    });
  };

  const recalculateCovenantPeriods = () => {
    if (!activeCompany) return;
    const freq = activeCompany.covenantFrequency || 'mensual';
    const last = activeCompany.covenantLastPeriod || 'dic-25';
    const history = generateInitialHistory(last, freq);
    
    // Preserve existing data if month and covenantId match
    const existingData = activeCompany.manualCovenantData || [];
    const newData = [];

    const norm = (s: string) => s.toLowerCase().replace(/[-\s]/g, '');

    for (const cov of activeCompany.covenants) {
      for (const h of history) {
        const existing = existingData.find(ed => 
          ed.covenantId === cov.id && norm(ed.month) === norm(h.month)
        );
        if (existing) {
          newData.push({ ...existing, month: h.month });
        } else {
          newData.push({
            covenantId: cov.id,
            month: h.month,
            value: '0%',
            status: 'good' as const
          });
        }
      }
    }

    updateActiveCompany({
      manualCovenantData: newData
    });
  };

  const renderDashboard = () => {
    if (!activeCompany) return <div className="p-20 text-center"><button onClick={() => setIsAddingCompany(true)} className="bg-bluebonnet text-white px-8 py-3 rounded-2xl font-bold">+ Crear Primer Perfil</button></div>;

    return (
        <div className="space-y-8 animate-in fade-in duration-500 pb-20">
          <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div className="flex items-center gap-6">
              <div className="flex gap-2">
                <div className="relative group">
                  <div className="w-16 h-16 bg-white border-2 border-dashed border-slate-200 rounded-2xl flex items-center justify-center overflow-hidden cursor-pointer hover:border-indigo-400 transition-all">
                    {activeCompany.logoLeft ? (
                      <img src={activeCompany.logoLeft} alt="Logo Left" className="w-full h-full object-contain" />
                    ) : (
                      <div className="text-slate-300 flex flex-col items-center">
                        <ICONS.Upload />
                        <span className="text-[7px] font-black uppercase mt-1">Logo Izq</span>
                      </div>
                    )}
                    <input type="file" accept="image/*" onChange={(e) => handleLogoUpload(e, 'left')} className="absolute inset-0 opacity-0 cursor-pointer" />
                  </div>
                </div>
                <div className="relative group">
                  <div className="w-16 h-16 bg-white border-2 border-dashed border-slate-200 rounded-2xl flex items-center justify-center overflow-hidden cursor-pointer hover:border-indigo-400 transition-all">
                    {activeCompany.logoRight ? (
                      <img src={activeCompany.logoRight} alt="Logo Right" className="w-full h-full object-contain" />
                    ) : (
                      <div className="text-slate-300 flex flex-col items-center">
                        <ICONS.Upload />
                        <span className="text-[7px] font-black uppercase mt-1">Logo Der</span>
                      </div>
                    )}
                    <input type="file" accept="image/*" onChange={(e) => handleLogoUpload(e, 'right')} className="absolute inset-0 opacity-0 cursor-pointer" />
                  </div>
                </div>
              </div>
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <h1 className="text-4xl font-black text-trueblue tracking-tight">{activeCompany.name}</h1>
                  <span className="bg-slate-100 text-slate-500 px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest border border-slate-200">ID: {activeCompany.clientId}</span>
                </div>
                <p className="text-[#0066E699] font-medium">Contrato: {activeCompany.contractName}</p>
              </div>
            </div>
            <div className="flex gap-3 w-full md:w-auto">
              <select 
                value={activeCompany.id} 
                onChange={(e) => setSelectedCompanyId(e.target.value)}
                className="flex-1 bg-white border border-slate-200 px-4 py-3 rounded-2xl font-bold text-slate-700 shadow-sm outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {companies.map(c => <option key={c.id} value={c.id}>{c.name} - {c.contractName}</option>)}
              </select>
              <button onClick={() => setRoute(AppRoute.REPORT)} className="bg-bluebonnet text-white px-6 py-3 rounded-2xl font-bold hover:bg-trueblue transition-all shadow-lg shadow-[#0018E633]">Vista de Reporte</button>
              <button onClick={() => deleteCompany(activeCompany.id)} className="bg-rose-50 text-rose-600 p-3 rounded-2xl hover:bg-rose-100 transition-all" title="Eliminar Perfil">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </header>

          <div className="space-y-8">
            {/* Gestión de Perfil */}
            <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm relative">
              <div className="absolute top-0 left-0 w-2 h-full bg-bluebonnet"></div>
              <h3 className="text-xl font-bold text-trueblue mb-6 flex items-center gap-2">
                <ICONS.Companies /> Perfil del Cliente y Contrato
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">Nombre del Cliente</label>
                  <input type="text" value={activeCompany.name} onChange={e => updateActiveCompany({ name: e.target.value })} className="w-full bg-slate-50 border-none px-4 py-3 rounded-xl font-bold text-sm outline-none ring-1 ring-slate-100 focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">ID de Cliente</label>
                  <input type="text" value={activeCompany.clientId} onChange={e => updateActiveCompany({ clientId: e.target.value })} className="w-full bg-slate-50 border-none px-4 py-3 rounded-xl font-mono text-sm font-bold outline-none ring-1 ring-slate-100 focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">Nombre del Contrato</label>
                  <input type="text" value={activeCompany.contractName} onChange={e => updateActiveCompany({ contractName: e.target.value })} className="w-full bg-slate-50 border-none px-4 py-3 rounded-xl font-bold text-sm outline-none ring-1 ring-slate-100 focus:ring-2 focus:ring-indigo-500" />
                </div>
              </div>
            </div>

            {/* Subida de Documentos */}
            <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm relative">
              <div className="absolute top-0 left-0 w-2 h-full bg-bluebonnet"></div>
              <h3 className="text-xl font-bold text-trueblue mb-6 flex items-center gap-2">
                <ICONS.Upload /> Subida de Documentos
              </h3>
              <FileUpload 
                onFinancialsExtracted={handleFinancialsExtracted} 
                onContractExtracted={handleContractExtracted}
                gemini={gemini}
                companyCovenants={activeCompany.covenants.map(c => c.name)}
              />
            </div>

            {/* Configuración de Periodos */}
            <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm relative">
              <div className="absolute top-0 left-0 w-2 h-full bg-indigo-500"></div>
              <h3 className="text-xl font-bold text-trueblue mb-6 flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                Configuración de Periodos
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">Frecuencia</label>
                  <select 
                    value={activeCompany.frequency || 'mensual'} 
                    onChange={e => updateActiveCompany({ frequency: e.target.value as any })}
                    className="w-full bg-slate-50 border-none px-4 py-3 rounded-xl font-bold outline-none ring-1 ring-slate-100 focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="mensual">Mensual</option>
                    <option value="trimestral">Trimestral</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">Último Periodo (ej. DIC 25)</label>
                  <input 
                    type="text" 
                    value={activeCompany.lastPeriod || ''} 
                    onChange={e => updateActiveCompany({ lastPeriod: e.target.value })} 
                    placeholder="mes-año"
                    className="w-full bg-slate-50 border-none px-4 py-3 rounded-xl font-mono text-lg font-bold outline-none ring-1 ring-slate-100 focus:ring-2 focus:ring-indigo-500" 
                  />
                </div>
                <div>
                  <button 
                    onClick={recalculatePeriods}
                    className="w-full bg-bluebonnet text-white px-6 py-3.5 rounded-xl font-bold hover:bg-trueblue transition-all shadow-lg shadow-[#0018E633]"
                  >
                    Recalcular Periodos
                  </button>
                </div>
              </div>
            </div>

            {/* Información General */}
            <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm relative">
              <div className="absolute top-0 left-0 w-2 h-full bg-bluebonnet"></div>
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-bold text-trueblue flex items-center gap-2">
                  <ICONS.Alert /> Información de Exposición
                </h3>
                <div className="flex items-center gap-3 bg-slate-50 p-1.5 rounded-xl ring-1 ring-slate-100">
                  <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-2">Divisa:</span>
                  {(['MXN', 'USD', 'EUR'] as const).map(curr => (
                    <button
                      key={curr}
                      onClick={() => updateActiveCompany({ currency: curr })}
                      className={`px-3 py-1 rounded-lg text-[10px] font-black transition-all ${activeCompany.currency === curr ? 'bg-bluebonnet text-white shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                    >
                      {curr}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">Línea de Crédito Total ($ {activeCompany.currency || 'MXN'})</label>
                  <input type="number" value={activeCompany.totalCreditValue} onChange={e => updateActiveCompany({ totalCreditValue: Number(e.target.value) })} className="w-full bg-slate-50 border-none px-4 py-3 rounded-xl font-mono text-lg font-bold outline-none ring-1 ring-slate-100 focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">Saldo Actual ($ {activeCompany.currency || 'MXN'})</label>
                  <input type="number" value={activeCompany.currentDue} onChange={e => updateActiveCompany({ currentDue: Number(e.target.value) })} className="w-full bg-slate-50 border-none px-4 py-3 rounded-xl font-mono text-lg font-bold outline-none ring-1 ring-slate-100 focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">Saldo Inicial ($ {activeCompany.currency || 'MXN'})</label>
                  <input type="number" value={activeCompany.initialBalance} onChange={e => updateActiveCompany({ initialBalance: Number(e.target.value) })} className="w-full bg-slate-50 border-none px-4 py-3 rounded-xl font-mono text-lg font-bold outline-none ring-1 ring-slate-100 focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">Tipo de Crédito</label>
                  <div className="flex flex-wrap gap-2">
                    {['Simple', 'Revolvente', 'Flex'].map((type) => (
                      <label key={type} className="flex items-center gap-2 bg-slate-50 px-3 py-2 rounded-xl cursor-pointer hover:bg-slate-100 transition-all ring-1 ring-slate-100">
                        <input 
                          type="checkbox" 
                          checked={(activeCompany.creditType || []).includes(type as any)}
                          onChange={(e) => {
                            const current = activeCompany.creditType || [];
                            const next = e.target.checked 
                              ? [...current, type as any]
                              : current.filter(t => t !== type);
                            updateActiveCompany({ creditType: next });
                          }}
                          className="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500"
                        />
                        <span className="text-sm font-bold text-slate-700">{type}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">Score AXCESS</label>
                  <input type="text" value={activeCompany.score} onChange={e => updateActiveCompany({ score: e.target.value })} className="w-full bg-slate-50 border-none px-4 py-3 rounded-xl font-mono text-lg font-bold outline-none ring-1 ring-slate-100 focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">Industria / Sector</label>
                  <input type="text" value={activeCompany.industry} onChange={e => updateActiveCompany({ industry: e.target.value })} className="w-full bg-slate-50 border-none px-4 py-3 rounded-xl font-bold text-sm outline-none ring-1 ring-slate-100 focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div className="md:col-span-2 grid grid-cols-3 gap-4 border-t border-slate-100 pt-6 mt-2">
                  <div>
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Atrasos (12 Meses)</label>
                    <input type="number" value={activeCompany.delinquencyMonths12} onChange={e => updateActiveCompany({ delinquencyMonths12: Number(e.target.value) })} className="w-full bg-slate-50 px-3 py-2 rounded-lg font-mono text-sm outline-none" />
                  </div>
                  <div>
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Días de Incumplimiento</label>
                    <input type="number" value={activeCompany.delinquencyDays} onChange={e => updateActiveCompany({ delinquencyDays: Number(e.target.value) })} className="w-full bg-slate-50 px-3 py-2 rounded-lg font-mono text-sm outline-none" />
                  </div>
                  <div>
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Monto Máximo ($)</label>
                    <input type="number" value={activeCompany.maxAmount} onChange={e => updateActiveCompany({ maxAmount: Number(e.target.value) })} className="w-full bg-slate-50 px-3 py-2 rounded-lg font-mono text-sm outline-none" />
                  </div>
                </div>
              </div>
            </div>

            {/* Aforo */}
            <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm relative">
              <div className="absolute top-0 left-0 w-2 h-full bg-cyan"></div>
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-bold text-trueblue">Aforo</h3>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Requerido:</span>
                  <input type="text" value={activeCompany.aforoRequerido} onChange={e => updateActiveCompany({ aforoRequerido: e.target.value })} className="w-16 bg-slate-50 border-none px-2 py-1 rounded-lg font-mono font-bold text-center outline-none ring-1 ring-slate-100 focus:ring-2 focus:ring-emerald-500" />
                </div>
              </div>
              <div className="grid grid-cols-6 gap-3">
                {activeCompany.aforoHistory.map((a, i) => (
                  <div key={`aforo-${i}`} className="text-center">
                    <p className="text-[10px] font-bold text-slate-400 mb-2">{a.month}</p>
                    <div className="space-y-2">
                      <input 
                        type="text" 
                        value={a.value} 
                        onChange={e => updateAforoHistory(a.month, 'value', e.target.value)}
                        className={`w-full border-none px-2 py-2 rounded-xl font-mono text-xs font-bold text-center outline-none ring-1 ${
                          a.status === 'good' ? 'bg-slate-50 ring-emerald-100 text-emerald-600' : 
                          a.status === 'warning' ? 'bg-amber-50 ring-amber-100 text-amber-600' : 
                          'bg-rose-50 ring-rose-100 text-rose-600'
                        }`}
                      />
                      <button 
                        onClick={() => {
                          const nextStatus = a.status === 'good' ? 'warning' : a.status === 'warning' ? 'bad' : 'good';
                          updateAforoHistory(a.month, 'status', nextStatus);
                        }}
                        className={`w-full py-1 rounded-lg text-[8px] font-black uppercase transition-all ${
                          a.status === 'good' ? 'bg-emerald-100 text-emerald-700' : 
                          a.status === 'warning' ? 'bg-amber-100 text-amber-700' : 
                          'bg-rose-100 text-rose-700'
                        }`}
                      >
                        {a.status === 'good' ? 'Cumple' : a.status === 'warning' ? 'Alerta' : 'No Cumple'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Covenants Manuales */}
            <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm relative">
              <div className="absolute top-0 left-0 w-2 h-full bg-bluebonnet"></div>
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-bold text-trueblue">Covenants Financieros</h3>
                <div className="flex gap-2">
                  <button 
                    onClick={addCovenant}
                    className="bg-indigo-50 text-indigo-600 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-100 transition-all border border-indigo-100"
                  >
                    + Agregar Covenant
                  </button>
                </div>
              </div>

              <div className="bg-slate-900 text-white p-6 rounded-2xl mb-8">
                <div className="flex flex-col md:flex-row md:items-end gap-4 mb-5">
                  <div className="flex-1">
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Seleccionar covenant</label>
                    <select
                      value={selectedCovenantId || activeCompany.covenants[0]?.id || ''}
                      onChange={e => setSelectedCovenantId(e.target.value)}
                      className="w-full bg-white/10 border border-white/10 px-4 py-3 rounded-xl font-bold outline-none focus:ring-2 focus:ring-blue-400"
                    >
                      {activeCompany.covenants.map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                    Builder / anotación
                  </div>
                </div>

                {activeCompany.covenants
                  .filter(c => c.id === (selectedCovenantId || activeCompany.covenants[0]?.id))
                  .map(c => (
                    <div key={c.id} className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <label>
                        <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Nombre</span>
                        <input
                          value={c.name}
                          onChange={e => updateCovenant(c.id, { name: e.target.value })}
                          className="mt-1 w-full bg-white text-slate-900 px-4 py-3 rounded-xl font-bold outline-none"
                        />
                      </label>
                      <label>
                        <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Umbral contrato</span>
                        <input
                          value={c.threshold}
                          onChange={e => updateCovenant(c.id, { threshold: e.target.value })}
                          className="mt-1 w-full bg-white text-slate-900 px-4 py-3 rounded-xl font-mono font-bold outline-none"
                        />
                      </label>
                      <label className="md:col-span-2">
                        <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Fórmula definida por usuario</span>
                        <input
                          value={c.formula}
                          onChange={e => updateCovenant(c.id, { formula: e.target.value })}
                          placeholder="Ej. totalDebt / equity"
                          className="mt-1 w-full bg-white text-slate-900 px-4 py-3 rounded-xl font-mono font-bold outline-none"
                        />
                      </label>
                      <label className="md:col-span-2">
                        <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Anotación / fuente</span>
                        <textarea
                          value={c.description}
                          onChange={e => updateCovenant(c.id, { description: e.target.value })}
                          placeholder="Cláusula, definición contractual, fuente del cálculo."
                          rows={3}
                          className="mt-1 w-full bg-white text-slate-900 px-4 py-3 rounded-xl text-sm font-bold outline-none"
                        />
                      </label>
                    </div>
                  ))}
              </div>

              {/* Configuración de Periodos de Covenants */}
              <div className="bg-slate-50 p-6 rounded-2xl mb-8 border border-slate-100">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                  <div>
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Frecuencia Covenants</label>
                    <select 
                      value={activeCompany.covenantFrequency || 'mensual'} 
                      onChange={e => updateActiveCompany({ covenantFrequency: e.target.value as any })}
                      className="w-full bg-white border-none px-3 py-2 rounded-lg font-bold outline-none ring-1 ring-slate-200 focus:ring-2 focus:ring-indigo-500 text-sm"
                    >
                      <option value="mensual">Mensual</option>
                      <option value="trimestral">Trimestral</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Último Periodo Covenants</label>
                    <input 
                      type="text" 
                      value={activeCompany.covenantLastPeriod || ''} 
                      onChange={e => updateActiveCompany({ covenantLastPeriod: e.target.value })} 
                      placeholder="ej. DIC 25"
                      className="w-full bg-white border-none px-3 py-2 rounded-lg font-mono font-bold outline-none ring-1 ring-slate-200 focus:ring-2 focus:ring-indigo-500 text-sm" 
                    />
                  </div>
                  <button 
                    onClick={recalculateCovenantPeriods}
                    className="bg-indigo-500 text-white px-4 py-2 rounded-lg font-bold text-xs hover:bg-indigo-600 transition-all shadow-md"
                  >
                    Actualizar Periodos
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className="sticky left-0 bg-white z-10 text-left text-[10px] font-black text-slate-400 uppercase tracking-widest pb-4 min-w-[250px] shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">Indicador</th>
                      {getCovenantPeriods(activeCompany).map((month, i) => (
                        <th key={i} className="text-center text-[10px] font-black text-slate-400 uppercase tracking-widest pb-4 min-w-[100px]">{month}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {activeCompany.covenants.map(c => (
                      <tr key={c.id} className="border-t border-slate-50 group">
                        <td className="sticky left-0 bg-white z-10 py-4 pr-4 min-w-[250px] shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <input 
                                type="text"
                                value={c.name}
                                onChange={e => updateCovenant(c.id, { name: e.target.value })}
                                className="text-sm font-bold text-slate-800 bg-slate-50/50 border border-transparent hover:border-slate-200 focus:bg-white focus:ring-1 focus:ring-indigo-500 rounded px-2 py-1 w-full transition-all"
                              />
                              <div className="flex items-center gap-1 bg-slate-50 px-2 py-1 rounded-lg border border-slate-100 shrink-0">
                                <span className="text-[8px] font-black text-slate-400 uppercase">Req:</span>
                                <input 
                                  value={c.threshold} 
                                  onChange={e => updateCovenant(c.id, { threshold: e.target.value })}
                                  className="w-12 bg-transparent border-none text-[10px] font-bold text-trueblue outline-none text-center"
                                />
                              </div>
                              <button 
                                onClick={() => deleteCovenant(c.id)}
                                className="opacity-0 group-hover:opacity-100 p-1 text-slate-300 hover:text-rose-500 transition-all"
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            </div>
                            <input 
                              type="text"
                              value={c.description}
                              onChange={e => updateCovenant(c.id, { description: e.target.value })}
                              className="text-[10px] text-slate-400 bg-slate-50/30 border border-transparent hover:border-slate-100 focus:bg-white focus:ring-1 focus:ring-indigo-500 rounded px-2 py-0.5 w-full transition-all"
                              placeholder="Descripción del covenant..."
                            />
                          </div>
                        </td>
                        {getCovenantPeriods(activeCompany).map((month, i) => {
                          const data = activeCompany.manualCovenantData.find(d => d.covenantId === c.id && d.month === month);
                          return (
                            <td key={i} className="py-4 px-2">
                              <div className="space-y-1">
                                <input 
                                  type="text" 
                                  value={data?.value || ''} 
                                  onChange={e => updateManualCovenant(c.id, month, 'value', e.target.value)}
                                  className={`w-full border-none px-2 py-2 rounded-xl font-mono text-xs font-bold text-center outline-none ring-1 ${
                                    data?.status === 'good' ? 'bg-slate-50 ring-emerald-100 text-emerald-600' : 
                                    data?.status === 'warning' ? 'bg-amber-50 ring-amber-100 text-amber-600' : 
                                    'bg-rose-50 ring-rose-100 text-rose-600'
                                  }`}
                                />
                                <button 
                                  onClick={() => {
                                    const nextStatus = data?.status === 'good' ? 'warning' : data?.status === 'warning' ? 'bad' : 'good';
                                    updateManualCovenant(c.id, month, 'status', nextStatus);
                                  }}
                                  className={`w-full py-1 rounded-lg text-[8px] font-black uppercase transition-all ${
                                    data?.status === 'good' ? 'bg-emerald-100 text-emerald-700' : 
                                    data?.status === 'warning' ? 'bg-amber-100 text-amber-700' : 
                                    'bg-rose-100 text-rose-700'
                                  }`}
                                >
                                  {data?.status === 'good' ? 'OK' : data?.status === 'warning' ? 'Alerta' : 'FAIL'}
                                </button>
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Historial de Pagos */}
            <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm relative">
              <div className="absolute top-0 left-0 w-2 h-full bg-cyan"></div>
              <h3 className="text-xl font-bold text-trueblue mb-2">Historial de Pagos</h3>
              <p className="text-xs text-slate-400 mb-8 font-medium">Selecciona el estado de pago para Principal e Intereses.</p>
              
              {/* Configuración de Periodos de Pagos */}
              <div className="bg-slate-50 p-6 rounded-2xl mb-8 border border-slate-100">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                  <div>
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Frecuencia Pagos</label>
                    <select 
                      value={activeCompany.frequency || 'mensual'} 
                      onChange={e => updateActiveCompany({ frequency: e.target.value as any })}
                      className="w-full bg-white border-none px-3 py-2 rounded-lg font-bold outline-none ring-1 ring-slate-200 focus:ring-2 focus:ring-indigo-500 text-sm"
                    >
                      <option value="mensual">Mensual</option>
                      <option value="trimestral">Trimestral</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Último Periodo Pagos</label>
                    <input 
                      type="text" 
                      value={activeCompany.lastPeriod || ''} 
                      onChange={e => updateActiveCompany({ lastPeriod: e.target.value })} 
                      placeholder="ej. DIC 25"
                      className="w-full bg-white border-none px-3 py-2 rounded-lg font-mono font-bold outline-none ring-1 ring-slate-200 focus:ring-2 focus:ring-indigo-500 text-sm" 
                    />
                  </div>
                  <button 
                    onClick={recalculatePeriods}
                    className="bg-cyan text-white px-4 py-2 rounded-lg font-bold text-xs hover:opacity-90 transition-all shadow-md"
                  >
                    Actualizar Periodos
                  </button>
                </div>
              </div>

              <div className="space-y-10">
                <div>
                  <h4 className="text-[10px] font-black uppercase text-indigo-500 tracking-tighter mb-4">Principal</h4>
                  <div className="grid grid-cols-6 gap-3">
                    {activeCompany.paymentHistory.map((p, i) => (
                      <div key={`p-${i}`} className="text-center">
                        <p className="text-[10px] font-bold text-slate-400 mb-2">{p.month}</p>
                        <button 
                          onClick={() => togglePayment(i, 'principalStatus')}
                          className={`w-full h-12 rounded-xl flex items-center justify-center text-lg transition-all border-2 ${
                            p.principalStatus === 'paid' ? 'bg-emerald-50 border-emerald-200 text-emerald-600' :
                            p.principalStatus === 'unpaid' ? 'bg-rose-50 border-rose-200 text-rose-600' :
                            'bg-slate-50 border-slate-100 text-slate-200'
                          }`}
                        >
                          {p.principalStatus === 'paid' ? '✓' : p.principalStatus === 'unpaid' ? '✕' : ''}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <h4 className="text-[10px] font-black uppercase text-amber-500 tracking-tighter mb-4">Intereses</h4>
                  <div className="grid grid-cols-6 gap-3">
                    {activeCompany.paymentHistory.map((p, i) => (
                      <div key={`i-${i}`} className="text-center">
                        <p className="text-[10px] font-bold text-slate-400 mb-2">{p.month}</p>
                        <button 
                          onClick={() => togglePayment(i, 'interestStatus')}
                          className={`w-full h-12 rounded-xl flex items-center justify-center text-lg transition-all border-2 ${
                            p.interestStatus === 'paid' ? 'bg-emerald-50 border-emerald-200 text-emerald-600' :
                            p.interestStatus === 'unpaid' ? 'bg-rose-50 border-rose-200 text-rose-600' :
                            'bg-slate-50 border-slate-100 text-slate-200'
                          }`}
                        >
                          {p.interestStatus === 'paid' ? '✓' : p.interestStatus === 'unpaid' ? '✕' : ''}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Resumen y Comentarios */}
            <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm relative">
              <div className="absolute top-0 left-0 w-2 h-full bg-bluebonnet"></div>
              <div className="flex justify-between items-center mb-6">
                <div>
                  <h3 className="text-xl font-bold text-trueblue">Resumen y Comentarios</h3>
                  <p className="text-xs text-slate-400 font-medium italic mt-1">Usa la IA para generar un resumen basado en los datos ingresados.</p>
                </div>
                <button 
                  disabled={isGeneratingOpinion}
                  onClick={generateMailOpinion}
                  className="bg-bluebonnet text-white px-5 py-2.5 rounded-xl text-xs font-bold shadow-lg shadow-[#0018E633] active:scale-95 disabled:opacity-50 transition-all"
                >
                  {isGeneratingOpinion ? 'Generando...' : 'Generar con IA'}
                </button>
              </div>
                <textarea 
                value={activeCompany.opinion}
                onChange={e => updateActiveCompany({ opinion: e.target.value })}
                placeholder="Escribe aquí el resumen o usa el botón de IA..."
                className="w-full h-64 px-6 py-6 border border-slate-200 rounded-[1.5rem] focus:ring-2 focus:ring-bluebonnet outline-none resize-none text-slate-700 leading-relaxed font-mono text-xs whitespace-pre-wrap bg-[#f8fafc80] text-justify"
              />
            </div>

            {/* Documentación */}
            <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm relative">
              <div className="absolute top-0 left-0 w-2 h-full bg-emerald-500"></div>
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-bold text-trueblue">Documentación</h3>
                <button 
                  onClick={addDocumentationItem}
                  className="bg-emerald-50 text-emerald-600 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-emerald-100 transition-all border border-emerald-100"
                >
                  + Agregar Documento
                </button>
              </div>
              <div className="w-full">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className="text-left text-[10px] font-black text-slate-400 uppercase tracking-widest pb-4">Documento</th>
                      <th className="text-center text-[10px] font-black text-slate-400 uppercase tracking-widest pb-4">Fecha</th>
                      <th className="text-center text-[10px] font-black text-slate-400 uppercase tracking-widest pb-4">Periodicidad</th>
                      <th className="text-center text-[10px] font-black text-slate-400 uppercase tracking-widest pb-4">Estatus</th>
                      <th className="text-left text-[10px] font-black text-slate-400 uppercase tracking-widest pb-4 pl-4">Comentarios</th>
                      <th className="pb-4"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.isArray(activeCompany.documentation) && activeCompany.documentation.map((doc) => (
                      <tr key={doc.id} className="border-t border-slate-50 group">
                        <td className="py-3 pr-4">
                          <input 
                            type="text" 
                            value={doc.name} 
                            onChange={e => updateDocumentation(doc.id, 'name', e.target.value)}
                            className="w-full bg-transparent border-none text-xs font-bold text-slate-700 outline-none focus:ring-1 focus:ring-indigo-500 rounded px-1"
                          />
                        </td>
                        <td className="py-3 px-2">
                          <input 
                            type="date" 
                            value={doc.date} 
                            onChange={e => updateDocumentation(doc.id, 'date', e.target.value)}
                            className="w-full bg-slate-50 border-none px-2 py-1.5 rounded-lg font-mono text-[10px] font-bold text-center outline-none ring-1 ring-slate-100 focus:ring-2 focus:ring-indigo-500"
                          />
                        </td>
                        <td className="py-3 px-2">
                          <select 
                            value={doc.periodicity} 
                            onChange={e => updateDocumentation(doc.id, 'periodicity', e.target.value)}
                            className="w-full bg-slate-50 border-none px-2 py-1.5 rounded-lg text-[10px] font-bold text-center outline-none ring-1 ring-slate-100 focus:ring-2 focus:ring-indigo-500"
                          >
                            <option value="Mensual">Mensual</option>
                            <option value="Trimestral">Trimestral</option>
                            <option value="Semestral">Semestral</option>
                            <option value="Anual">Anual</option>
                            <option value="Única vez">Única vez</option>
                          </select>
                        </td>
                        <td className="py-3 px-2">
                          <button 
                            onClick={() => updateDocumentation(doc.id, 'isCompliant', !doc.isCompliant)}
                            className={`w-full py-1.5 rounded-lg text-[10px] font-black uppercase transition-all ${doc.isCompliant ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}
                          >
                            {doc.isCompliant ? '✓' : '✕'}
                          </button>
                        </td>
                        <td className="py-3 pl-4">
                          <input 
                            type="text" 
                            value={doc.comments || ''} 
                            onChange={e => updateDocumentation(doc.id, 'comments', e.target.value)}
                            placeholder="Comentarios..."
                            className="w-full bg-slate-50 border-none px-2 py-1.5 rounded-lg text-[10px] outline-none ring-1 ring-slate-100 focus:ring-2 focus:ring-indigo-500"
                          />
                        </td>
                        <td className="py-3 pl-2 text-right">
                          <button 
                            onClick={() => deleteDocumentationItem(doc.id)}
                            className="opacity-0 group-hover:opacity-100 p-1 text-slate-300 hover:text-rose-500 transition-all"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Condiciones de Hacer */}
            <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm relative">
              <div className="absolute top-0 left-0 w-2 h-full bg-indigo-500"></div>
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-bold text-trueblue">Condiciones de Hacer</h3>
                <div className="flex gap-2">
                  <button 
                    onClick={() => addConditionItem('condicionesHacer')}
                    className="bg-indigo-50 text-indigo-600 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-100 transition-all border border-indigo-100"
                  >
                    + Agregar Condición
                  </button>
                </div>
              </div>
              <div className="w-full">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className="text-left text-[10px] font-black text-slate-400 uppercase tracking-widest pb-4">Condición</th>
                      <th className="text-center text-[10px] font-black text-slate-400 uppercase tracking-widest pb-4">Estatus</th>
                      <th className="text-left text-[10px] font-black text-slate-400 uppercase tracking-widest pb-4 pl-4">Comentarios</th>
                      <th className="pb-4"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.isArray(activeCompany.condicionesHacer) && activeCompany.condicionesHacer.map((item) => (
                      <tr key={item.id} className="border-t border-slate-50 group">
                        <td className="py-3 pr-4">
                          <input 
                            type="text" 
                            value={item.name} 
                            onChange={e => updateCondition(item.id, 'condicionesHacer', 'name', e.target.value)}
                            className="w-full bg-transparent border-none text-xs font-bold text-slate-700 outline-none focus:ring-1 focus:ring-indigo-500 rounded px-1"
                          />
                        </td>
                        <td className="py-3 px-2 w-24">
                          <button 
                            onClick={() => updateCondition(item.id, 'condicionesHacer', 'isCompliant', !item.isCompliant)}
                            className={`w-full py-1.5 rounded-lg text-[10px] font-black uppercase transition-all ${item.isCompliant ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}
                          >
                            {item.isCompliant ? '✓' : '✕'}
                          </button>
                        </td>
                        <td className="py-3 pl-4">
                          <input 
                            type="text" 
                            value={item.comments || ''} 
                            onChange={e => updateCondition(item.id, 'condicionesHacer', 'comments', e.target.value)}
                            placeholder="Comentarios..."
                            className="w-full bg-slate-50 border-none px-2 py-1.5 rounded-lg text-[10px] outline-none ring-1 ring-slate-100 focus:ring-2 focus:ring-indigo-500"
                          />
                        </td>
                        <td className="py-3 pl-2 text-right">
                          <button 
                            onClick={() => deleteConditionItem(item.id, 'condicionesHacer')}
                            className="opacity-0 group-hover:opacity-100 p-1 text-slate-300 hover:text-rose-500 transition-all"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Condiciones de No Hacer */}
            <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm relative">
              <div className="absolute top-0 left-0 w-2 h-full bg-rose-500"></div>
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-bold text-trueblue">Condiciones de No Hacer</h3>
                <div className="flex gap-2">
                  <button 
                    onClick={() => addConditionItem('condicionesNoHacer')}
                    className="bg-rose-50 text-rose-600 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-rose-100 transition-all border border-rose-100"
                  >
                    + Agregar Condición
                  </button>
                </div>
              </div>
              <div className="w-full">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className="text-left text-[10px] font-black text-slate-400 uppercase tracking-widest pb-4">Condición</th>
                      <th className="text-center text-[10px] font-black text-slate-400 uppercase tracking-widest pb-4">Estatus</th>
                      <th className="text-left text-[10px] font-black text-slate-400 uppercase tracking-widest pb-4 pl-4">Comentarios</th>
                      <th className="pb-4"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.isArray(activeCompany.condicionesNoHacer) && activeCompany.condicionesNoHacer.map((item) => (
                      <tr key={item.id} className="border-t border-slate-50 group">
                        <td className="py-3 pr-4">
                          <input 
                            type="text" 
                            value={item.name} 
                            onChange={e => updateCondition(item.id, 'condicionesNoHacer', 'name', e.target.value)}
                            className="w-full bg-transparent border-none text-xs font-bold text-slate-700 outline-none focus:ring-1 focus:ring-indigo-500 rounded px-1"
                          />
                        </td>
                        <td className="py-3 px-2 w-24">
                          <button 
                            onClick={() => updateCondition(item.id, 'condicionesNoHacer', 'isCompliant', !item.isCompliant)}
                            className={`w-full py-1.5 rounded-lg text-[10px] font-black uppercase transition-all ${item.isCompliant ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}
                          >
                            {item.isCompliant ? '✓' : '✕'}
                          </button>
                        </td>
                        <td className="py-3 pl-4">
                          <input 
                            type="text" 
                            value={item.comments || ''} 
                            onChange={e => updateCondition(item.id, 'condicionesNoHacer', 'comments', e.target.value)}
                            placeholder="Comentarios..."
                            className="w-full bg-slate-50 border-none px-2 py-1.5 rounded-lg text-[10px] outline-none ring-1 ring-slate-100 focus:ring-2 focus:ring-indigo-500"
                          />
                        </td>
                        <td className="py-3 pl-2 text-right">
                          <button 
                            onClick={() => deleteConditionItem(item.id, 'condicionesNoHacer')}
                            className="opacity-0 group-hover:opacity-100 p-1 text-slate-300 hover:text-rose-500 transition-all"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Monitoreo de Cartera (Loan Tape) */}
            <LoanTapeDashboardSection 
              company={activeCompany} 
              onUpdateCompany={updateActiveCompany} 
              gemini={gemini} 
            />

            {/* Firma y Analista */}
            <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm relative">
              <div className="absolute top-0 left-0 w-2 h-full bg-slate-400"></div>
              <h3 className="text-xl font-bold text-trueblue mb-6">Firma del Reporte</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">Nombre del Analista</label>
                  <input 
                    type="text" 
                    value={activeCompany.analystName || ''} 
                    onChange={e => updateActiveCompany({ analystName: e.target.value })}
                    className="w-full bg-slate-50 border-none px-4 py-3 rounded-xl font-bold text-sm outline-none ring-1 ring-slate-100 focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">Fecha del Reporte</label>
                  <input 
                    type="date" 
                    value={activeCompany.reportDate || ''} 
                    onChange={e => updateActiveCompany({ reportDate: e.target.value })}
                    className="w-full bg-slate-50 border-none px-4 py-3 rounded-xl font-bold text-sm outline-none ring-1 ring-slate-100 focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
    );
  };

  const renderCompanies = () => (
    <div className="space-y-10">
      <header className="flex justify-between items-center">
        <div>
          <h1 className="text-4xl font-black text-slate-900 tracking-tight">Portafolio Financiero</h1>
          <p className="text-slate-500 font-medium">Gestionando {companies.length} perfiles de monitoreo</p>
        </div>
        <button onClick={() => setIsAddingCompany(true)} className="bg-bluebonnet text-white px-8 py-4 rounded-2xl font-black shadow-xl shadow-[#0018E633] hover:bg-trueblue active:scale-95 transition-all">+ Agregar Perfil</button>
      </header>
      <div className="space-y-12">
        {Object.entries(companies.reduce((acc, co) => {
          if (!acc[co.clientId]) acc[co.clientId] = [];
          acc[co.clientId].push(co);
          return acc;
        }, {} as Record<string, Company[]>)).map(([clientId, clientCompanies]) => (
          <div key={clientId} className="space-y-6">
            <div className="flex items-center gap-4 border-b border-slate-200 pb-4">
              <div className="w-10 h-10 bg-slate-900 rounded-xl flex items-center justify-center text-white font-black text-xs">
                {clientId.substring(0, 2)}
              </div>
              <div>
                <h2 className="text-2xl font-black text-slate-900">{(clientCompanies as Company[])[0].name}</h2>
                <p className="text-xs font-black text-slate-400 uppercase tracking-widest">ID CLIENTE: {clientId}</p>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {(clientCompanies as Company[]).map(co => (
                <div key={co.id} className="bg-white border border-slate-200 p-10 rounded-[2.5rem] hover:border-indigo-400 transition-all group cursor-pointer shadow-sm hover:shadow-xl" onClick={() => { setSelectedCompanyId(co.id); setRoute(AppRoute.DASHBOARD); }}>
                   <div className="flex justify-between items-start mb-8">
                    <div className="w-14 h-14 bg-slate-50 rounded-[1.25rem] flex items-center justify-center text-slate-400 group-hover:bg-blue-50 group-hover:text-bluebonnet transition-colors">
                      {co.logo ? <img src={co.logo} alt="Logo" className="w-full h-full object-contain p-2" /> : <ICONS.Companies />}
                    </div>
                    <div className="flex gap-2">
                      <button 
                        onClick={(e) => { e.stopPropagation(); duplicateCompany(co); }}
                        className="p-2 text-slate-300 hover:text-bluebonnet transition-colors"
                        title="Duplicar"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                        </svg>
                      </button>
                      <button 
                        onClick={(e) => { e.stopPropagation(); deleteCompany(co.id); }}
                        className="p-2 text-slate-300 hover:text-rose-500 transition-colors"
                        title="Eliminar"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <h3 className="text-2xl font-black text-slate-900 mb-1 leading-tight">{co.contractName}</h3>
                  <p className="text-slate-400 text-xs font-bold uppercase tracking-wider mb-8">{co.industry}</p>
                  <div className="grid grid-cols-2 gap-4 border-t border-slate-50 pt-6">
                    <div>
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Línea de Crédito</span>
                      <span className="text-lg font-black text-slate-800 font-mono">${(co.totalCreditValue / 1000).toFixed(0)}k</span>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Score AXCESS</span>
                      <span className="text-lg font-black font-mono text-bluebonnet">
                         {co.score}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderReport = () => (
    <ReportView company={activeCompany} onClose={() => setRoute(AppRoute.DASHBOARD)} />
  );

  const renderContent = () => {
    if (!activeCompany) return renderDashboard();
    switch (route) {
      case AppRoute.DASHBOARD: return renderDashboard();
      case AppRoute.MONITORING_MODEL: return (
        <MonitoringModelSection
          company={activeCompany}
          gemini={gemini}
          onUpdateCompany={updateActiveCompany}
        />
      );
      case AppRoute.COMPANIES: return renderCompanies();
      case AppRoute.REPORT: return renderReport();
      default: return renderDashboard();
    }
  };

  return (
    <div className="flex min-h-screen bg-slate-50 print:bg-white overflow-hidden">
      <div className="print:hidden">
        <Sidebar 
          currentRoute={route} 
          onNavigate={setRoute} 
          onAddProfile={() => setIsAddingCompany(true)} 
          companies={companies}
          selectedCompanyId={selectedCompanyId}
          onSelectCompany={setSelectedCompanyId}
          aiSettings={aiSettings}
          onSaveAiSettings={setAiSettings}
        />
      </div>
      <main className={`flex-1 overflow-y-auto ${route === AppRoute.REPORT ? 'bg-slate-200 print:bg-white' : 'p-8 md:p-12'}`}>
        <div className={route === AppRoute.REPORT ? '' : 'max-w-7xl mx-auto'}>
          {renderContent()}
        </div>
      </main>

      {/* Diálogo de Creación de Perfil */}
      {isAddingCompany && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-[100] flex items-center justify-center p-6">
          <div className="bg-white rounded-[2.5rem] w-full max-w-md p-10 shadow-2xl animate-in zoom-in-95 duration-200">
            <h2 className="text-3xl font-black text-slate-900 mb-2">Nueva Entidad</h2>
            <p className="text-slate-500 mb-8 font-medium">Agrega un nuevo perfil de empresa a tu portafolio.</p>
            <div className="space-y-6">
              {uniqueClients.length > 0 && (
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Seleccionar Cliente Existente</label>
                  <select 
                    value={selectedExistingClientId}
                    onChange={e => {
                      const val = e.target.value;
                      setSelectedExistingClientId(val);
                      if (val === 'new') {
                        setNewClientId('');
                        setNewCompanyName('');
                      } else {
                        const client = uniqueClients.find(c => c.id === val);
                        if (client) {
                          setNewClientId(client.id);
                          setNewCompanyName(client.name);
                        }
                      }
                    }}
                    className="w-full px-5 py-4 bg-slate-50 border-none rounded-2xl outline-none ring-2 ring-slate-100 focus:ring-4 focus:ring-indigo-500/10 font-bold transition-all"
                  >
                    <option value="new">Nuevo Cliente</option>
                    {uniqueClients.map(c => (
                      <option key={c.id} value={c.id}>{c.name} ({c.id})</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">ID del Cliente (Opcional)</label>
                <input 
                  type="text" 
                  placeholder="Se generará uno si se deja vacío..." 
                  value={newClientId}
                  onChange={e => setNewClientId(e.target.value)}
                  disabled={selectedExistingClientId !== 'new'}
                  className={`w-full px-5 py-4 bg-slate-50 border-none rounded-2xl outline-none ring-2 ring-slate-100 focus:ring-4 focus:ring-indigo-500/10 font-bold transition-all ${selectedExistingClientId !== 'new' ? 'opacity-50 cursor-not-allowed' : ''}`}
                />
              </div>
              <div>
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Nombre Legal de la Empresa</label>
                <input 
                  autoFocus={selectedExistingClientId === 'new'}
                  type="text" 
                  placeholder="Ingresa el nombre..." 
                  value={newCompanyName}
                  onChange={e => setNewCompanyName(e.target.value)}
                  disabled={selectedExistingClientId !== 'new'}
                  className={`w-full px-5 py-4 bg-slate-50 border-none rounded-2xl outline-none ring-2 ring-slate-100 focus:ring-4 focus:ring-indigo-500/10 font-bold transition-all ${selectedExistingClientId !== 'new' ? 'opacity-50 cursor-not-allowed' : ''}`}
                />
              </div>
              <div>
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Nombre del Contrato</label>
                <input 
                  autoFocus={selectedExistingClientId !== 'new'}
                  type="text" 
                  placeholder="ej. Contrato APEM 2025" 
                  value={newContractName}
                  onChange={e => setNewContractName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddCompany()}
                  className="w-full px-5 py-4 bg-slate-50 border-none rounded-2xl outline-none ring-2 ring-slate-100 focus:ring-4 focus:ring-indigo-500/10 font-bold transition-all"
                />
              </div>
            </div>
            <div className="flex gap-4 mt-10">
              <button onClick={() => {
                setIsAddingCompany(false);
                setSelectedExistingClientId('new');
                setNewClientId('');
                setNewCompanyName('');
                setNewContractName('');
              }} className="flex-1 py-4 text-slate-500 font-bold hover:bg-slate-50 rounded-2xl transition-all">Cancelar</button>
              <button onClick={handleAddCompany} className="flex-1 bg-bluebonnet text-white py-4 rounded-2xl font-bold hover:bg-trueblue shadow-xl shadow-[#0018E633] active:scale-95 transition-all">Crear Entidad</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Revisión de Auditoría IA */}
      {isProcessingNew && tempExtraction && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-6">
          <div className="bg-white rounded-[2.5rem] w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
            <div className="p-8 border-b flex justify-between items-center bg-slate-50/50">
              <div>
                <h2 className="text-2xl font-black text-slate-900">Auditoría y Verificación IA</h2>
                <p className="text-sm text-slate-500 font-bold font-mono mt-1 uppercase">Periodo Identificado: {tempExtraction.period}</p>
              </div>
              <div className="flex gap-4">
                <button onClick={() => setIsProcessingNew(false)} className="px-6 py-3 text-slate-500 font-bold hover:bg-slate-100 rounded-2xl">Descartar</button>
                <button onClick={finalizeExtraction} className="bg-bluebonnet text-white px-10 py-3 rounded-2xl font-bold hover:bg-trueblue shadow-xl shadow-[#0018E633]">Confirmar Auditoría</button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-10">
              <FinancialTable 
                data={tempExtraction.data} 
                onUpdate={(field, val) => setTempExtraction({ ...tempExtraction, data: { ...tempExtraction.data, [field]: val }})} 
              />
              
              {tempExtraction.covenantValues && tempExtraction.covenantValues.length > 0 && (
                <div className="mt-8 border-t pt-8">
                  <h3 className="text-sm font-black text-slate-400 uppercase tracking-widest mb-6 flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                    </svg>
                    Covenants Mapeados por IA
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {tempExtraction.covenantValues.map((cv, i) => (
                       <div key={i} className="bg-slate-50 p-6 rounded-3xl border border-slate-100 flex flex-col justify-between group hover:border-indigo-200 transition-all">
                         <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">{cv.name}</p>
                         <input 
                            type="text" 
                            value={cv.value} 
                            onChange={(e) => {
                               const newCvs = [...(tempExtraction.covenantValues || [])];
                               newCvs[i].value = e.target.value;
                               setTempExtraction({...tempExtraction, covenantValues: newCvs});
                            }}
                            className="bg-transparent border-none font-bold text-xl text-indigo-600 outline-none w-full"
                         />
                       </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
