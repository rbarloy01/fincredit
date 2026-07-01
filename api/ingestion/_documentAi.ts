import { env, getGoogleAuth } from './_shared.js';

export type ParsedDocumentAi = {
  processor: string;
  pages: Array<{ pageNumber: number; text: string; layout: Record<string, any> }>;
  tables: Array<{ pageNumber: number; tableIndex: number; rows: string[][]; raw: any }>;
  entities: any[];
  metadata: Record<string, any>;
};

function processorEndpoint(processorName: string) {
  const location = processorName.match(/\/locations\/([^/]+)\//)?.[1] || 'us';
  return `https://${location}-documentai.googleapis.com/v1/${processorName}:process`;
}

function textFromAnchor(fullText: string, anchor?: any) {
  const segments = anchor?.textSegments || [];
  return segments
    .map((segment: any) => {
      const start = Number(segment.startIndex || 0);
      const end = Number(segment.endIndex || 0);
      return fullText.slice(start, end);
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function tableRows(fullText: string, rows?: any[]) {
  return (rows || []).map(row => (row.cells || []).map((cell: any) => textFromAnchor(fullText, cell.layout?.textAnchor)));
}

export async function processWithDocumentAi(buffer: Buffer, mimeType: string): Promise<ParsedDocumentAi> {
  const processorName = env('GOOGLE_DOCUMENT_AI_PROCESSOR_NAME');
  if (!processorName) throw new Error('GOOGLE_DOCUMENT_AI_PROCESSOR_NAME missing');

  const auth = await getGoogleAuth(['https://www.googleapis.com/auth/cloud-platform']);
  const client = await auth.getClient();
  const headers = await client.getRequestHeaders();
  const response = await fetch(processorEndpoint(processorName), {
    method: 'POST',
    headers: {
      ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)])),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      rawDocument: {
        content: buffer.toString('base64'),
        mimeType,
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Document AI error ${response.status}`);
  }

  const doc = payload.document || {};
  const fullText = doc.text || '';
  const pages = (doc.pages || []).map((page: any, index: number) => ({
    pageNumber: page.pageNumber || index + 1,
    text: textFromAnchor(fullText, page.layout?.textAnchor),
    layout: {
      dimension: page.dimension,
      detectedLanguages: page.detectedLanguages,
      blocks: page.blocks?.length || 0,
      paragraphs: page.paragraphs?.length || 0,
      lines: page.lines?.length || 0,
      tokens: page.tokens?.length || 0,
    },
  }));

  const tables = (doc.pages || []).flatMap((page: any, pageIndex: number) => {
    const pageNumber = page.pageNumber || pageIndex + 1;
    return (page.tables || []).map((table: any, tableIndex: number) => {
      const headerRows = tableRows(fullText, table.headerRows);
      const bodyRows = tableRows(fullText, table.bodyRows);
      return {
        pageNumber,
        tableIndex,
        rows: [...headerRows, ...bodyRows],
        raw: {
          headerRows,
          bodyRows,
          layoutText: textFromAnchor(fullText, table.layout?.textAnchor),
        },
      };
    });
  });

  return {
    processor: processorName,
    pages,
    tables,
    entities: doc.entities || [],
    metadata: {
      mimeType,
      textLength: fullText.length,
      pageCount: pages.length,
      tableCount: tables.length,
      revision: payload.humanReviewStatus || null,
    },
  };
}
