/**
 * Runs inside the Jira tab via chrome.scripting.executeScript, so it must be
 * fully self-contained (no imports, no closures over module scope).
 *
 * Strategy:
 *  1. Find the issue key (URL → page → tab title).
 *  2. Ask Jira's REST API for summary + issue type. This runs in the page's
 *     origin with the user's session, so no extra login or permissions.
 *  3. If that fails, read summary + type from the page (Jira Cloud, Server/DC),
 *     and finally from the tab title ("[KEY-123] Summary - Jira").
 *
 * @returns {Promise<{key: string, title: string, type: string, source: string, url: string}>}
 */
export async function extractJiraIssue() {
  const KEY_RE = /[A-Z][A-Z0-9_]*-\d+/;
  const clean = (text) => (text || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  // First matching selector wins; within it prefer an element inside a modal
  // (an issue opened over a board), then any visible one.
  const pick = (selectors) => {
    for (const selector of selectors) {
      const all = [...document.querySelectorAll(selector)];
      if (!all.length) continue;
      const visible = all.filter(isVisible);
      const pool = visible.length ? visible : all;
      return pool.find((el) => el.closest('[role="dialog"]')) || pool[0];
    }
    return null;
  };

  const url = new URL(location.href);
  let key = '';

  const selected = url.searchParams.get('selectedIssue');
  if (selected && KEY_RE.test(selected)) key = selected.match(KEY_RE)[0];

  const browse = url.pathname.match(/^(.*?)\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/);
  if (!key && browse) key = browse[2].toUpperCase();

  if (!key) {
    const el = pick([
      '[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]',
      '#key-val',
      '#issuekey-val',
    ]);
    const m = clean(el?.textContent).match(KEY_RE);
    if (m) key = m[0];
  }

  const tabTitle = document.title.match(/^\[([A-Za-z][A-Za-z0-9_]*-\d+)\]\s*(.+)$/);
  if (!key && tabTitle) key = tabTitle[1].toUpperCase();

  // --- 1. REST API -------------------------------------------------------
  if (key) {
    // Jira Server can live under a context path such as https://host/jira/.
    const contextPath = browse
      ? browse[1]
      : document.querySelector('meta[name="ajs-context-path"]')?.content || '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(
        `${location.origin}${contextPath}/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,issuetype`,
        { credentials: 'include', headers: { Accept: 'application/json' }, signal: controller.signal },
      );
      if (response.ok) {
        const data = await response.json();
        const title = clean(data?.fields?.summary);
        if (title) {
          return {
            key: data.key || key,
            title,
            type: clean(data.fields.issuetype?.name),
            source: 'api',
            url: location.href,
          };
        }
      }
    } catch {
      // Not Jira, blocked, or timed out — fall through to the page.
    } finally {
      clearTimeout(timer);
    }
  }

  // --- 2. Page -----------------------------------------------------------
  const titleEl = pick([
    '[data-testid="issue.views.issue-base.foundation.summary.heading"]',
    '[data-test-id="issue.views.issue-base.foundation.summary.heading"]',
    '[data-testid*="summary.heading"]',
    '#summary-val',
    '#issue-content h1',
  ]);
  let title = clean(titleEl?.textContent);

  let type = '';
  const typeButton = pick([
    '[data-testid="issue.views.issue-base.foundation.change-issue-type.button"]',
    '[data-testid*="change-issue-type"]',
  ]);
  if (typeButton) {
    type = clean(typeButton.querySelector('img')?.alt) || clean(typeButton.getAttribute('aria-label')).split(' - ')[0];
  }
  if (!type) {
    const serverType = pick(['#type-val']);
    type = clean(serverType?.textContent) || clean(serverType?.querySelector('img')?.alt);
  }

  // --- 3. Tab title ------------------------------------------------------
  if (!title && tabTitle) title = tabTitle[2].replace(/\s+-\s+[^-]*jira[^-]*$/i, '').trim();

  return { key, title, type, source: 'page', url: location.href };
}
