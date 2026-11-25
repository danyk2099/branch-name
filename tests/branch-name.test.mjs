import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  generateBranchName as gen,
  normalizeSettings,
  validateSettings,
  checkoutCommand,
} from '../src/branch-name.js';

const issue = (title, key = 'PROJ-123') => ({ key, title });

test('default settings produce key + kebab-case title', () => {
  assert.equal(gen(issue('Add login page')), 'PROJ-123-add-login-page');
});

test('punctuation is replaced, quotes are removed, separators collapse', () => {
  assert.equal(
    gen(issue("Fix user's session (SSO & 2FA) - urgent!!")),
    'PROJ-123-fix-users-session-sso-2fa-urgent',
  );
});

test('typographic quotes and dashes are normalised', () => {
  assert.equal(gen(issue('Don’t crash — ever')), 'PROJ-123-dont-crash-ever');
});

test('accents are transliterated in ASCII mode', () => {
  assert.equal(gen(issue('Café crème für Straße')), 'PROJ-123-cafe-creme-fur-strasse');
});

test('non-Latin titles fall back to the key in ASCII mode', () => {
  assert.equal(gen(issue('תיקון באג')), 'PROJ-123');
});

test('non-ASCII is kept when ASCII mode is off', () => {
  assert.equal(gen(issue('תיקון באג'), { asciiOnly: false }), 'PROJ-123-תיקון-באג');
});

test('prefix is kept and counts towards the "/" limit', () => {
  assert.equal(
    gen(issue('Login/logout flow'), { prefix: 'feature/' }),
    'feature/PROJ-123-login-logout-flow',
  );
});

test('without a prefix the first "/" in the title is allowed once', () => {
  assert.equal(gen(issue('a/b/c')), 'PROJ-123-a/b-c');
});

test('a prefix ending in a letter gets a separator', () => {
  assert.equal(gen(issue('Thing'), { prefix: 'feat' }), 'feat-PROJ-123-thing');
});

test('limited character: max 0 behaves like replace', () => {
  assert.equal(gen(issue('a/b'), { limitedChars: [{ char: '/', max: 0 }] }), 'PROJ-123-a-b');
});

test('limited character that is the separator: excess is dropped', () => {
  const s = { limitedChars: [{ char: '-', max: 2 }] };
  // key uses 1, joiner uses 1, the rest of the hyphens are dropped
  assert.equal(gen(issue('one two three'), s), 'PROJ-123-onetwothree');
});

test('limited underscore with underscore allowed', () => {
  const s = { limitedChars: [{ char: '_', max: 1 }] };
  assert.equal(gen(issue('snake_case and more_snake'), s), 'PROJ-123-snake_case-and-more-snake');
});

test('remove mode drops prohibited characters instead of replacing', () => {
  assert.equal(gen(issue('A&B test'), { prohibitedMode: 'remove' }), 'PROJ-123-ab-test');
  assert.equal(gen(issue('A&B test')), 'PROJ-123-a-b-test');
});

test('custom prohibited characters', () => {
  assert.equal(gen(issue('use_snake_case'), { prohibitedChars: '_' }), 'PROJ-123-use-snake-case');
});

test('max length truncates the title on a word boundary', () => {
  const name = gen(issue('This is a really long title that goes on and on forever'), { maxLength: 30 });
  assert.equal(name, 'PROJ-123-this-is-a-really-long');
  assert.ok(name.length <= 30);
});

test('max length hard-cuts a single long word', () => {
  const name = gen(issue('supercalifragilisticexpialidocious'), { maxLength: 20 });
  assert.equal(name, 'PROJ-123-supercalifr');
});

test('max length never leaves a trailing separator', () => {
  for (let max = 10; max < 50; max++) {
    const name = gen(issue('aa bb cc dd ee ff gg hh ii jj kk ll'), { maxLength: max });
    assert.ok(name.length <= max, `${name} > ${max}`);
    assert.ok(!/[-./]$/.test(name), name);
  }
});

test('options: no key, lowercase key, separator', () => {
  assert.equal(gen(issue('Add thing'), { includeIssueKey: false }), 'add-thing');
  assert.equal(gen(issue('Add thing'), { lowercaseKey: true }), 'proj-123-add-thing');
  assert.equal(gen(issue('Add thing'), { separator: '_' }), 'PROJ-123_add_thing');
  assert.equal(gen(issue('Add Thing'), { lowercaseTitle: false }), 'PROJ-123-Add-Thing');
});

test('git rules hold even when the user allows everything', () => {
  const s = { prohibitedChars: '', limitedChars: [] };
  const name = gen(issue('..hidden @{upstream} x.lock ~^:?*[\\ end.'), s);
  assert.equal(name, 'PROJ-123-hidden-@upstream}-x.lock-end');
  assert.doesNotThrow(() => execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'pipe' }));
});

test('generated names pass git check-ref-format for a range of nasty titles', () => {
  const titles = [
    'Normal title',
    '/leading slash',
    'trailing dot.',
    'release 1.2..3 notes',
    'refs/heads/main',
    'x.lock',
    '-leading dash',
    '@',
    'tab\tand\nnewline',
    'emoji 🚀 launch',
  ];
  const configs = [{}, { prefix: 'feature/' }, { prohibitedChars: '', limitedChars: [] }, { includeIssueKey: false }];
  for (const title of titles) {
    for (const cfg of configs) {
      const name = gen(issue(title), cfg);
      if (!name) continue;
      assert.doesNotThrow(
        () => execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'pipe' }),
        `invalid: ${JSON.stringify(name)} from ${JSON.stringify(title)} ${JSON.stringify(cfg)}`,
      );
    }
  }
});

test('empty input gives empty output', () => {
  assert.equal(gen({ key: '', title: '' }), '');
  assert.equal(gen({ key: '', title: '!!!' }), '');
});

test('normalizeSettings repairs bad values', () => {
  const s = normalizeSettings({
    separator: '--',
    maxLength: 'abc',
    prohibitedChars: 'aab',
    limitedChars: [{ char: '/', max: 1 }, { char: '/', max: 5 }, { char: 'xy', max: 1 }, { char: '_', max: -1 }],
    prohibitedMode: 'nope',
  });
  assert.equal(s.separator, '-');
  assert.equal(s.maxLength, 60);
  assert.equal(s.prohibitedChars, 'ab');
  assert.deepEqual(s.limitedChars, [{ char: '/', max: 1 }]);
  assert.equal(s.prohibitedMode, 'replace');
  assert.equal(normalizeSettings({ maxLength: 3 }).maxLength, 10);
});

test('validateSettings flags conflicts', () => {
  const w = validateSettings({ separator: '_', prohibitedChars: '_/', limitedChars: [{ char: '/', max: 1 }] });
  assert.equal(w.length, 3); // separator prohibited, "/" prohibited+limited, prefixes contain "/"
});

test('checkoutCommand quotes only when needed', () => {
  assert.equal(checkoutCommand('feature/PROJ-1-x'), 'git checkout -b feature/PROJ-1-x');
  assert.equal(checkoutCommand("it's&co"), "git checkout -b 'it'\\''s&co'");
});
