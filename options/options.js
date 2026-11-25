import {
  DEFAULT_SETTINGS,
  generateBranchName,
  normalizeSettings,
  validateSettings,
  charLength,
} from '../src/branch-name.js';
import {
  loadSettings,
  saveSettings,
  loadApiKey,
  saveApiKey,
  requestProviderPermission,
  clearTranslationCache,
} from '../src/settings.js';
import { PROVIDERS, needsTranslation, translateText } from '../src/translate.js';

const $ = (id) => document.getElementById(id);
const form = $('form');

const TEXT_FIELDS = ['prefix', 'separator', 'maxLength', 'prohibitedChars', 'azureRegion'];
const SELECTS = ['translateProvider', 'sourceLanguage'];
const CHECKBOXES = ['useTypePrefix', 'includeIssueKey', 'lowercaseKey', 'lowercaseTitle', 'asciiOnly', 'autoCopy'];

let savedSnapshot = '';
let savedApiKey = '';
/** Translation of the sample title, kept while the sample title is unchanged. */
let sampleTranslation = null;

// --- Editable tables -----------------------------------------------------

const tables = {
  types: {
    body: $('types-body'),
    template: $('type-row'),
    fill: (row, { type = '', prefix = '' }) => {
      row.querySelector('.type-name').value = type;
      row.querySelector('.type-prefix').value = prefix;
    },
    read: (row) => ({
      type: row.querySelector('.type-name').value,
      prefix: row.querySelector('.type-prefix').value,
    }),
  },
  limits: {
    body: $('limits-body'),
    template: $('limit-row'),
    fill: (row, { char = '', max = 1 }) => {
      row.querySelector('.limit-char').value = char;
      row.querySelector('.limit-max').value = max;
    },
    read: (row) => ({
      char: row.querySelector('.limit-char').value,
      max: row.querySelector('.limit-max').value,
    }),
  },
};

function addRow(table, values = {}) {
  const row = table.template.content.firstElementChild.cloneNode(true);
  table.fill(row, values);
  table.body.append(row);
  return row;
}

function setRows(table, list) {
  table.body.replaceChildren();
  list.forEach((values) => addRow(table, values));
}

const readRows = (table) => [...table.body.rows].map(table.read);

// --- Form <-> settings ----------------------------------------------------

function fillForm(settings) {
  for (const name of TEXT_FIELDS) $(name).value = settings[name];
  for (const name of SELECTS) $(name).value = settings[name];
  for (const name of CHECKBOXES) $(name).checked = settings[name];
  form.elements.prohibitedMode.value = settings.prohibitedMode;
  setRows(tables.types, settings.typePrefixes);
  setRows(tables.limits, settings.limitedChars);
}

function readForm() {
  const raw = {};
  for (const name of TEXT_FIELDS) raw[name] = $(name).value;
  for (const name of SELECTS) raw[name] = $(name).value;
  for (const name of CHECKBOXES) raw[name] = $(name).checked;
  raw.prohibitedMode = form.elements.prohibitedMode.value;
  raw.typePrefixes = readRows(tables.types);
  raw.limitedChars = readRows(tables.limits);
  return raw;
}

/** Problems that normalizeSettings would silently fix; shown so nothing is lost by surprise. */
function formWarnings(raw) {
  const warnings = [];
  if (charLength(raw.separator) !== 1 || /\s/.test(raw.separator)) {
    warnings.push('The separator must be exactly one non-space character; "-" will be used.');
  }
  const seen = new Set();
  for (const { char, max } of raw.limitedChars) {
    if (char === '' && max === '') continue;
    if (charLength(char) !== 1) warnings.push(`Limited character "${char}" must be exactly one character; this row will be ignored.`);
    else if (seen.has(char)) warnings.push(`"${char}" is listed more than once; only the first row counts.`);
    else if (!(Number.parseInt(max, 10) >= 0)) warnings.push(`Give "${char}" a maximum of 0 or more.`);
    seen.add(char);
  }
  for (const { type, prefix } of raw.typePrefixes) {
    if (!type.trim() && prefix.trim()) warnings.push(`The prefix "${prefix}" has no issue type; this row will be ignored.`);
  }
  if (PROVIDERS[raw.translateProvider]?.needsKey && !$('apiKey').value.trim()) {
    warnings.push(`${PROVIDERS[raw.translateProvider].label} needs an API key.`);
  }
  return warnings;
}

// --- Rendering ------------------------------------------------------------

function renderChips(chars) {
  const chips = [...new Set(Array.from(chars))].map((c) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = c === ' ' ? '␠' : c;
    return chip;
  });
  $('prohibited-chips').replaceChildren(...chips);
}

function renderProviderPanels(provider) {
  $('builtin-panel').hidden = provider !== 'builtin';
  $('cloud-panel').hidden = !PROVIDERS[provider]?.needsKey;
  $('azure-region-field').hidden = provider !== 'azure';
  $('sourceLanguage').disabled = provider === 'none';
  $('translate-sample').disabled = provider === 'none';
}

function updatePreview() {
  const raw = readForm();
  const settings = normalizeSettings(raw);
  renderProviderPanels(settings.translateProvider);

  const sampleTitle = $('sample-title').value;
  if (sampleTranslation && sampleTranslation.from !== sampleTitle) sampleTranslation = null;
  if (!sampleTranslation) {
    $('sample-translation').textContent = needsTranslation(sampleTitle) && settings.translateProvider !== 'none'
      ? 'Click to see the name built from the translated title.'
      : '';
  }

  const name = generateBranchName(
    { key: $('sample-key').value, type: $('sample-type').value, title: sampleTranslation?.text ?? sampleTitle },
    settings,
  );
  $('preview').textContent = name || '(empty)';
  renderChips(raw.prohibitedChars);

  const warnings = [...formWarnings(raw), ...validateSettings(settings)];
  $('warnings').replaceChildren(
    ...warnings.map((w) => Object.assign(document.createElement('li'), { textContent: w })),
  );

  const dirty = JSON.stringify(settings) !== savedSnapshot || $('apiKey').value.trim() !== savedApiKey;
  $('saved').style.color = dirty ? 'var(--muted)' : '';
  $('saved').textContent = dirty ? 'Unsaved changes' : '';
}

// --- Built-in translator ---------------------------------------------------

async function refreshBuiltinStatus() {
  const status = $('builtin-status');
  const button = $('download-model');
  if (!globalThis.Translator) {
    status.textContent = 'Not supported in this browser. Choose a cloud provider instead.';
    button.hidden = true;
    return;
  }
  const lang = $('sourceLanguage').value;
  const availability = await Translator.availability({ sourceLanguage: lang, targetLanguage: 'en' });
  button.hidden = availability !== 'downloadable' && availability !== 'downloading';
  status.textContent = {
    available: 'Model downloaded. Ready to translate offline.',
    downloadable: 'Model not downloaded yet.',
    downloading: 'Model is downloading…',
    unavailable: 'This language pair is not supported by the built-in translator.',
  }[availability] ?? availability;
}

async function downloadModel() {
  const status = $('builtin-status');
  const lang = $('sourceLanguage').value;
  $('download-model').disabled = true;
  try {
    const translator = await Translator.create({
      sourceLanguage: lang,
      targetLanguage: 'en',
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          status.textContent = `Downloading… ${Math.round(e.loaded * 100)}%`;
        });
      },
    });
    translator.destroy?.();
  } catch (err) {
    status.textContent = `Download failed: ${err.message}`;
    return;
  } finally {
    $('download-model').disabled = false;
  }
  await refreshBuiltinStatus();
}

// --- Sample translation ------------------------------------------------------

async function translateSample() {
  const settings = normalizeSettings(readForm());
  const title = $('sample-title').value;
  const out = $('sample-translation');

  // Ask for host access first, while we still have the click's user gesture.
  const allowed = await requestProviderPermission(settings.translateProvider);
  if (!allowed) {
    out.textContent = 'Permission to contact the translation service was denied.';
    return;
  }
  out.textContent = 'Translating…';
  try {
    const text = await translateText(title, settings, { apiKey: $('apiKey').value });
    sampleTranslation = { from: title, text };
    out.textContent = `→ ${text}`;
  } catch (err) {
    sampleTranslation = null;
    out.textContent = err.message;
  }
  updatePreview();
  if (settings.translateProvider === 'builtin') refreshBuiltinStatus();
}

// --- Startup ---------------------------------------------------------------

async function init() {
  $('translateProvider').replaceChildren(
    ...Object.entries(PROVIDERS).map(([value, { label }]) => new Option(label, value)),
  );

  const settings = await loadSettings();
  savedApiKey = await loadApiKey();
  savedSnapshot = JSON.stringify(settings);
  fillForm(settings);
  $('apiKey').value = savedApiKey;
  updatePreview();
  refreshBuiltinStatus();

  form.addEventListener('input', updatePreview);
  form.addEventListener('change', (e) => {
    updatePreview();
    if (e.target.id === 'sourceLanguage' || e.target.id === 'translateProvider') refreshBuiltinStatus();
  });

  $('add-type').addEventListener('click', () => {
    addRow(tables.types).querySelector('.type-name').focus();
    updatePreview();
  });
  $('add-limit').addEventListener('click', () => {
    addRow(tables.limits).querySelector('.limit-char').focus();
    updatePreview();
  });
  form.addEventListener('click', (e) => {
    const button = e.target.closest('.remove-row');
    if (!button) return;
    button.closest('tr').remove();
    updatePreview();
  });

  $('download-model').addEventListener('click', downloadModel);
  $('translate-sample').addEventListener('click', translateSample);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = readForm();
    // Must start inside the click's user gesture, i.e. before any await.
    const permission = requestProviderPermission(raw.translateProvider);

    const previous = normalizeSettings(JSON.parse(savedSnapshot));
    const saved = await saveSettings(raw);
    await saveApiKey($('apiKey').value);
    if (saved.translateProvider !== previous.translateProvider || saved.sourceLanguage !== previous.sourceLanguage) {
      await clearTranslationCache();
    }
    savedSnapshot = JSON.stringify(saved);
    savedApiKey = $('apiKey').value.trim();
    fillForm(saved); // show the normalised values (e.g. de-duplicated characters)
    updatePreview();

    const granted = await permission.catch(() => false);
    $('saved').style.color = granted ? '' : 'var(--warning)';
    $('saved').textContent = granted
      ? 'Saved'
      : `Saved, but access to ${PROVIDERS[saved.translateProvider].label} was not granted, so translation won't work.`;
  });

  $('reset').addEventListener('click', () => {
    fillForm(normalizeSettings(DEFAULT_SETTINGS));
    updatePreview();
  });
}

init();
