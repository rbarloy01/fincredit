import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenRouterPayload, defaultModelForProvider, fallbackCandidates, normalizeAISettings, resolveMediaAccess, type AISettings } from '../src/services/ai';

const base = (over: Partial<AISettings> = {}): AISettings => ({ provider: 'openrouter', apiKey: 'k', model: 'stealth/ox-alpha', fallbackModels: ['openrouter/free'], ...over } as AISettings);
const media = { base64: 'AAAA', mimeType: 'application/pdf', fileName: 'eeff.pdf' };

test('a retired OpenRouter model saved in settings is migrated to the current default', () => {
  const n = normalizeAISettings(base());
  assert.equal(n.model, defaultModelForProvider('openrouter'));
  assert.notEqual(n.model, 'stealth/ox-alpha');
  assert.equal(n.providers!.openrouter.model, n.model);
  assert.ok(n.fallbackModels!.length >= 1 && n.fallbackModels!.length <= 2, 'OpenRouter accepts at most 3 models per request');
});

test('a model the user chose deliberately is never overwritten', () => {
  const n = normalizeAISettings(base({ model: 'google/gemini-3.5-flash', fallbackModels: ['openrouter/free'] }));
  assert.equal(n.model, 'google/gemini-3.5-flash');
  assert.deepEqual(n.fallbackModels, ['openrouter/free']);
});

test('text-only providers use the OCR text and drop attachments instead of failing the extraction', () => {
  const text = 'ESTADO DE RESULTADOS '.repeat(30);
  const r = resolveMediaAccess(normalizeAISettings(base()), text, media);
  assert.equal(r.droppedMedia, true);
  assert.equal(r.media, undefined);
  assert.equal(r.settings.provider, 'openrouter');
});

test('scanned documents (no text): OpenRouter keeps them and reads the page images; Bytez hands off to an enabled vision provider', () => {
  const gemini = { gemini: { provider: 'gemini', enabled: true, apiKey: 'g', model: 'gemini-flash-latest', fallbackModels: [] } } as any;
  const or = resolveMediaAccess(normalizeAISettings(base({ providers: gemini })), '', media);
  assert.equal(or.settings.provider, 'openrouter');
  assert.equal(or.media, media);
  const bytez = resolveMediaAccess(normalizeAISettings({ provider: 'bytez', apiKey: 'b', model: 'Qwen/Qwen3-4B', providers: gemini } as AISettings), '', media);
  assert.equal(bytez.settings.provider, 'gemini');
  const g = resolveMediaAccess(normalizeAISettings({ provider: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' } as AISettings), 'x', media);
  assert.equal(g.media, media);
  assert.equal(g.droppedMedia, false);
});

test('OpenRouter payload: page images go as image_url parts and a free vision model is used', () => {
  const s = normalizeAISettings(base({ model: 'nvidia/nemotron-3-super-120b-a12b:free' })); // text-only model
  const img = { base64: 'QUJD', mimeType: 'image/jpeg', fileName: 'p1' };
  const p = buildOpenRouterPayload(s, 'sys', 'extrae', [img, img]);
  const content = p.messages[1].content;
  assert.equal(Array.isArray(content), true);
  assert.equal(content.filter((c: any) => c.type === 'image_url').length, 2);
  assert.equal(content[1].image_url.url, 'data:image/jpeg;base64,QUJD');
  assert.equal(p.models[0], 'google/gemma-4-31b-it:free');
  assert.ok(p.models.length <= 3);
});

test('OpenRouter payload: no attachments keeps plain text and the configured model chain; PDFs use the free text parser', () => {
  const s = normalizeAISettings(base({ model: 'google/gemini-3.5-flash', fallbackModels: ['openrouter/free'] }));
  const text = buildOpenRouterPayload(s, 'sys', 'hola', []);
  assert.equal(text.messages[1].content, 'hola');
  assert.deepEqual(text.models, ['google/gemini-3.5-flash', 'openrouter/free']);
  const pdf = buildOpenRouterPayload(s, 'sys', 'hola', [{ base64: 'QUJD', mimeType: 'application/pdf', fileName: 'e.pdf' }]);
  assert.equal(pdf.messages[1].content[1].type, 'file');
  assert.equal(pdf.plugins[0].pdf.engine, 'pdf-text');
  assert.equal(pdf.models[0], 'google/gemini-3.5-flash'); // already vision-capable: user's choice respected
});

const withProviders = (provider: AISettings['provider'], enabled: Record<string, string>): AISettings => normalizeAISettings({
  provider, apiKey: enabled[provider] || 'k', model: defaultModelForProvider(provider),
  providers: Object.fromEntries(Object.entries(enabled).map(([p, key]) => [p, { provider: p, enabled: true, apiKey: key, model: defaultModelForProvider(p as any), fallbackModels: [] }])),
} as AISettings);

test('fallback order: NVIDIA NIM first, then OpenRouter, then Gemini; disabled providers and those without a key are skipped', () => {
  const s = withProviders('openrouter', { openrouter: 'o', nvidia_nim: 'n', gemini: 'g' });
  assert.deepEqual(fallbackCandidates(s, 'x'.repeat(300), undefined).map(c => c.provider), ['nvidia_nim', 'gemini']);
  const keyless = withProviders('gemini', { gemini: 'g', nvidia_nim: '', openrouter: 'o' });
  assert.deepEqual(fallbackCandidates(keyless, 'texto', undefined).map(c => c.provider), ['openrouter']);
});

test('fallback never hands scanned images (no OCR text) to a text-only provider', () => {
  const s = withProviders('openrouter', { openrouter: 'o', nvidia_nim: 'n', bytez: 'b' });
  const picks = fallbackCandidates(s, '', media).map(c => c.provider);
  assert.ok(picks.includes('nvidia_nim'));
  assert.ok(!picks.includes('bytez'));
});

test('NVIDIA NIM reads page images when the document has no text, and keeps its text-only model otherwise', () => {
  const nim = withProviders('nvidia_nim', { nvidia_nim: 'n' });
  assert.equal(resolveMediaAccess(nim, '', media).media, media);
  assert.equal(resolveMediaAccess(nim, 'T'.repeat(400), media).droppedMedia, true);
});
