declare global {
  interface Window {
    pdfjsLib?: any;
  }
}

const MAX_CONTRACT_CHARS = 26000;
const MAX_PARSED_PAGES = 42;
const PDF_PARSE_TIMEOUT_MS = 12000;

function compactText(value: string) {
  return value
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function prioritizeContractText(pages: string[], maxChars = MAX_CONTRACT_CHARS) {
  const full = pages.join('\n\n');
  if (full.length <= maxChars) return full;

  const keywords = /(acreditad|acreditante|monto|importe|línea|linea|moneda|vigencia|vencimiento|obligaciones|covenant|raz[oó]n financiera|aforo|garant[ií]a|incumplimiento|inter[eé]s)/i;
  const selected = new Set<number>();
  pages.forEach((page, index) => {
    if (index < 4 || index >= pages.length - 3 || keywords.test(page)) selected.add(index);
  });

  let result = '';
  for (const index of Array.from(selected).sort((a, b) => a - b)) {
    const next = `${result ? '\n\n' : ''}${pages[index]}`;
    if ((result + next).length > maxChars) break;
    result += next;
  }
  return result || full.slice(0, maxChars);
}

function selectedPageNumbers(totalPages: number) {
  if (totalPages <= MAX_PARSED_PAGES) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const pages = new Set<number>();
  for (let page = 1; page <= Math.min(18, totalPages); page += 1) pages.add(page);
  for (let page = Math.max(1, totalPages - 13); page <= totalPages; page += 1) pages.add(page);
  const remaining = MAX_PARSED_PAGES - pages.size;
  for (let index = 1; index <= remaining; index += 1) {
    pages.add(Math.max(1, Math.min(totalPages, Math.round(index * totalPages / (remaining + 1)))));
  }
  return Array.from(pages).sort((a, b) => a - b);
}

async function parsePdfText(file: File): Promise<string> {
  const pdfjs = window.pdfjsLib;
  if (!pdfjs?.getDocument) return '';
  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages: string[] = [];
  const pageNumbers = selectedPageNumbers(pdf.numPages);

  for (const pageNumber of pageNumbers) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = compactText(content.items.map((item: any) => String(item.str || '')).join(' '));
    if (text) pages.push(`[Página ${pageNumber}]\n${text}`);
    page.cleanup?.();
  }

  return prioritizeContractText(pages);
}

export async function extractPdfText(file: File): Promise<string> {
  try {
    return await Promise.race([
      parsePdfText(file),
      new Promise<string>(resolve => window.setTimeout(() => resolve(''), PDF_PARSE_TIMEOUT_MS)),
    ]);
  } catch (error) {
    console.warn('No se pudo extraer texto local del PDF; se usará análisis visual.', error);
    return '';
  }
}

export function isUsefulExtractedText(text: string) {
  const words = text.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{3,}/g)?.length || 0;
  return text.length >= 600 && words >= 80;
}

export async function renderPdfPreviewImages(file: File): Promise<string[]> {
  const pdfjs = window.pdfjsLib;
  if (!pdfjs?.getDocument) return [];
  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;
  const candidates = [1, Math.ceil(pdf.numPages / 2), pdf.numPages];
  const pages = Array.from(new Set(candidates.filter(page => page >= 1 && page <= pdf.numPages)));
  const images: string[] = [];

  for (const pageNumber of pages) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) continue;
    await page.render({ canvasContext: context, viewport }).promise;
    images.push(canvas.toDataURL('image/jpeg', 0.6).split(',')[1]);
    page.cleanup?.();
  }
  return images;
}
