/**
 * Pure branch-name generation logic. No browser APIs in here so it can be
 * unit-tested with plain Node (`npm test`).
 */

/** Characters git never allows in a ref name (see `git check-ref-format`). */
const GIT_FORBIDDEN = new Set(['~', '^', ':', '?', '*', '[', '\\']);

/** Quote characters are removed (never replaced) so "user's" becomes "users". */
const QUOTES = new Set(["'", '"', '`']);

/** Typographic characters mapped to plain ASCII before anything else. */
const PRE_MAP = {
  '‘': "'", '’': "'", '‚': "'", '´': "'",
  '“': '"', '”': '"', '„': '"',
  '–': '-', '—': '-', '−': '-',
  ' ': ' ', '…': '...',
};

/** Letters that Unicode decomposition does not reduce to ASCII. */
const TRANSLITERATE = {
  'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'ø': 'o', 'Ø': 'O', 'œ': 'oe', 'Œ': 'OE',
  'đ': 'd', 'Đ': 'D', 'ł': 'l', 'Ł': 'L', 'þ': 'th', 'Þ': 'TH', 'ð': 'd', 'Ð': 'D',
};

export const DEFAULT_SETTINGS = Object.freeze({
  /** Pick the prefix from the issue type using `typePrefixes`. */
  useTypePrefix: true,
  /** Issue type name (case/punctuation-insensitive) → prefix. */
  typePrefixes: [
    { type: 'Bug', prefix: 'bugfix/' },
    { type: 'Story', prefix: 'feature/' },
    { type: 'New Feature', prefix: 'feature/' },
    { type: 'Improvement', prefix: 'improvement/' },
    { type: 'Task', prefix: 'task/' },
    { type: 'Sub-task', prefix: 'task/' },
    { type: 'Epic', prefix: 'epic/' },
    { type: 'Spike', prefix: 'spike/' },
  ],
  /** Prefix when the type is unknown or not in the table (or type prefixes are off). */
  prefix: '',
  /** Translation provider for non-Latin titles: builtin | deepl | google | azure | none. */
  translateProvider: 'builtin',
  /** Language the titles are written in (ISO code); used by the built-in translator. */
  sourceLanguage: 'he',
  /** Only needed for Azure Translator resources that aren't global. */
  azureRegion: '',
  includeIssueKey: true,
  lowercaseKey: false,
  lowercaseTitle: true,
  /** Single character used between words. */
  separator: '-',
  maxLength: 60,
  /** Transliterate accents (é → e) and drop other non-ASCII characters. */
  asciiOnly: true,
  /** Every character in this string is prohibited. */
  prohibitedChars: "!\"#$%&'()*+,.;<=>?@[\\]^`{|}~:",
  /** 'replace' → prohibited chars become the separator; 'remove' → dropped. */
  prohibitedMode: 'replace',
  /** Characters that are allowed, but only `max` times in the whole name. */
  limitedChars: [{ char: '/', max: 1 }],
  /** Copy the branch name to the clipboard as soon as the popup opens. */
  autoCopy: false,
});

export const MIN_LENGTH = 10;
export const MAX_LENGTH = 255;

/** Length in code points (what a person would call "characters"). */
export function charLength(str) {
  return Array.from(str).length;
}

function isSingleChar(value) {
  return typeof value === 'string' && charLength(value) === 1;
}

/** Fill in defaults and coerce anything malformed (e.g. from old storage). */
export function normalizeSettings(raw = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };

  const separator = isSingleChar(s.separator) && !/\s/.test(s.separator) ? s.separator : '-';

  let maxLength = Number.parseInt(s.maxLength, 10);
  if (!Number.isFinite(maxLength)) maxLength = DEFAULT_SETTINGS.maxLength;
  maxLength = Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, maxLength));

  const prohibitedChars = [...new Set(Array.from(String(s.prohibitedChars ?? '')))].join('');

  const seen = new Set();
  const limitedChars = (Array.isArray(s.limitedChars) ? s.limitedChars : [])
    .map((l) => ({ char: l?.char, max: Number.parseInt(l?.max, 10) }))
    .filter((l) => isSingleChar(l.char) && Number.isFinite(l.max) && l.max >= 0)
    .filter((l) => (seen.has(l.char) ? false : seen.add(l.char)));

  const seenTypes = new Set();
  const typePrefixes = (Array.isArray(s.typePrefixes) ? s.typePrefixes : [])
    .map((t) => ({ type: String(t?.type ?? '').trim(), prefix: String(t?.prefix ?? '').trim() }))
    .filter((t) => normalizeTypeName(t.type) !== '')
    .filter((t) => {
      const k = normalizeTypeName(t.type);
      return seenTypes.has(k) ? false : seenTypes.add(k);
    });

  return {
    useTypePrefix: Boolean(s.useTypePrefix),
    typePrefixes,
    prefix: String(s.prefix ?? ''),
    translateProvider: ['builtin', 'deepl', 'google', 'azure', 'none'].includes(s.translateProvider)
      ? s.translateProvider
      : 'builtin',
    sourceLanguage: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(s.sourceLanguage) ? s.sourceLanguage : 'he',
    azureRegion: String(s.azureRegion ?? '').trim(),
    includeIssueKey: Boolean(s.includeIssueKey),
    lowercaseKey: Boolean(s.lowercaseKey),
    lowercaseTitle: Boolean(s.lowercaseTitle),
    separator,
    maxLength,
    asciiOnly: Boolean(s.asciiOnly),
    prohibitedChars,
    prohibitedMode: s.prohibitedMode === 'remove' ? 'remove' : 'replace',
    limitedChars,
    autoCopy: Boolean(s.autoCopy),
  };
}

/** "Sub-task", "subtask" and "SUB TASK" all compare equal. */
export function normalizeTypeName(type) {
  return String(type ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** The prefix for an issue type, falling back to the general prefix. */
export function resolvePrefix(type, rawSettings) {
  const s = normalizeSettings(rawSettings);
  if (s.useTypePrefix && type) {
    const wanted = normalizeTypeName(type);
    const match = s.typePrefixes.find((t) => normalizeTypeName(t.type) === wanted);
    if (match) return match.prefix;
  }
  return s.prefix;
}

/** Every distinct prefix the settings can produce (for the popup's type picker). */
export function availablePrefixes(rawSettings) {
  const s = normalizeSettings(rawSettings);
  const prefixes = s.useTypePrefix ? s.typePrefixes.map((t) => t.prefix) : [];
  return [...new Set([...prefixes, s.prefix, ''])];
}

/** Problems with the settings that the user should know about. */
export function validateSettings(raw) {
  const s = normalizeSettings(raw);
  const prohibited = new Set(Array.from(s.prohibitedChars));
  const warnings = [];

  if (prohibited.has(s.separator)) {
    warnings.push(`The separator "${s.separator}" is also prohibited; words would be glued together.`);
  }
  if (GIT_FORBIDDEN.has(s.separator)) {
    warnings.push(`Git does not allow "${s.separator}" in branch names, so it cannot be the separator.`);
  }
  for (const l of s.limitedChars) {
    if (prohibited.has(l.char)) {
      warnings.push(`"${l.char}" is both prohibited and limited; prohibited wins.`);
    }
  }
  const prefixes = [s.prefix, ...s.typePrefixes.map((t) => t.prefix)];
  const badPrefix = prefixes.flatMap((p) => Array.from(p)).filter((c) => prohibited.has(c) || GIT_FORBIDDEN.has(c));
  if (badPrefix.length) {
    warnings.push(`A prefix contains characters that will be stripped: ${[...new Set(badPrefix)].join(' ')}`);
  }
  const slashLimit = s.limitedChars.find((l) => l.char === '/');
  const maxSlashes = Math.max(...prefixes.map((p) => (p.match(/\//g) || []).length));
  if (slashLimit && maxSlashes > slashLimit.max) {
    warnings.push(`A prefix has ${maxSlashes} "/" but "/" is limited to ${slashLimit.max}; the extra ones become the separator.`);
  }
  return warnings;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isControl(ch) {
  const c = ch.codePointAt(0);
  return c < 0x20 || c === 0x7f;
}

function toAscii(text) {
  return Array.from(text, (ch) => TRANSLITERATE[ch] ?? ch)
    .join('')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
}

/**
 * Turn free text into separator-joined words: whitespace, git-forbidden and
 * prohibited characters become word breaks (or vanish, for quotes / 'remove').
 */
function sanitizeWords(text, s, prohibited) {
  let str = Array.from(text, (ch) => PRE_MAP[ch] ?? ch).join('');
  if (s.asciiOnly) str = toAscii(str);

  let out = '';
  for (const ch of str) {
    if (/\s/.test(ch) || isControl(ch) || GIT_FORBIDDEN.has(ch)) {
      out += ' ';
    } else if (s.asciiOnly && ch.codePointAt(0) > 0x7e) {
      out += ' ';
    } else if (prohibited.has(ch)) {
      out += QUOTES.has(ch) || s.prohibitedMode === 'remove' ? '' : ' ';
    } else {
      out += ch;
    }
  }
  return out.split(' ').filter(Boolean).join(s.separator);
}

/** Like sanitizeWords but keeps the user's text literally (used for the prefix). */
function sanitizeLiteral(text, s, prohibited) {
  let out = '';
  for (const ch of text) {
    if (/\s/.test(ch)) out += s.separator;
    else if (isControl(ch) || GIT_FORBIDDEN.has(ch) || prohibited.has(ch)) continue;
    else out += ch;
  }
  return out;
}

/** Collapse repeated separators and strip separators, dots and slashes from both ends. */
function tidy(str, sep) {
  const e = escapeRegExp(sep);
  return str
    .replace(new RegExp(`(?:${e}){2,}`, 'g'), sep)
    .replace(new RegExp(`^(?:${e}|[./])+|(?:${e}|[./])+$`, 'g'), '');
}

/**
 * Enforce "allowed at most N times". Counts are shared across calls (via the
 * `counts` map) so the limit applies to the whole branch name. Excess
 * occurrences become the separator (or vanish if the char is the separator).
 */
function createLimiter(limitedChars, sep) {
  const limits = new Map(limitedChars.map((l) => [l.char, l.max]));
  const counts = new Map();

  const take = (ch) => {
    if (!limits.has(ch)) return true;
    const used = counts.get(ch) ?? 0;
    if (used >= limits.get(ch)) return false;
    counts.set(ch, used + 1);
    return true;
  };

  const apply = (str) => {
    let out = '';
    for (const ch of str) {
      if (take(ch)) out += ch;
      else if (ch !== sep && take(sep)) out += sep;
    }
    return out;
  };

  return { take, apply };
}

/** Cut to `budget` characters, preferring to end on a word boundary. */
function truncateAtWord(text, budget, sep) {
  const chars = Array.from(text);
  if (chars.length <= budget) return text;
  if (budget <= 0) return '';

  let cut = chars.slice(0, budget);
  if (chars[budget] !== sep) {
    const lastSep = cut.lastIndexOf(sep);
    // Only back up to the previous word if that doesn't throw away too much.
    if (lastSep >= Math.ceil(budget / 2)) cut = cut.slice(0, lastSep);
  }
  return cut.join('');
}

/** Final pass for the rules in `git check-ref-format --branch`. */
function enforceGitRules(name, sep) {
  const e = escapeRegExp(sep);
  let n = name
    .replace(/\/{2,}/g, '/')
    .replace(/\.{2,}/g, '.')
    .replace(/@\{/g, '@');

  n = n
    .split('/')
    .map((seg) => seg.replace(/^\.+/, '').replace(/(?:\.lock)+$/i, ''))
    .filter(Boolean)
    .join('/');

  n = n.replace(/^[-./]+/, '').replace(new RegExp(`(?:${e}|[./])+$`), '');
  return n === '@' ? '' : n;
}

/**
 * Build a branch name from a Jira issue.
 * @param {{key?: string, title?: string, type?: string, prefix?: string}} issue
 *   `prefix`, when given, overrides the one derived from `type`.
 * @param {object} [rawSettings]
 * @returns {string} the branch name, or '' if there was nothing usable.
 */
export function generateBranchName({ key = '', title = '', type = '', prefix: prefixOverride } = {}, rawSettings = {}) {
  const s = normalizeSettings(rawSettings);
  const chosenPrefix = typeof prefixOverride === 'string' ? prefixOverride : resolvePrefix(type, s);
  const sep = s.separator;
  const prohibited = new Set(Array.from(s.prohibitedChars));
  const limiter = createLimiter(s.limitedChars, sep);

  // Sanitise each part first (without limits) so we know which parts exist.
  let keyPart = s.includeIssueKey ? String(key).trim() : '';
  if (s.lowercaseKey) keyPart = keyPart.toLowerCase();
  keyPart = tidy(sanitizeWords(keyPart, s, prohibited), sep);

  let titleText = String(title).trim();
  if (s.lowercaseTitle) titleText = titleText.toLowerCase();
  let titlePart = tidy(sanitizeWords(titleText, s, prohibited), sep);

  let prefix = sanitizeLiteral(chosenPrefix, s, prohibited);
  if (prefix && (keyPart || titlePart) && !/[/_\-.]$/.test(prefix)) prefix += sep;

  // Apply occurrence limits in the order the parts appear in the branch name.
  prefix = limiter.apply(prefix);
  keyPart = tidy(limiter.apply(keyPart), sep);
  const joiner = keyPart && titlePart && limiter.take(sep) ? sep : '';
  titlePart = tidy(limiter.apply(titlePart), sep);

  // Truncate the title only; the prefix and key are kept whole if they fit.
  const head = prefix + keyPart;
  const headLength = charLength(head) + charLength(joiner);
  let name;
  if (headLength >= s.maxLength) {
    name = Array.from(head).slice(0, s.maxLength).join('');
  } else {
    const truncated = tidy(truncateAtWord(titlePart, s.maxLength - headLength, sep), sep);
    name = head + (truncated ? joiner + truncated : '');
  }

  return enforceGitRules(name, sep);
}

/** `git checkout -b <name>`, quoting the name only if the shell needs it. */
export function checkoutCommand(name) {
  const safe = /^[A-Za-z0-9._/@+=,:-]+$/.test(name);
  const arg = safe ? name : `'${name.replace(/'/g, `'\\''`)}'`;
  return `git checkout -b ${arg}`;
}
