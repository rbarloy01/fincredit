
import React, { useState, useRef } from 'react';
import { GeminiService } from '../services/geminiService';
import { ExtractionResult, ContractExtractionResult } from '../types';
import { ICONS } from '../constants';
import * as XLSX from 'xlsx';

interface FileUploadProps {
  onFinancialsExtracted: (result: ExtractionResult) => void;
  onContractExtracted: (result: ContractExtractionResult) => void;
  gemini: GeminiService;
  companyCovenants?: string[];
}

const FileUpload: React.FC<FileUploadProps> = ({ onFinancialsExtracted, onContractExtracted, gemini, companyCovenants }) => {
  const [isUploadingFin, setIsUploadingFin] = useState(false);
  const [isUploadingContract, setIsUploadingContract] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const finInputRef = useRef<HTMLInputElement>(null);
  const contractInputRef = useRef<HTMLInputElement>(null);
  const processFile = async (file: File, type: 'financials' | 'contract') => {
    const setIsUploading = type === 'financials' ? setIsUploadingFin : setIsUploadingContract;
    setIsUploading(true);
    setError(null);

    try {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        const base64 = await new Promise<string>((resolve) => {
          reader.onload = () => resolve((reader.result as string).split(',')[1]);
          reader.readAsDataURL(file);
        });
        
        if (type === 'financials') {
          const result = await gemini.extractFromImage(base64, file.type, companyCovenants);
          onFinancialsExtracted(result);
        } else {
          const result = await gemini.extractContractData(base64, file.type);
          onContractExtracted(result);
        }
      } else if (file.type === 'application/pdf') {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await (window as any).pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        
        // Try text extraction first
        let fullText = '';
        for (let i = 1; i <= Math.min(pdf.numPages, 25); i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          const pageText = textContent.items.map((item: any) => item.str).join(' ');
          fullText += pageText + '\n';
        }

        if (fullText.trim().length > 100) {
          if (type === 'financials') {
            const result = await gemini.extractFromText(fullText, companyCovenants);
            onFinancialsExtracted(result);
          } else {
            const result = await gemini.extractContractFromText(fullText);
            onContractExtracted(result);
          }
        } else {
          // Fallback to image extraction for scanned PDF
          let aggregatedResult: ContractExtractionResult = { condicionesHacer: [], condicionesNoHacer: [], covenants: [] };
          let aggregatedFinValues: ExtractionResult | null = null;

          const pagesToScan = type === 'contract' ? Math.min(pdf.numPages, 5) : 1;
          
          for (let i = 1; i <= pagesToScan; i++) {
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 2 });
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.height = viewport.height;
            canvas.width = viewport.width;
            await page.render({ canvasContext: context, viewport: viewport }).promise;
            const base64 = canvas.toDataURL('image/jpeg').split(',')[1];
            
            if (type === 'financials') {
              const result = await gemini.extractFromImage(base64, 'image/jpeg', companyCovenants);
              onFinancialsExtracted(result);
              break; // Financials usually on one page
            } else {
              const result = await gemini.extractContractData(base64, 'image/jpeg');
              aggregatedResult.condicionesHacer.push(...(result.condicionesHacer || []));
              aggregatedResult.condicionesNoHacer.push(...(result.condicionesNoHacer || []));
              aggregatedResult.covenants.push(...(result.covenants || []));
            }
          }
          
          if (type === 'contract') {
            onContractExtracted(aggregatedResult);
          }
        }
      } else if (type === 'financials' && (file.name.endsWith('.xlsx') || file.name.endsWith('.xls') || file.name.endsWith('.csv'))) {
        const arrayBuffer = await file.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(firstSheet);
        const result = await gemini.extractFromText(JSON.stringify(json), companyCovenants);
        onFinancialsExtracted(result);
      } else {
        throw new Error("Formato de archivo no soportado.");
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Error al extraer datos.");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* Financials Upload */}
      <div className="bg-white border-2 border-dashed border-slate-200 rounded-3xl p-8 transition-all hover:border-bluebonnet group">
        <div className="flex flex-col items-center justify-center text-center space-y-4">
          <div className={`w-14 h-14 rounded-2xl flex items-center justify-center transition-colors ${isUploadingFin ? 'bg-blue-100 text-bluebonnet animate-pulse' : 'bg-slate-50 text-slate-400 group-hover:bg-blue-50 group-hover:text-bluebonnet'}`}>
            <ICONS.Upload />
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-800">Modelos Financieros</h3>
            <p className="text-slate-400 text-xs mt-1 leading-relaxed">
              Excel (.xlsx), PDF o Imágenes.<br/>Extrae ingresos, EBITDA, deuda, etc.
            </p>
          </div>
          <input
            type="file"
            className="hidden"
            ref={finInputRef}
            onChange={(e) => e.target.files?.[0] && processFile(e.target.files[0], 'financials')}
            accept="image/*, application/pdf, .xlsx, .xls, .csv"
          />
          <button
            disabled={isUploadingFin || isUploadingContract}
            onClick={() => finInputRef.current?.click()}
            className={`w-full py-2.5 rounded-xl font-bold text-sm transition-all shadow-sm ${
              isUploadingFin 
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed' 
                : 'bg-bluebonnet text-white hover:bg-trueblue active:scale-95'
            }`}
          >
            {isUploadingFin ? 'Analizando...' : 'Subir Estados Financieros'}
          </button>
        </div>
      </div>

      {/* Contract Upload */}
      <div className="bg-white border-2 border-dashed border-slate-200 rounded-3xl p-8 transition-all hover:border-indigo-400 group">
        <div className="flex flex-col items-center justify-center text-center space-y-4">
          <div className={`w-14 h-14 rounded-2xl flex items-center justify-center transition-colors ${isUploadingContract ? 'bg-indigo-100 text-indigo-600 animate-pulse' : 'bg-slate-50 text-slate-400 group-hover:bg-indigo-50 group-hover:text-indigo-600'}`}>
            <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-800">Contratos / Carátulas</h3>
            <p className="text-slate-400 text-xs mt-1 leading-relaxed">
              PDF o Imágenes del contrato.<br/>Extrae obligaciones de hacer y no hacer.
            </p>
          </div>
          <input
            type="file"
            className="hidden"
            ref={contractInputRef}
            onChange={(e) => e.target.files?.[0] && processFile(e.target.files[0], 'contract')}
            accept="image/*, application/pdf"
          />
          <button
            disabled={isUploadingFin || isUploadingContract}
            onClick={() => contractInputRef.current?.click()}
            className={`w-full py-2.5 rounded-xl font-bold text-sm transition-all shadow-sm ${
              isUploadingContract 
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed' 
                : 'bg-indigo-500 text-white hover:bg-indigo-600 active:scale-95'
            }`}
          >
            {isUploadingContract ? 'Analizando...' : 'Subir Contrato'}
          </button>
        </div>
      </div>

      {error && (
        <div className="md:col-span-2 bg-rose-50 border border-rose-100 p-4 rounded-2xl">
          <p className="text-rose-600 text-xs font-bold uppercase text-center">{error}</p>
        </div>
      )}
    </div>
  );
};

export default FileUpload;
