import { DEFAULT_SETTINGS, normalizeSettings } from './branch-name.js';
import { PROVIDERS, TranslationError, translateText } from './translate.js';

const STORAGE_KEY = 'settings';
const API_KEY = 'translateApiKey';
const CACHE_KEY = 'translationCache';
const CACHE_LIMIT = 300;

/** Settings live in storage.sync so they follow the user across browsers/devices. */
export async function loadSettings() {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  return normalizeSettings(stored[STORAGE_KEY]);
}

export async function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  await chrome.storage.sync.set({ [STORAGE_KEY]: normalized });
  return normalized;
}

export async function resetSettings() {
  return saveSettings(DEFAULT_SETTINGS);
}

/** The API key stays in storage.local: it is never synced to other devices. */
export async function loadApiKey() {
  const stored = await chrome.storage.local.get(API_KEY);
  return stored[API_KEY] ?? '';
}

export async function saveApiKey(key) {
  await chrome.storage.local.set({ [API_KEY]: String(key ?? '').trim() });
}

/** Must be called directly from a click handler (before any await). */
export function requestProviderPermission(provider) {
  const origins = PROVIDERS[provider]?.origins ?? [];
  return origins.length ? chrome.permissions.request({ origins }) : Promise.resolve(true);
}

export async function hasProviderPermission(provider) {
  const origins = PROVIDERS[provider]?.origins ?? [];
  return origins.length ? chrome.permissions.contains({ origins }) : true;
}

/**
 * Translate a title with caching (repeat opens of the same issue cost nothing).
 * @returns {Promise<{text: string, cached: boolean}>}
 */
export async function translateTitle(title, settings) {
  const cacheId = `${settings.translateProvider}|${settings.sourceLanguage}|${title}`;
  const { [CACHE_KEY]: cache = {} } = await chrome.storage.local.get(CACHE_KEY);
  if (cache[cacheId]) return { text: cache[cacheId], cached: true };

  if (!(await hasProviderPermission(settings.translateProvider))) {
    throw new TranslationError(
      'no-permission',
      `Allow access to ${PROVIDERS[settings.translateProvider].label} by saving the extension settings again.`,
    );
  }

  const text = await translateText(title, settings, { apiKey: await loadApiKey() });

  const entries = Object.entries({ ...cache, [cacheId]: text });
  await chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(entries.slice(-CACHE_LIMIT)) });
  return { text, cached: false };
}

export async function clearTranslationCache() {
  await chrome.storage.local.remove(CACHE_KEY);
}
