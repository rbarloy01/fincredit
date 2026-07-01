import * as XLSX from 'xlsx';
import { createHash } from 'crypto';
import { readJson, sendJson } from '../_helpers.js';
import { processWithDocumentAi } from '../ingestion/_documentAi.js';
import { extractFinancialCandidates } from '../ingestion/_finance.js';
import {
  createExtractionRun,
  downloadDriveFile,
  finishExtractionRun,
  isDocAiCandidate,
  isExcelLike,
  requireIngestionManager,
  supabaseFetch,
  supabaseJson,
} from '../ingestion/_shared.js';

export const maxDuration = 60;

async function loadDocuments(admin: any, orgId: string, documentId?: string, limit = 1) {
  if (documentId) {
    return supabaseJson<any[]>(
      admin,
      `documents?select=*&org_id=eq.${encodeURIComponent(orgId)}&id=eq.${encodeURIComponent(documentId)}&limit=1`,
      {},
      [],
    );
  }
  return supabaseJson<any[]>(
    admin,
    `documents?select=*&org_id=eq.${encodeURIComponent(orgId)}&extraction_status=in.(pending,error)&order=created_at.asc&limit=${Math.max(1, Math.min(limit, 10))}`,
    {},
    [],
  );
}

async function patchDocument(admin: any, documentId: string, patch: Record<string, any>) {
  await supabaseFetch(admin, `documents?id=eq.${encodeURIComponent(documentId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

async function resetDerivedRows(admin: any, documentId: string) {
  await Promise.all([
    supabaseFetch(admin, `document_tables?document_id=eq.${encodeURIComponent(documentId)}`, { method: 'DELETE' }),
    supabaseFetch(admin, `extraction_review_items?document_id=eq.${encodeURIComponent(documentId)}&status=in.(pending,ready)`, { method: 'DELETE' }),
  ]);
}

function stableHash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function sourceKey(prefix: string, parts: Record<string, unknown>) {
  return `${prefix}:${stableHash(parts).slice(0, 32)}`;
}

async function upsertPages(admin: any, documentId: string, runId: string, pages: Array<{ pageNumber: number; text: string; layout?: any; ocrUsed?: boolean }>) {
  if (!pages.length) return;
  const rows = pages.map(page => ({
    document_id: documentId,
    extraction_run_id: runId,
    page_number: page.pageNumber,
    raw_text: page.text || '',
    ocr_used: Boolean(page.ocrUsed),
    layout: page.layout || {},
  }));
  await supabaseFetch(admin, 'document_pages?on_conflict=document_id,page_number', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
}

async function insertTables(admin: any, documentId: string, runId: string, tables: Array<{ pageNumber?: number; sheetName?: string; tableIndex: number; rows: any[][]; raw?: any }>) {
  if (!tables.length) return [];
  const rows = tables.map(table => {
    const candidates = extractFinancialCandidates(table.rows);
    return {
      document_id: documentId,
      extraction_run_id: runId,
      page_number: table.pageNumber || null,
      sheet_name: table.sheetName || null,
      table_index: table.tableIndex,
      raw_table: table.raw || { rows: table.rows },
      detected_periods: Array.from(new Set(candidates.map(c => c.period).filter(Boolean))).slice(0, 12),
    };
  });
  return supabaseJson<any[]>(admin, 'document_tables', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(rows),
  }, []);
}

async function insertReviewItems(admin: any, doc: any, tableRows: any[], tableRecords: any[]) {
  const reviewRows: any[] = [];
  tableRows.forEach((table, index) => {
    const candidates = extractFinancialCandidates(table.rows).slice(0, 250);
    const tableRecord = tableRecords[index];
    candidates.forEach(candidate => {
      const key = sourceKey('financial_line_item', {
        documentId: doc.id,
        tableIndex: table.tableIndex,
        pageNumber: table.pageNumber || null,
        sheetName: table.sheetName || null,
        rowNumber: candidate.rowNumber,
        columnNumber: candidate.columnNumber,
        accountName: candidate.accountName,
        metric: candidate.metric,
        period: candidate.period || doc.period || '',
        value: candidate.value,
      });
      reviewRows.push({
        org_id: doc.org_id,
        client_id: doc.client_id,
        document_id: doc.id,
        item_type: 'financial_line_item',
        source_key: key,
        raw_value: {
          sourceKey: key,
          accountName: candidate.accountName,
          value: candidate.value,
          rowNumber: candidate.rowNumber,
          columnNumber: candidate.columnNumber,
          pageNumber: table.pageNumber || null,
          sheetName: table.sheetName || null,
          documentTableId: tableRecord?.id || null,
          certaintySignals: candidate.certainty.signals,
          certaintyWarnings: candidate.certainty.warnings,
        },
        suggested_value: {
          metric: candidate.metric,
          period: candidate.period || doc.period || '',
          periodDate: doc.period_date || null,
          value: candidate.value,
          accountName: candidate.accountName,
          certaintyLevel: candidate.certainty.level,
          certaintySignals: candidate.certainty.signals,
          certaintyWarnings: candidate.certainty.warnings,
        },
        confidence_score: candidate.confidence,
        status: candidate.certainty.level === 'high' && doc.client_id ? 'ready' : 'pending',
      });
    });
  });

  if (reviewRows.length) {
    await supabaseFetch(admin, 'extraction_review_items?on_conflict=org_id,document_id,item_type,source_key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(reviewRows.slice(0, 1000)),
    });
  }
  return reviewRows.length;
}

function workbookTables(buffer: Buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  return workbook.SheetNames.map((sheetName, index) => {
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1, raw: false, defval: '' });
    return {
      sheetName,
      tableIndex: index,
      rows: rows
        .filter(row => row.some(cell => String(cell ?? '').trim()))
        .slice(0, 2500),
      raw: {
        sheetName,
        rows: rows.slice(0, 2500),
      },
    };
  }).filter(table => table.rows.length);
}

function qualitativeReviewItems(doc: any, text: string) {
  const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const keywords = /(administraci[oó]n|accionista|mercado|competencia|riesgo|fondeo|garant[ií]a|gobierno|regulatorio|cobranza|originaci[oó]n|concentraci[oó]n)/i;
  return lines
    .filter(line => keywords.test(line))
    .slice(0, 30)
    .map(line => {
      const key = sourceKey('qualitative_excerpt', {
        documentId: doc.id,
        excerpt: line.toLowerCase().replace(/\s+/g, ' ').trim(),
      });
      return {
        org_id: doc.org_id,
        client_id: doc.client_id,
        document_id: doc.id,
        item_type: 'qualitative_excerpt',
        source_key: key,
        raw_value: { sourceKey: key, excerpt: line },
        suggested_value: {
          category: 'Por clasificar',
          factor: line.slice(0, 120),
          assessment: line,
          riskLevel: 'unknown',
        },
        confidence_score: 0.45,
        status: 'pending',
      };
    });
}

async function insertQualitativeItems(admin: any, doc: any, text: string) {
  const rows = qualitativeReviewItems(doc, text);
  if (!rows.length) return 0;
  await supabaseFetch(admin, 'extraction_review_items?on_conflict=org_id,document_id,item_type,source_key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  return rows.length;
}

async function processOne(admin: any, doc: any) {
  if (!doc.drive_file_id) throw new Error(`Document ${doc.id} has no drive_file_id`);

  await patchDocument(admin, doc.id, { extraction_status: 'processing' });
  await resetDerivedRows(admin, doc.id);

  const file = await downloadDriveFile({
    id: doc.drive_file_id,
    name: doc.file_name,
    mimeType: doc.mime_type,
  });
  const contentHash = createHash('sha256').update(file.buffer).digest('hex');
  const run = await createExtractionRun(admin, doc.id, isExcelLike(file.fileName, file.mimeType) ? 'local-xlsx' : 'document-ai');

  try {
    if (isExcelLike(file.fileName, file.mimeType)) {
      const tables = workbookTables(file.buffer);
      const tableRecords = await insertTables(admin, doc.id, run.id, tables);
      const reviewItems = await insertReviewItems(admin, doc, tables, tableRecords);
      await finishExtractionRun(admin, run.id, 'done', { tables_found: tables.length, pages_processed: 0 });
      await patchDocument(admin, doc.id, {
        extraction_status: 'done',
        raw_metadata: {
          ...(doc.raw_metadata || {}),
          extraction: { parser: 'xlsx', fileName: file.fileName, contentHash, tables: tables.length, reviewItems },
        },
        ...(!doc.checksum ? { checksum: contentHash } : {}),
      });
      return { documentId: doc.id, status: 'done', parser: 'xlsx', tables: tables.length, reviewItems };
    }

    if (file.mimeType === 'text/plain') {
      const text = file.buffer.toString('utf8');
      await upsertPages(admin, doc.id, run.id, [{ pageNumber: 1, text, layout: { source: 'drive-export' } }]);
      const reviewItems = await insertQualitativeItems(admin, doc, text);
      await finishExtractionRun(admin, run.id, 'done', { pages_processed: 1, tables_found: 0 });
      await patchDocument(admin, doc.id, {
        extraction_status: 'done',
        raw_metadata: {
          ...(doc.raw_metadata || {}),
          extraction: { parser: 'text', fileName: file.fileName, contentHash, reviewItems },
        },
        ...(!doc.checksum ? { checksum: contentHash } : {}),
      });
      return { documentId: doc.id, status: 'done', parser: 'text', pages: 1, reviewItems };
    }

    if (!isDocAiCandidate(file.mimeType)) {
      throw new Error(`Unsupported extraction mime type: ${file.mimeType || 'unknown'}`);
    }

    const parsed = await processWithDocumentAi(file.buffer, file.mimeType);
    await upsertPages(admin, doc.id, run.id, parsed.pages.map(page => ({ ...page, ocrUsed: true })));
    const tableRows = parsed.tables.map(table => ({
      pageNumber: table.pageNumber,
      tableIndex: table.tableIndex,
      rows: table.rows,
      raw: table.raw,
    }));
    const tableRecords = await insertTables(admin, doc.id, run.id, tableRows);
    const financialItems = await insertReviewItems(admin, doc, tableRows, tableRecords);
    const qualitativeItems = await insertQualitativeItems(admin, doc, parsed.pages.map(page => page.text).join('\n'));
    await finishExtractionRun(admin, run.id, 'done', {
      pages_processed: parsed.pages.length,
      tables_found: parsed.tables.length,
      metadata: parsed.metadata,
    });
    await patchDocument(admin, doc.id, {
      extraction_status: 'done',
      raw_metadata: {
        ...(doc.raw_metadata || {}),
        extraction: {
          parser: 'document-ai',
          processor: parsed.processor,
          fileName: file.fileName,
          contentHash,
          pages: parsed.pages.length,
          tables: parsed.tables.length,
          financialItems,
          qualitativeItems,
        },
      },
      ...(!doc.checksum ? { checksum: contentHash } : {}),
    });
    return {
      documentId: doc.id,
      status: 'done',
      parser: 'document-ai',
      pages: parsed.pages.length,
      tables: parsed.tables.length,
      financialItems,
      qualitativeItems,
    };
  } catch (error: any) {
    await finishExtractionRun(admin, run.id, 'error', { error: error?.message || String(error) });
    await patchDocument(admin, doc.id, { extraction_status: 'error' });
    throw error;
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

  try {
    const { orgId, supabase } = await requireIngestionManager(req);
    const body = await readJson(req);
    const docs = await loadDocuments(supabase, orgId, body.documentId, Number(body.limit || 1));
    if (!docs.length) return sendJson(res, 200, { processed: 0, results: [] });

    const results = [];
    for (const doc of docs) {
      results.push(await processOne(supabase, doc));
    }
    sendJson(res, 200, { processed: results.length, results });
  } catch (error: any) {
    sendJson(res, error?.status || 500, { error: error?.message || 'Document processing error' });
  }
}
