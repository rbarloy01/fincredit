# FinMonitor

FinMonitor is a credit monitoring app for IFNB workflows. It manages clients, transactions, financial statements, loan tapes, covenants, monitoring summaries, exports, and AI-assisted extraction.

The active React entrypoint is `index.tsx`, which mounts `src/App.tsx`. The root-level `App.tsx` is legacy code kept in the repo for now and is not used by the current Vite build.

## Local Setup

```bash
npm install
npm run dev
```

The Vite dev server is configured in `vite.config.ts`.

## Required Environment

Create a local `.env` with:

```bash
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
```

Optional server-side AI keys:

```bash
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
```

Managers can still enter a browser-local AI key in the app settings, but production deployments should prefer server-side keys.

## Database

Run `database/schema.sql` for a fresh Supabase project.

For existing projects, apply migrations in order:

```text
database/20260604_client_settings.sql
database/20260610_org_settings.sql
database/20260610_organization_bootstrap.sql
database/20260610_production_access_hardening.sql
database/20260611_org_scoped_rls.sql
database/20260626_document_ai_ingestion.sql
database/20260630_private_financial_document_storage.sql
```

`20260611_org_scoped_rls.sql` replaces broad approved-user RLS with organization-scoped policies. Approved users can only access data belonging to their own organization.

## Document AI Ingestion

The ingestion pilot is API-first and keeps extracted values in a review queue before they become final financial or qualitative records.

Required Google env:

```bash
GOOGLE_SERVICE_ACCOUNT_JSON=
GOOGLE_DRIVE_ROOT_FOLDER_ID=
GOOGLE_DOCUMENT_AI_PROCESSOR_NAME=
```

`GOOGLE_SERVICE_ACCOUNT_JSON` can be raw JSON or base64-encoded JSON. The service account needs read access to the Drive folders and permission to call Document AI. `GOOGLE_DOCUMENT_AI_PROCESSOR_NAME` should look like `projects/.../locations/.../processors/...`.

Manager-only endpoints:

```text
POST /api/drive/sync
POST /api/documents/process
POST /api/review-items/approve
```

Suggested pilot flow:

```bash
# 1. Inventory Drive files into documents
curl -X POST "$APP_URL/api/drive/sync" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"rootFolderId":"...","maxFiles":200}'

# 2. Process one pending document, or pass documentId
curl -X POST "$APP_URL/api/documents/process" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit":1}'

# 3. Approve reviewed candidates into final tables
curl -X POST "$APP_URL/api/review-items/approve" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reviewItemId":"..."}'
```

Excel/CSV files are parsed locally without AI. PDFs/images go through Google Document AI. Extracted financial line items and qualitative excerpts land in `extraction_review_items`; approval promotes them into `financial_statements`, `financial_line_item_sources`, or `qualitative_factors`.

## Checks

```bash
npm run lint
npm run build
```

Current build note: Vite warns that the main bundle is large. The likely next optimization is code-splitting heavy export/report dependencies such as PDF, Excel, and spreadsheet tooling.

## Roles

Supported roles:

- `pending`: authenticated but waiting for manager approval
- `analyst`: can work with approved organization data
- `manager`: can manage users and settings for their organization

## Production Notes

- Keep `SUPABASE_SERVICE_KEY` server-side only.
- Prefer server-side AI keys over browser-local keys.
- Store original loan tapes, financial statements, and contracts in the private `financial-documents` Supabase Storage bucket. Parsed/normalized values stay in Postgres and link back through `source_document_id`.
- Apply organization-scoped RLS before onboarding multiple organizations.
- Add regression tests before large changes to extraction, covenant evaluation, or report export.
