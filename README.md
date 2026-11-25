# Jira Branch Name

A Chrome / Microsoft Edge extension (Manifest V3) that reads the Jira issue you're looking at and turns it into a git branch name you can copy straight into `git checkout -b`.

```
Bug    PROJ-1234  "Fix login/logout redirect when user's session expires"
   → bugfix/PROJ-1234-fix-login-logout-redirect-when-users        (max length 60)

Story  PROJ-88    "הוספת מצב כהה להגדרות"   (translated: "Add dark mode to settings")
   → feature/PROJ-88-add-dark-mode-to-settings
```

## Install (unpacked)

**Chrome:** open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose this folder.
**Edge:** open `edge://extensions`, turn on **Developer mode**, click **Load unpacked** and choose this folder.

Pin the extension to the toolbar. Then open any Jira issue and click the icon (or press **Alt+Shift+B**).

## Using it

The popup shows the detected issue key, type and title, plus the generated branch name with a character counter.

- The **type prefix** (`bugfix/`, `feature/`, …) is chosen from the issue type. You can pick a different one from the dropdown.
- A title in Hebrew (or any non-Latin script) is **translated to English** first. The original stays visible, and **Use original** switches back to it.
- **Copy branch name** copies just the name. Pressing Enter in the branch field does the same.
- **Copy checkout command** copies `git checkout -b <name>`.
- You can edit the key, the title, or the final name before you copy.
- If the page isn't a Jira issue, type a title yourself and the name is generated from that.

Supported pages: Jira Cloud issue pages (`/browse/KEY-1`), boards and backlogs with an issue open (`?selectedIssue=KEY-1`), and Jira Server / Data Center.

The extension first asks Jira's REST API (`/rest/api/2/issue/KEY`) for the summary and issue type. The request runs inside the Jira tab with your existing login. If the API fails, it reads them from the page, and as a last resort from the tab title (`[KEY-1] Summary - Jira`).

The extension needs no host permissions to read Jira. It reads a page only when you click the icon (`activeTab`), so it works on any Jira domain, including self-hosted ones.

## Translation

Titles that contain non-Latin letters are translated to English. Choose the provider in settings:

| Provider | Privacy | Setup |
|---|---|---|
| **Browser built-in** (default) | On-device. Titles never leave your machine. | Chrome 138+. Click **Download model** once in settings. Not available in Edge yet. |
| DeepL API | Titles are sent to DeepL | API key (free keys end in `:fx`) |
| Google Cloud Translation | Titles are sent to Google | API key |
| Azure Translator | Titles are sent to Microsoft | Key, plus region for regional resources. The natural choice for Edge. |

API keys are kept in `chrome.storage.local` (never synced). Cloud providers are optional host permissions: the browser asks for access only when you select one and save. Translations are cached locally, so reopening the same issue costs nothing.

Use **Translate sample title** in settings to try the current provider.

## Settings

Right-click the icon and choose **Options**, or use the gear in the popup. The settings page shows a live preview as you change things.

| Setting | Default | Notes |
|---|---|---|
| Issue type prefixes | Bug → `bugfix/`, Story / New Feature → `feature/`, Improvement → `improvement/`, Task / Sub-task → `task/`, Epic → `epic/`, Spike → `spike/` | Editable table. Matching ignores case, spaces and dashes. Add localized type names (e.g. `באג`) if your Jira uses them. |
| Prefix for other types | *(empty)* | Used for unknown or unmapped types. A separator is added if a prefix ends in a letter. |
| Translate with / Titles are written in | Built-in / Hebrew | See [Translation](#translation). |
| Separator | `-` | Placed between words. |
| Maximum length | `60` | Covers the whole name. The title is cut at a word boundary; the prefix and key are never cut unless they alone are too long. |
| Include / lowercase issue key | on / off | |
| Lowercase title | on | |
| ASCII only | on | `é → e`, `ß → ss`. Other non-Latin characters are dropped. |
| Prohibited characters | `` !"#$%&'()*+,.;<=>?@[\]^`{\|}~: `` | Each one is either **replaced** with the separator or **removed**. Quotes are always removed (`user's → users`). |
| Limited characters | `/` × 1 | Allowed, but only N times in the whole name, prefix included. Occurrences after the limit become the separator. With no prefix, the first `/` in a title is kept; set the limit to 0 if you never want one. |
| Auto-copy on open | off | Copies the name as soon as the popup opens. |

Settings are saved in `chrome.storage.sync`, so they follow you to any browser where you're signed in.

Whatever the settings, the result is always a valid git branch name (`git check-ref-format --branch`):

- whitespace, control characters and `~ ^ : ? * [ \` are always removed
- no `..`, `//` or `@{`
- no part of the name starts with `.` or ends with `.lock`
- the name never starts with `-` and never ends with `.` or `/`

## Development

```sh
npm test          # unit tests for the generator (Node 18+; validates output with real git)
npm run icons     # regenerate icons/*.png (plain Python 3, no dependencies)
npm run package   # zip for the Chrome Web Store / Edge Add-ons → dist/
```

```
manifest.json
src/branch-name.js    pure generator, type→prefix, settings normalisation (unit tested)
src/translate.js      translation providers (unit tested with a mocked fetch)
src/jira-extract.js   runs in the Jira tab: REST API, then page, then tab title
src/settings.js       chrome.storage wrapper, API key, translation cache
popup/                toolbar popup
options/              settings page with live preview
```
