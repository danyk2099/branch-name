import {
  generateBranchName,
  checkoutCommand,
  charLength,
  availablePrefixes,
  resolvePrefix,
} from '../src/branch-name.js';
import { loadSettings, translateTitle } from '../src/settings.js';
import { needsTranslation } from '../src/translate.js';
import { extractJiraIssue } from '../src/jira-extract.js';

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'),
  key: $('issue-key'),
  prefix: $('prefix'),
  detectedType: $('detected-type'),
  title: $('issue-title'),
  translation: $('translation'),
  translationText: $('translation-text'),
  translate: $('translate'),
  showOriginal: $('show-original'),
  branch: $('branch'),
  length: $('length'),
  copyBranch: $('copy-branch'),
  copyCommand: $('copy-command'),
  feedback: $('feedback'),
};

let settings;
const state = { original: '', translated: '', showingOriginal: false };

async function detectIssue() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractJiraIssue,
    });
    return injection?.result ?? null;
  } catch {
    // chrome://, edge://, the web store, PDFs etc. cannot be scripted.
    return null;
  }
}

function languageName(code) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

function setStatus(text, warn = false) {
  els.status.textContent = text;
  els.status.classList.toggle('warn', warn);
}

function fillPrefixes(type) {
  const selected = resolvePrefix(type, settings);
  const prefixes = availablePrefixes(settings);
  if (!prefixes.includes(selected)) prefixes.unshift(selected);
  els.prefix.replaceChildren(
    ...prefixes.map((p) => new Option(p || '(no prefix)', p, false, p === selected)),
  );
  els.detectedType.textContent = type || '';
  els.detectedType.title = type ? `Jira issue type: ${type}` : '';
}

function updateLength() {
  const length = charLength(els.branch.value);
  els.length.textContent = `${length} / ${settings.maxLength}`;
  els.length.classList.toggle('over', length > settings.maxLength);
  const empty = els.branch.value.trim() === '';
  els.copyBranch.disabled = empty;
  els.copyCommand.disabled = empty;
}

function regenerate() {
  els.branch.value = generateBranchName(
    { key: els.key.value, title: els.title.value, prefix: els.prefix.value },
    settings,
  );
  updateLength();
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for when the async clipboard API is unavailable.
    const scratch = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(scratch);
    scratch.select();
    const ok = document.execCommand('copy');
    scratch.remove();
    if (!ok) {
      els.feedback.textContent = 'Could not access the clipboard.';
      els.feedback.classList.add('error');
      return false;
    }
  }
  els.feedback.classList.remove('error');
  els.feedback.textContent = `${label} copied to clipboard.`;
  return true;
}

// --- Translation --------------------------------------------------------

function showTranslationPanel({ message, warn = false, translateLabel = null, toggle = false }) {
  els.translation.hidden = false;
  els.translationText.replaceChildren(...(Array.isArray(message) ? message : [message]));
  els.translationText.classList.toggle('warn', warn);
  els.translate.hidden = !translateLabel;
  if (translateLabel) els.translate.textContent = translateLabel;
  els.showOriginal.hidden = !toggle;
  els.showOriginal.textContent = state.showingOriginal ? 'Use translation' : 'Use original';
}

/** @returns {Promise<boolean>} true if the title is ready (translated or not needed). */
async function runTranslation() {
  const original = state.original;
  if (!original || settings.translateProvider === 'none' || !needsTranslation(original)) {
    els.translation.hidden = true;
    return true;
  }

  const lang = languageName(settings.sourceLanguage);
  showTranslationPanel({ message: `Translating from ${lang}…` });
  els.title.disabled = true;
  try {
    const { text } = await translateTitle(original, settings);
    state.translated = text;
    state.showingOriginal = false;
    if (els.title.value === original) els.title.value = text;
    regenerate();
    const originalSpan = Object.assign(document.createElement('span'), { className: 'original', textContent: original });
    showTranslationPanel({ message: [`Translated from ${lang}. Original: `, originalSpan], toggle: true });
    return true;
  } catch (err) {
    const download = err.code === 'needs-download';
    showTranslationPanel({
      message: download
        ? `${lang} titles need a one-time download of the browser's translation model (it then works offline).`
        : err.message,
      warn: !download,
      translateLabel: download ? 'Download & translate' : 'Retry',
    });
    return false;
  } finally {
    els.title.disabled = false;
  }
}

function toggleOriginal() {
  state.showingOriginal = !state.showingOriginal;
  els.title.value = state.showingOriginal ? state.original : state.translated;
  els.showOriginal.textContent = state.showingOriginal ? 'Use translation' : 'Use original';
  regenerate();
}

// --- Startup ------------------------------------------------------------

async function init() {
  settings = await loadSettings();
  fillPrefixes('');

  els.key.addEventListener('input', regenerate);
  els.title.addEventListener('input', regenerate);
  els.prefix.addEventListener('change', regenerate);
  els.branch.addEventListener('input', updateLength);
  els.copyBranch.addEventListener('click', () => copy(els.branch.value.trim(), 'Branch name'));
  els.copyCommand.addEventListener('click', () => copy(checkoutCommand(els.branch.value.trim()), 'Checkout command'));
  els.translate.addEventListener('click', runTranslation);
  els.showOriginal.addEventListener('click', toggleOriginal);
  $('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  els.branch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.copyBranch.click();
  });

  const issue = await detectIssue();
  if (issue?.title || issue?.key) {
    els.key.value = issue.key;
    els.title.value = issue.title;
    state.original = issue.title;
    fillPrefixes(issue.type);
    const typeText = issue.type ? ` (${issue.type})` : '';
    setStatus(
      issue.key ? `Found ${issue.key}${typeText} on this page.` : 'Found an issue title, but no key.',
      !issue.key,
    );
  } else {
    setStatus('No Jira issue found on this page. Type a title to generate a name.', true);
  }

  regenerate();
  (els.branch.value ? els.copyBranch : els.title).focus();

  const ready = await runTranslation();
  if (ready && settings.autoCopy && els.branch.value) {
    await copy(els.branch.value, 'Branch name');
  }
}

init();
