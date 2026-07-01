import { readJson, sendJson } from '../_helpers.js';
import {
  classifyDocument,
  inferPeriod,
  matchClientId,
  requireIngestionManager,
  supabaseFetch,
  supabaseJson,
  getDriveClient,
} from '../ingestion/_shared.js';

export const maxDuration = 60;

type QueueItem = {
  folderId: string;
  path: string;
};

async function listFolder(folderId: string) {
  const drive = await getDriveClient();
  const files: any[] = [];
  let pageToken: string | undefined;
  do {
    const result = await drive.files.list({
      q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id,name,mimeType,size,md5Checksum,parents,webViewLink,modifiedTime,createdTime)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    files.push(...(result.data.files || []));
    pageToken = result.data.nextPageToken || undefined;
  } while (pageToken);
  return files;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

  try {
    const { orgId, supabase } = await requireIngestionManager(req);
    const body = await readJson(req);
    const rootFolderId = body.rootFolderId || process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    const dryRun = Boolean(body.dryRun);
    const maxFiles = Math.min(Number(body.maxFiles || 500), 5000);
    if (!rootFolderId) return sendJson(res, 400, { error: 'rootFolderId or GOOGLE_DRIVE_ROOT_FOLDER_ID required' });

    const clients = await supabaseJson<any[]>(
      supabase,
      `clients?select=id,name,tax_id,org_id&org_id=eq.${encodeURIComponent(orgId)}`,
      {},
      [],
    );

    const queue: QueueItem[] = [{ folderId: rootFolderId, path: '' }];
    const rows: any[] = [];
    const folders: Array<{ id: string; path: string }> = [];

    while (queue.length && rows.length < maxFiles) {
      const current = queue.shift() as QueueItem;
      const files = await listFolder(current.folderId);
      for (const file of files) {
        const nextPath = current.path ? `${current.path}/${file.name}` : file.name;
        if (file.mimeType === 'application/vnd.google-apps.folder') {
          folders.push({ id: file.id, path: nextPath });
          queue.push({ folderId: file.id, path: nextPath });
          continue;
        }
        const docType = classifyDocument(file.name, file.mimeType, current.path);
        const inferred = inferPeriod(`${current.path} ${file.name}`);
        rows.push({
          org_id: orgId,
          client_id: matchClientId(current.path, file.name, clients),
          drive_file_id: file.id,
          drive_parent_id: current.folderId,
          drive_path: current.path,
          source_uri: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
          file_name: file.name,
          mime_type: file.mimeType || '',
          size_bytes: file.size ? Number(file.size) : null,
          checksum: file.md5Checksum || null,
          document_type: docType,
          period: inferred.period,
          period_date: inferred.periodDate,
          source_status: 'active',
          extraction_status: 'pending',
          confidence_score: docType === 'unknown' ? 0 : 0.55,
          raw_metadata: {
            drive: {
              parents: file.parents || [],
              modifiedTime: file.modifiedTime,
              createdTime: file.createdTime,
            },
          },
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        if (rows.length >= maxFiles) break;
      }
    }

    if (!dryRun && rows.length) {
      await supabaseFetch(supabase, 'documents?on_conflict=org_id,drive_file_id', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(rows),
      });
    }

    sendJson(res, 200, {
      dryRun,
      rootFolderId,
      foldersSeen: folders.length,
      filesSeen: rows.length,
      insertedOrUpdated: dryRun ? 0 : rows.length,
      samples: rows.slice(0, 12).map(row => ({
        fileName: row.file_name,
        path: row.drive_path,
        documentType: row.document_type,
        clientId: row.client_id,
        period: row.period,
      })),
    });
  } catch (error: any) {
    sendJson(res, error?.status || 500, { error: error?.message || 'Drive sync error' });
  }
}
