import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateBranchName as gen,
  resolvePrefix,
  availablePrefixes,
  normalizeSettings,
  validateSettings,
} from '../src/branch-name.js';
import { needsTranslation, translateText, TranslationError } from '../src/translate.js';

// --- issue type → prefix ----------------------------------------------------

test('issue type picks the prefix', () => {
  assert.equal(gen({ key: 'PROJ-1', type: 'Bug', title: 'Crash on save' }), 'bugfix/PROJ-1-crash-on-save');
  assert.equal(gen({ key: 'PROJ-2', type: 'Story', title: 'Dark mode' }), 'feature/PROJ-2-dark-mode');
});

test('type matching ignores case, spaces and dashes', () => {
  assert.equal(resolvePrefix('SUBTASK', {}), 'task/');
  assert.equal(resolvePrefix('sub task', {}), 'task/');
  assert.equal(resolvePrefix('new-feature', {}), 'feature/');
});

test('unknown type falls back to the general prefix', () => {
  assert.equal(resolvePrefix('Incident', {}), '');
  assert.equal(resolvePrefix('Incident', { prefix: 'misc/' }), 'misc/');
  assert.equal(resolvePrefix('', { prefix: 'misc/' }), 'misc/');
});

test('type prefixes can be turned off', () => {
  assert.equal(gen({ key: 'P-1', type: 'Bug', title: 'x' }, { useTypePrefix: false }), 'P-1-x');
});

test('custom (e.g. Hebrew) type names', () => {
  const s = { typePrefixes: [{ type: 'באג', prefix: 'bugfix/' }] };
  assert.equal(gen({ key: 'P-1', type: 'באג', title: 'Fix it' }, s), 'bugfix/P-1-fix-it');
});

test('explicit prefix overrides the type', () => {
  assert.equal(gen({ key: 'P-1', type: 'Bug', title: 'x', prefix: 'hotfix/' }), 'hotfix/P-1-x');
  assert.equal(gen({ key: 'P-1', type: 'Bug', title: 'x', prefix: '' }), 'P-1-x');
});

test('the type prefix uses up the "/" limit', () => {
  assert.equal(gen({ key: 'P-1', type: 'Bug', title: 'Login/logout' }), 'bugfix/P-1-login-logout');
});

test('availablePrefixes lists distinct prefixes plus "none"', () => {
  assert.deepEqual(availablePrefixes({}), ['bugfix/', 'feature/', 'improvement/', 'task/', 'epic/', 'spike/', '']);
});

test('normalizeSettings drops empty and duplicate type rows', () => {
  const s = normalizeSettings({
    typePrefixes: [{ type: 'Bug', prefix: 'a/' }, { type: 'bug', prefix: 'b/' }, { type: '  ', prefix: 'c/' }],
  });
  assert.deepEqual(s.typePrefixes, [{ type: 'Bug', prefix: 'a/' }]);
});

test('warns when a prefix has more slashes than allowed', () => {
  const w = validateSettings({ typePrefixes: [{ type: 'Bug', prefix: 'team/bugfix/' }] });
  assert.ok(w.some((m) => m.includes('"/" is limited to 1')));
});

// --- translation -------------------------------------------------------------

test('needsTranslation detects non-Latin letters only', () => {
  assert.equal(needsTranslation('תיקון באג בהתחברות'), true);
  assert.equal(needsTranslation('Fix login ב-SSO'), true);
  assert.equal(needsTranslation('Исправить вход'), true);
  assert.equal(needsTranslation('Café crème 123 !?'), false);
  assert.equal(needsTranslation(''), false);
});

function mockFetch(body, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: status < 400, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

const he = (provider, extra = {}) => ({ translateProvider: provider, sourceLanguage: 'he', ...extra });

test('DeepL: free keys use api-free host', async () => {
  const fetch = mockFetch({ translations: [{ text: 'Fix login bug' }] });
  const out = await translateText('תיקון באג', he('deepl'), { apiKey: 'abc:fx', fetch });
  assert.equal(out, 'Fix login bug');
  assert.equal(fetch.calls[0].url, 'https://api-free.deepl.com/v2/translate');
  assert.equal(fetch.calls[0].init.headers.Authorization, 'DeepL-Auth-Key abc:fx');
  assert.deepEqual(fetch.calls[0].body.text, ['תיקון באג']);
});

test('DeepL: pro keys use api host', async () => {
  const fetch = mockFetch({ translations: [{ text: 'x' }] });
  await translateText('א', he('deepl'), { apiKey: 'abc', fetch });
  assert.equal(fetch.calls[0].url, 'https://api.deepl.com/v2/translate');
});

test('Google Cloud', async () => {
  const fetch = mockFetch({ data: { translations: [{ translatedText: 'Add report' }] } });
  assert.equal(await translateText('הוספת דוח', he('google'), { apiKey: 'k y', fetch }), 'Add report');
  assert.match(fetch.calls[0].url, /\?key=k%20y$/);
  assert.equal(fetch.calls[0].body.target, 'en');
});

test('Azure sends region header only when set', async () => {
  const fetch = mockFetch([{ translations: [{ text: 'Update docs' }] }]);
  assert.equal(await translateText('עדכון', he('azure', { azureRegion: 'westeurope' }), { apiKey: 'k', fetch }), 'Update docs');
  assert.equal(fetch.calls[0].init.headers['Ocp-Apim-Subscription-Region'], 'westeurope');
  await translateText('עדכון', he('azure'), { apiKey: 'k', fetch });
  assert.equal(fetch.calls[1].init.headers['Ocp-Apim-Subscription-Region'], undefined);
});

test('missing key and HTTP errors become TranslationErrors', async () => {
  await assert.rejects(translateText('א', he('deepl'), { apiKey: '' }), (e) => e instanceof TranslationError && e.code === 'no-key');
  const fetch = mockFetch({ message: 'Forbidden' }, { status: 403 });
  await assert.rejects(
    translateText('א', he('deepl'), { apiKey: 'x', fetch }),
    (e) => e.code === 'failed' && /403: Forbidden\. Check the API key/.test(e.message),
  );
});

test('builtin: unsupported without the Translator API', async () => {
  await assert.rejects(translateText('א', he('builtin')), (e) => e.code === 'unsupported');
});

test('builtin: uses Translator when available', async () => {
  globalThis.Translator = {
    availability: async () => 'available',
    create: async (opts) => ({ translate: async (t) => `${opts.sourceLanguage}->${opts.targetLanguage}:${t}`, destroy() {} }),
  };
  try {
    assert.equal(await translateText('שלום', he('builtin')), 'he->en:שלום');
  } finally {
    delete globalThis.Translator;
  }
});

test('builtin: asks for a click when the model must be downloaded', async () => {
  globalThis.Translator = { availability: async () => 'downloadable', create: async () => assert.fail('no create') };
  try {
    await assert.rejects(translateText('שלום', he('builtin')), (e) => e.code === 'needs-download');
  } finally {
    delete globalThis.Translator;
  }
});

test('end to end: Hebrew bug title → translated branch', async () => {
  const fetch = mockFetch({ translations: [{ text: "Fix the user's login redirect" }] });
  const title = await translateText('תיקון הפניית התחברות של משתמש', he('deepl'), { apiKey: 'k:fx', fetch });
  assert.equal(gen({ key: 'PROJ-77', type: 'Bug', title }), 'bugfix/PROJ-77-fix-the-users-login-redirect');
});
