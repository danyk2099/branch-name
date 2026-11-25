# Build a Chrome/Edge extension: Jira issue → git branch name

Build a browser extension for Chrome and Microsoft Edge (Manifest V3). It reads the Jira issue open in the current tab and generates a git branch name from the issue's type, key and title. The developer copies the name to the clipboard and uses it with `git checkout -b`.

Please start with a spec (requirements, design, tasks) from this description, then implement it. The requirements below are detailed on purpose. Where something is ambiguous, choose the simpler option and note it in the design.

## Constraints (security review matters here)

- **Plain JavaScript (ES modules), HTML and CSS only.** No frameworks, no bundler, no npm runtime dependencies, no code loaded from remote URLs. Node's built-in test runner (`node --test`) is fine for development.
- **Minimal permissions:** `activeTab`, `scripting`, `storage`, `clipboardWrite`. No `host_permissions` for Jira. The extension reads a page only when the user clicks its icon, so it works on any Jira domain, including self-hosted ones.
- **Optional permissions only for translation services:** the hosts of the cloud translation APIs go in `optional_host_permissions`. Request them with `chrome.permissions.request` only when the user picks such a provider and saves. Call it synchronously inside the click handler, before any `await`, so the user gesture isn't lost.
- **API keys:** store them in `chrome.storage.local` (never synced). Keep all other settings in `chrome.storage.sync`.
- **No analytics, telemetry, or network calls** other than the Jira REST call (same origin as the Jira page) and the translation provider the user explicitly chose.

## Project layout

```
manifest.json
src/branch-name.js    pure generator logic: no browser APIs, unit-testable in Node
src/translate.js      translation providers; takes fetch as a parameter so tests can mock it
src/jira-extract.js   one self-contained function injected into the Jira tab
src/settings.js       chrome.storage wrapper: settings, API key, translation cache, permissions
popup/                popup.html / .css / .js
options/              options.html / .css / .js  (options_ui with open_in_tab: true)
styles/common.css     shared styles, light and dark (prefers-color-scheme)
icons/                16, 32, 48, 128 px PNGs
tests/                node:test unit tests
README.md
```

Add a keyboard shortcut: `commands._execute_action` with suggested key `Alt+Shift+B`.

## 1. Reading the issue from Jira (`src/jira-extract.js`)

This is one `async` function run with `chrome.scripting.executeScript({ target: { tabId }, func })`. It must be fully self-contained: no imports, and nothing referenced from module scope. It returns `{ key, title, type, source, url }`.

1. **Find the issue key** (pattern `[A-Z][A-Z0-9_]*-\d+`), in this order:
   - the `selectedIssue` query parameter (boards and backlogs with an issue open)
   - `/browse/KEY-123` in the path; also capture anything before `/browse` as the Jira Server context path
   - page elements: the Jira Cloud breadcrumb `[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]`, or Server's `#key-val` / `#issuekey-val`
   - the tab title, which Jira formats as `[KEY-123] Summary - Jira`
2. **Ask the REST API first:** `GET {origin}{contextPath}/rest/api/2/issue/{KEY}?fields=summary,issuetype` with `credentials: 'include'` and a 4-second timeout (`AbortController`). For the context path, use the one from `/browse`, or else `<meta name="ajs-context-path">`. If the call succeeds, return `fields.summary` and `fields.issuetype.name`.
3. **Fall back to the page:**
   - Title selectors, first match wins: `[data-testid="issue.views.issue-base.foundation.summary.heading"]`, `[data-test-id=…same…]`, `[data-testid*="summary.heading"]`, `#summary-val`, `#issue-content h1`.
   - Type: in Jira Cloud, the change-issue-type button (`[data-testid="issue.views.issue-base.foundation.change-issue-type.button"]`) has an `<img alt>` or an `aria-label` like `Bug - Change work type`. In Server, use `#type-val`.
   - When several elements match, prefer one inside `[role="dialog"]` (an issue opened over a board), then a visible one.
4. **Last resort:** take the title from the tab title, stripping a trailing ` - … Jira …`.

**Verify these selectors against our own Jira instance** (Cloud or Server/Data Center) and adjust them if needed.

## 2. Generating the branch name (`src/branch-name.js`)

Export `generateBranchName({ key, title, type, prefix? }, settings)`. When `prefix` is a string, it overrides the type-based prefix (the popup uses this). Also export:

- `normalizeSettings`: fills defaults and repairs bad stored values
- `validateSettings`: returns user-facing warnings
- `resolvePrefix(type, settings)`
- `availablePrefixes(settings)`
- `checkoutCommand(name)`
- `charLength`: counts code points, not UTF-16 units

### Settings and defaults

| Setting | Default | Meaning |
|---|---|---|
| `useTypePrefix` | `true` | Choose the prefix from the issue type |
| `typePrefixes` | Bug→`bugfix/`, Story→`feature/`, New Feature→`feature/`, Improvement→`improvement/`, Task→`task/`, Sub-task→`task/`, Epic→`epic/`, Spike→`spike/` | Editable table. Compare type names after lowercasing and removing everything except letters and digits, so `Sub-task` = `subtask` = `SUB TASK`. Localized names such as `באג` must work. |
| `prefix` | `''` | Fallback prefix for unknown or unmapped types, or when `useTypePrefix` is off |
| `separator` | `-` | Exactly one non-whitespace character |
| `maxLength` | `60` | Clamp to 10–255 |
| `includeIssueKey` / `lowercaseKey` / `lowercaseTitle` | `true` / `false` / `true` | |
| `asciiOnly` | `true` | Transliterate accents; drop letters that remain non-ASCII |
| `prohibitedChars` | ``!"#$%&'()*+,.;<=>?@[\]^`{|}~:`` | Every character in this string is prohibited |
| `prohibitedMode` | `replace` | `replace`: the character becomes a word break. `remove`: the character is deleted. |
| `limitedChars` | `[{ char: '/', max: 1 }]` | Characters allowed only `max` times in the whole name |
| `translateProvider` | `builtin` | `builtin`, `deepl`, `google`, `azure` or `none` |
| `sourceLanguage` | `he` | ISO code of the language titles are written in |
| `azureRegion` | `''` | |
| `autoCopy` | `false` | Copy to the clipboard as soon as the popup opens |

### Algorithm

1. **Prefix:** use the `prefix` override, else the type mapping, else the fallback `prefix`. Strip whitespace, control characters, git-forbidden characters and prohibited characters from it, but don't otherwise reformat it. If it ends in a letter or digit (not `/ _ - .`) and something follows, append the separator.
2. **Key and title:** trim, lowercase according to the settings, then sanitize each into words:
   - First map typographic characters to ASCII: curly quotes → `'` or `"`, en and em dashes → `-`, non-breaking space → space, `…` → `...`.
   - If `asciiOnly`: transliterate (`ß→ss`, `æ→ae`, `ø→o`, `œ→oe`, `đ→d`, `ł→l`, `þ→th`, `ð→d`), apply NFKD normalization, and strip combining marks (`\p{M}`).
   - Whitespace, control characters and the git-forbidden characters `~ ^ : ? * [ \` always become word breaks. With `asciiOnly`, so does any character above U+007E.
   - Prohibited characters become word breaks (`replace`) or vanish (`remove`). **Quote characters (`' " ``) always vanish**, so `user's` becomes `users`, not `user-s`.
   - Join the words with the separator. "Tidy" means: collapse runs of the separator and strip the separator, `.` and `/` from both ends.
3. **Occurrence limits** apply to the whole name, counted in order: prefix, then key, then the joiner between key and title, then the title.
   - Occurrences past a character's limit become the separator. If the limited character *is* the separator, the excess is dropped instead.
   - The joiner is added only if both key and title are non-empty and the separator's own limit allows it.
   - Tidy the key and the title again afterwards.
4. **Length:** the head (prefix + key + joiner) is kept whole. If the head alone reaches `maxLength`, hard-cut it and drop the title. Otherwise cut the title to the remaining budget:
   - If the cut falls mid-word, back up to the previous separator, but only if that keeps at least half the budget; otherwise hard-cut.
   - Never leave a trailing separator, `.` or `/`.
5. **Git rules** (`git check-ref-format --branch`), always enforced last regardless of settings:
   - collapse `//` and `..`
   - replace `@{` with `@`
   - remove leading dots from each `/`-segment and any `.lock` suffix; drop empty segments
   - no leading `-`, `.` or `/`
   - no trailing separator, `.` or `/`
   - the whole name must not be `@`
6. Return `''` if nothing usable remains.

`checkoutCommand(name)` returns `git checkout -b <name>`. It wraps the name in single quotes (escaping `'` as `'\''`) only if the name contains characters outside `[A-Za-z0-9._/@+=,:-]`.

`validateSettings` warns when:
- the separator is prohibited or git-forbidden
- a character is both prohibited and limited (prohibited wins)
- any prefix contains characters that will be stripped
- any prefix has more `/` than the `/` limit allows

## 3. Translation (`src/translate.js`, `src/settings.js`)

Translate when the title contains a letter outside the Latin script: `/(?!\p{Script=Latin})\p{L}/u`. The target is always English. Every failure becomes a `TranslationError` with a `code`: `unsupported`, `needs-download`, `no-key`, `no-permission` or `failed`.

| Provider | How |
|---|---|
| `builtin` (default, private) | The browser's on-device Translator API (`Translator.availability` and `Translator.create({ sourceLanguage, targetLanguage: 'en' })`; Chrome 138+). Feature-detect it with `globalThis.Translator`. If the model isn't downloaded and there's no user activation (`navigator.userActivation.isActive`), throw `needs-download`. Call `destroy()` on the translator when done. Edge doesn't support this yet; say so in the UI. |
| `deepl` | `POST https://api-free.deepl.com/v2/translate` if the key ends in `:fx`, otherwise `https://api.deepl.com/v2/translate`. Header `Authorization: DeepL-Auth-Key <key>`. JSON body `{ text: [title], target_lang: 'EN-US' }`, with the source detected automatically. |
| `google` | `POST https://translation.googleapis.com/language/translate/v2?key=<key>` with body `{ q, target: 'en', format: 'text' }`. |
| `azure` | `POST https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=en`. Headers: `Ocp-Apim-Subscription-Key`, plus `Ocp-Apim-Subscription-Region` only if a region is set. Body `[{ Text }]`. |

- On HTTP errors, include the status and the provider's error message. Add "Check the API key." on 401 and 403.
- Cache translations in `chrome.storage.local`, keyed by `provider|sourceLanguage|title`. Keep the last 300 entries.
- Clear the cache when the provider or source language changes.
- Before calling a cloud provider, check `chrome.permissions.contains`.

## 4. Popup

Layout, from top to bottom:
- a header with a settings gear (`chrome.runtime.openOptionsPage()`)
- a status line, e.g. "Found PROJ-123 (Bug) on this page." or "No Jira issue found on this page. Type a title to generate a name."
- an editable **Issue key** field and a **Type prefix** dropdown (`availablePrefixes`, plus "(no prefix)"), preselected from the detected type, with the type shown next to the label
- an editable **Title** textarea (`unicode-bidi: plaintext` for Hebrew)
- the translation panel
- an editable **Branch** field with a counter `n / maxLength`, highlighted when over the limit
- **Copy branch name** (primary; Enter in the branch field does the same) and **Copy checkout command**
- a feedback line ("Branch name copied to clipboard.")

Behavior:
- Regenerate on every edit to the key, title or prefix.
- If the page can't be scripted (`chrome://`, the Web Store and similar), catch the error and let the user type a title manually.

Translation panel:
- Hidden when translation isn't needed.
- Otherwise it shows "Translating from Hebrew…" (use `Intl.DisplayNames` for the language name) and disables the title field.
- On success, put the English text in the title field, but only if the user hasn't edited it. Show "Translated from Hebrew. Original: …" and a **Use original** / **Use translation** toggle.
- On `needs-download`, explain the one-time download and show a **Download & translate** button; the click provides the user activation the download needs.
- On other errors, show the message and a **Retry** button.

Clipboard:
- Use `navigator.clipboard.writeText`, falling back to a hidden textarea and `document.execCommand('copy')`.
- With `autoCopy`, copy after translation finishes, and only if the title is ready.

## 5. Options page

Group the settings into sections:

- **Issue type prefixes:**
  - a `useTypePrefix` checkbox
  - an editable table of type → prefix, with Add and Remove buttons
  - the fallback prefix field
- **Translation:**
  - a provider select and a source-language select (Hebrew, Arabic, Russian, Ukrainian, Greek, Chinese, Japanese, Korean, Hindi, Thai)
  - *Built-in panel:* the model status (available, downloadable, downloading or unavailable) and a **Download model** button that shows `downloadprogress` as a percentage
  - *Cloud panel:* a password-type API key field and, for Azure only, the region; add a note that titles are sent to the provider
- **Format:** separator, max length, and the key, lowercase and ASCII checkboxes
- **Prohibited characters:**
  - a text input, with each character shown as a chip below it
  - a replace/remove radio, with the note that quotes are always removed and that whitespace and `~ ^ : ? * [ \` are always handled
- **Limited characters:** an editable table of character → max occurrences
- **Popup:** the `autoCopy` checkbox
- **Preview:**
  - sample key, type and title inputs that update the preview live
  - a **Translate sample title** button that uses the current, unsaved provider settings
  - a list of warnings from `validateSettings`, plus form-level warnings: bad separator, a limit row with more than one character, duplicate rows, a type row with no type, a missing API key
- **Footer:** **Restore defaults**; "Unsaved changes" or "Saved" status; **Save**. Save normalizes the values, writes them back into the form, stores the API key locally, and requests the provider's host permission. If the user declines, warn that translation won't work.

## 6. Acceptance tests (`node --test`)

Use the default settings and key `PROJ-123` unless stated otherwise:

| Input | Expected |
|---|---|
| `Add login page` | `PROJ-123-add-login-page` |
| `Fix user's session (SSO & 2FA) - urgent!!` | `PROJ-123-fix-users-session-sso-2fa-urgent` |
| `Don’t crash — ever` | `PROJ-123-dont-crash-ever` |
| `Café crème für Straße` | `PROJ-123-cafe-creme-fur-strasse` |
| `תיקון באג` | `PROJ-123` |
| `תיקון באג`, `asciiOnly: false` | `PROJ-123-תיקון-באג` |
| `Login/logout flow`, prefix `feature/` | `feature/PROJ-123-login-logout-flow` |
| `a/b/c` (no prefix) | `PROJ-123-a/b-c` |
| `Thing`, prefix `feat` | `feat-PROJ-123-thing` |
| `a/b`, `/` limited to 0 | `PROJ-123-a-b` |
| `one two three`, `-` limited to 2 | `PROJ-123-onetwothree` |
| `A&B test`, remove mode / replace mode | `PROJ-123-ab-test` / `PROJ-123-a-b-test` |
| `use_snake_case`, prohibited `_` | `PROJ-123-use-snake-case` |
| `This is a really long title that goes on and on forever`, max 30 | `PROJ-123-this-is-a-really-long` |
| `supercalifragilisticexpialidocious`, max 20 | `PROJ-123-supercalifr` |
| `Add thing`, separator `_` | `PROJ-123_add_thing` |
| key `PROJ-1`, type `Bug`, `Crash on save` | `bugfix/PROJ-1-crash-on-save` |
| key `P-1`, type `Bug`, `Login/logout` | `bugfix/P-1-login-logout` |
| key `P-1`, type `Bug`, prefix override `hotfix/` | `hotfix/P-1-x` (title `x`) |
| empty key and title, or title `!!!` with no key | `''` |

Also test:
- **Git validity:** for every max length from 10 to 49, the result fits and has no trailing `-`, `.` or `/`. For a set of hostile titles (`/leading slash`, `trailing dot.`, `release 1.2..3`, `x.lock`, `-leading dash`, `@`, tabs and newlines, emoji) across several setting combinations, including prohibited `''` with no limits, every non-empty result passes `git check-ref-format --branch` (run it with `child_process.execFileSync`).
- **Type matching:** `SUBTASK` and `sub task` → `task/`; `new-feature` → `feature/`; an unknown type falls back to `prefix`.
- **Translation with a mocked `fetch`:**
  - each provider gets the right URL, headers and body
  - a missing key gives `no-key`
  - a 403 response gives `failed` with "Check the API key."
  - the built-in provider gives `unsupported` without `globalThis.Translator`, translates when a mock reports `available`, and gives `needs-download` when it reports `downloadable`
- **`normalizeSettings`:** repairs a bad separator, a non-numeric length, duplicate prohibited characters, and invalid or duplicate limit and type rows.

## 7. README

Cover:
- loading the extension unpacked in Chrome (`chrome://extensions`) and Edge (`edge://extensions`): Developer mode → Load unpacked
- daily use and the keyboard shortcut
- how the issue is detected
- a provider table with the privacy trade-off of each
- a settings table with defaults
- the git rules that are always enforced
- `npm test`
