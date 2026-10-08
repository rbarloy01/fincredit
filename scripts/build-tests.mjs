// Bundles tests/*.test.ts for node --test. Mirrors Vite's `?raw` imports (prompts/*.md) so modules that load prompts can be tested.
import { build } from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const rawPlugin = {
  name: 'raw-suffix',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw' }));
    b.onLoad({ filter: /.*/, namespace: 'raw' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
  },
};

await build({
  entryPoints: readdirSync('tests').filter(f => f.endsWith('.test.ts')).map(f => `tests/${f}`),
  bundle: true, platform: 'node', format: 'esm', outdir: '.test-build', external: ['exceljs'], plugins: [rawPlugin], logLevel: 'error',
  define: { 'import.meta.env.VITE_SUPABASE_URL': '"http://localhost"', 'import.meta.env.VITE_SUPABASE_ANON_KEY': '"test-key"' },
});
