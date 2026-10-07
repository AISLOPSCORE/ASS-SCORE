/**
 * Shared deterministic truncation helpers (report-trust fix 2026-10-07).
 *
 * Every customer-facing string that must be cut lands at a WORD boundary (or,
 * for URLs, keeps the identifying tail) so evidence never reads mid-word —
 * the old bare `slice(0, n)` cuts produced "…LinkedIn and ema…" and
 * "…Screenshot_6…)" in the live paid report for publishyoursaas.com.
 *
 * Same input -> identical output, always (pure, no state, no randomness).
 */

/**
 * Word-boundary truncation for receipt snippets, the fix-first action line
 * and the fix-first problem headline (owner defect 2026-10-07: the old bare
 * slice cut mid-token — "…stalled in the midd…"). When the string exceeds n,
 * the cut lands at the last space at or before n (never mid-word), trailing
 * whitespace/punctuation is stripped, and '…' is appended. If the first n
 * chars contain no space at all (one token longer than the limit) the cut is
 * a hard slice — there is no sane boundary to honor — and the result is
 * never the empty string.
 *
 * NOTE: this is the same algorithm that used to live in src/reportHtml.js
 * (which re-exports it below); it moved here so the rules modules
 * (repetitive.js, readableQuotes.js, assets.js) can share ONE implementation
 * instead of each slicing mid-word with their own `slice(0, n)`.
 */
export function short(s, n) {
  const str = String(s);
  const limit = Math.floor(Number(n));
  if (!Number.isFinite(limit) || str.length <= limit) return str;
  if (limit <= 0) return '…';
  const head = str.slice(0, limit);
  let end = head.lastIndexOf(' ');
  if (end <= 0) return `${head}…`;
  while (end > 1 && /[\s.,;:!?…'")\]}-]/.test(head[end - 1])) end -= 1;
  return `${head.slice(0, end)}…`;
}

/**
 * Tail-preserving truncation for URLs (assets rule, 2026-10-07). A URL's
 * identifying part — the filename — sits at the END, so a hard head-slice
 * loses which image is meant ("…screenshots/Screenshot_2…" could be any of
 * three screenshots). When the URL exceeds n chars:
 *
 *   - absolute http(s) URLs: keep the HOST and the filename tail as
 *     "host…/basename" (each side word-truncated with short() only when it
 *     alone exceeds the budget) — the customer sees which host and which file.
 *   - anything else (relative paths, data: etc.): keep the LAST n-1 chars
 *     with a leading '…' — the end of a path is where the filename lives.
 *
 * URLs at or under n chars pass through unchanged.
 */
export function shortUrl(s, n = 70) {
  const str = String(s ?? '');
  const limit = Math.floor(Number(n));
  if (!Number.isFinite(limit) || limit <= 0) return str.length > 0 ? `…${str.slice(-1)}` : str;
  if (str.length <= limit) return str;
  let host = '';
  let basename = '';
  try {
    const u = new URL(str);
    host = u.hostname;
    basename = (u.pathname.split('/').filter(Boolean).pop() ?? '');
  } catch {
    basename = '';
  }
  if (host && basename) {
    const sep = '…/';
    const hostBudget = Math.max(8, Math.floor(limit * 0.5) - sep.length);
    const hostPart = host.length > hostBudget ? short(host, hostBudget) : host;
    const tailBudget = limit - hostPart.length - sep.length;
    const tailPart = basename.length > tailBudget ? short(basename, tailBudget) : basename;
    return `${hostPart}${sep}${tailPart}`;
  }
  // No parseable host+basename: keep the tail — the filename lives at the end.
  return `…${str.slice(-(limit - 1))}`;
}