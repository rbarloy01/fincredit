# FinMonitor Priority Hardening

This Vite app is the production Vercel source for `finmonitor-base`.

- Vercel project: `finmonitor-base`
- Production URL: `https://finmonitor-base.vercel.app`
- Framework: Vite
- Build command: `npm run build`
- Output directory: `dist`
- Linked project file: `.vercel/project.json`

The Python financial-monitor pipeline currently lives in the sibling workspace
`/Users/syscap/Documents/New project 2`. Treat that workspace as a data-engine
prototype until its extraction jobs are promoted behind authenticated app APIs,
background workers, or an explicit import/sync contract.

## Priority Order

1. Protect privileged server APIs and server-side AI keys.
2. Keep the deployed Vercel source and local workspaces clearly identified.
3. Keep Supabase RLS and manager-only routes in place before onboarding users.
4. Move long-running document and PDF processing into bounded background jobs.
5. Require review/approval before extracted financial values affect covenants.

## Security Notes

- `SUPABASE_SERVICE_KEY` must remain server-side only.
- AI proxy routes must require an authenticated `manager` or `analyst` user.
- Browser-local AI keys are allowed only as transient inputs; do not persist
  provider keys in long-lived `localStorage`.
- Pending users must not access app data or AI proxy routes.
- Document ingestion and review approval are manager-only workflows.

## RLS Verification

- `npm run verify:supabase` verifies required production tables and anonymous
  RLS smoke behavior.
- `npm run verify:rls` creates temporary manager, analyst, and pending users,
  probes production Supabase with real JWTs, and cleans up the temporary data.
- If `verify:rls` reports pending-user access, apply
  `database/20260830_strict_authenticated_rls_repair.sql` in Supabase SQL
  Editor or through a privileged Postgres connection, then rerun the verifier.
