/**
 * Translate issue titles to English before they become branch names.
 *
 * Providers:
 *  - builtin: the browser's on-device Translator API (Chrome 138+). Nothing
 *    leaves the machine. Needs a one-off language model download.
 *  - deepl / google / azure: the official cloud APIs, using the user's key.
 */

export const PROVIDERS = {
  builtin: { label: 'Browser built-in (on-device, private)', needsKey: false, origins: [] },
  deepl: {
    label: 'DeepL API',
    needsKey: true,
    origins: ['https://api-free.deepl.com/*', 'https://api.deepl.com/*'],
  },
  google: {
    label: 'Google Cloud Translation',
    needsKey: true,
    origins: ['https://translation.googleapis.com/*'],
  },
  azure: {
    label: 'Microsoft Azure Translator',
    needsKey: true,
    origins: ['https://api.cognitive.microsofttranslator.com/*'],
  },
  none: { label: 'Off', needsKey: false, origins: [] },
};

export class TranslationError extends Error {
  /** @param {'unsupported'|'needs-download'|'no-key'|'no-permission'|'failed'} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** True if the text contains letters outside the Latin script (Hebrew, Cyrillic, …). */
export function needsTranslation(text) {
  return /(?!\p{Script=Latin})\p{L}/u.test(text ?? '');
}

async function readJson(response, provider) {
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.message || body?.error?.message || body?.error?.code || '';
    } catch { /* not JSON */ }
    const hint = response.status === 401 || response.status === 403 ? ' Check the API key.' : '';
    throw new TranslationError('failed', `${provider} returned ${response.status}${detail ? `: ${detail}` : ''}.${hint}`);
  }
  return response.json();
}

async function viaBuiltin(text, { sourceLanguage }) {
  const Translator = globalThis.Translator;
  if (!Translator) {
    throw new TranslationError(
      'unsupported',
      'This browser has no built-in translator. Use Chrome 138 or newer, or choose a cloud provider in settings.',
    );
  }
  const options = { sourceLanguage, targetLanguage: 'en' };
  const availability = await Translator.availability(options);
  if (availability === 'unavailable') {
    throw new TranslationError('unsupported', `The built-in translator can't translate "${sourceLanguage}" to English.`);
  }
  // Downloading a model must be started by a click.
  if (availability !== 'available' && !navigator.userActivation?.isActive) {
    throw new TranslationError('needs-download', 'The translation model needs a one-time download.');
  }
  const translator = await Translator.create(options);
  try {
    return await translator.translate(text);
  } finally {
    translator.destroy?.();
  }
}

async function viaDeepl(text, { apiKey }, fetchImpl) {
  const host = apiKey.trim().endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const response = await fetchImpl(`${host}/v2/translate`, {
    method: 'POST',
    headers: { Authorization: `DeepL-Auth-Key ${apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: [text], target_lang: 'EN-US' }),
  });
  const data = await readJson(response, 'DeepL');
  return data.translations?.[0]?.text;
}

async function viaGoogle(text, { apiKey }, fetchImpl) {
  const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey.trim())}`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, target: 'en', format: 'text' }),
  });
  const data = await readJson(response, 'Google');
  return data.data?.translations?.[0]?.translatedText;
}

async function viaAzure(text, { apiKey, azureRegion }, fetchImpl) {
  const headers = { 'Ocp-Apim-Subscription-Key': apiKey.trim(), 'Content-Type': 'application/json' };
  if (azureRegion) headers['Ocp-Apim-Subscription-Region'] = azureRegion;
  const response = await fetchImpl(
    'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=en',
    { method: 'POST', headers, body: JSON.stringify([{ Text: text }]) },
  );
  const data = await readJson(response, 'Azure');
  return data?.[0]?.translations?.[0]?.text;
}

const IMPLEMENTATIONS = { builtin: viaBuiltin, deepl: viaDeepl, google: viaGoogle, azure: viaAzure };

/**
 * Translate `text` to English with the configured provider.
 * @param {string} text
 * @param {{translateProvider: string, sourceLanguage: string, azureRegion?: string}} settings
 * @param {{apiKey?: string, fetch?: typeof fetch}} [options]
 * @returns {Promise<string>}
 */
export async function translateText(text, settings, { apiKey = '', fetch: fetchImpl = globalThis.fetch } = {}) {
  const provider = settings.translateProvider;
  const impl = IMPLEMENTATIONS[provider];
  if (!impl) throw new TranslationError('unsupported', 'Translation is turned off.');
  if (PROVIDERS[provider].needsKey && !apiKey.trim()) {
    throw new TranslationError('no-key', `Add your ${PROVIDERS[provider].label} key in the extension settings.`);
  }

  let result;
  try {
    result = await impl(text, { ...settings, apiKey }, fetchImpl);
  } catch (err) {
    if (err instanceof TranslationError) throw err;
    throw new TranslationError('failed', `Translation failed: ${err.message}`);
  }
  if (typeof result !== 'string' || !result.trim()) {
    throw new TranslationError('failed', 'The translator returned an empty result.');
  }
  return result.trim();
}
