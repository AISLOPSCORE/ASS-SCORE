import * as cheerio from 'cheerio';

/**
 * Deterministic HTML -> text extraction. Everything here is pure and
 * ordered: same HTML in, same text/sentences/words out.
 */

// Compact English stopword list (function words — low information content).
const STOPWORDS = new Set(
  ('a,about,above,after,again,against,all,am,an,and,any,are,as,at,be,because,been,before,being,' +
   'below,between,both,but,by,can,could,did,do,does,doing,down,during,each,few,for,from,further,' +
   'had,has,have,having,he,her,here,hers,herself,him,himself,his,how,i,if,in,into,is,it,its,itself,' +
   'just,me,more,most,my,myself,no,nor,not,now,of,off,on,once,only,or,other,our,ours,ourselves,out,' +
   'over,own,same,she,should,so,some,such,than,that,the,their,theirs,them,themselves,then,there,' +
   'these,they,this,those,through,to,too,under,until,up,very,was,we,were,what,when,where,which,' +
   'while,who,whom,why,will,with,would,you,your,yours,yourself,yourselves').split(',')
);

const NON_TEXT_TAGS = 'script, style, noscript, template, svg, canvas, iframe, object, embed, textarea, select, option';
const PARA_TAGS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption';

const WORD_RE = /[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)?|[\p{L}\p{N}]+/gu;

/** Tokenize a string into lowercase words. */
export function tokenize(str) {
  const out = [];
  for (const m of String(str).matchAll(WORD_RE)) out.push(m[0].toLowerCase());
  return out;
}

/** Split text into sentences on sentence-ending punctuation followed by whitespace/end. */
export function splitSentences(str) {
  const normalized = String(str).replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const parts = normalized.split(/(?<=[.!?…])\s+/);
  return parts.map((p) => p.trim()).filter((p) => p.length >= 2);
}

/**
 * Extract readable text content from raw HTML.
 *
 * SENTENCE CORPUS (report-trust fix 2026-10-07 — owner defect: "the 60-word
 * average sentence length is unrealistic…"): `sentences` is derived from the
 * BOUNDARY-SPACED rendering of the same body (joinWithBoundarySpaces), so a
 * period at the end of one element followed by the next element's text
 * actually splits. cheerio's `.text()` glues adjacent elements with NO
 * separator ("…lead research, LinkedIn and email" + <span>Screenshot 2…</span>
 * extracts as "…emailScreenshot 2…"), which made splitSentences treat a whole
 * directory listing as ONE fake 60-word run-on. Everything else — `title`,
 * `text`, `words`, `paragraphs` — stays on the glued corpus so the
 * word-based metrics (MATTR, stopword ratio, TTR, short-paragraph %) are
 * byte-identical to before; only the sentence boundaries (and therefore the
 * honest sentence counts) changed.
 *
 * @returns {{ title: string, text: string, paragraphs: string[], sentences: string[], words: string[] }}
 */
export function extractText(html) {
  const $ = cheerio.load(String(html), { decodeEntities: true });
  $(NON_TEXT_TAGS).remove();

  const title = $('title').first().text().replace(/\s+/g, ' ').trim();

  const bodyEl = $('body');
  const root = bodyEl.length > 0 ? bodyEl : $('html');
  const raw = root.text();
  const text = raw.replace(/\s+/g, ' ').trim();

  const paragraphs = [];
  $(PARA_TAGS).each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t.length > 0) paragraphs.push(t);
  });

  return {
    title,
    text,
    paragraphs,
    sentences: splitSentences(joinWithBoundarySpaces($, root[0])),
    words: tokenize(text),
    stopwords: STOPWORDS,
  };
}

/**
 * Boundary-spaced extraction for QUOTE/EVIDENCE strings ONLY (owner-approved
 * Option B, 2026-10-07 — see /home/team/shared/text-extraction-bug/
 * investigation.md §6-7). cheerio's `.text()` concatenates adjacent elements
 * with NO separator, so `<button>Advertise now</button><span>$29.99 · 30</span>`
 * (JSX/minified production HTML) extracts as "Advertise now$29.99 · 30" — fine
 * for token analysis, garbage when quoted to a customer. This variant inserts
 * ONE space between adjacent element siblings that lack a whitespace text node
 * between them, so quote/evidence strings read like the page ("Advertise now
 * $29.99 · 30"). It NEVER feeds any score: the analysis corpus
 * (extractText/extractMainText) stays byte-identical so all scoring math,
 * weights, C1/C2, phrase detection and the QA anchors are untouched.
 *
 * Same shape as extractText's text/sentences/paragraphs (title excluded — the
 * <title> is a single text node and never suffers the concat defect; callers
 * that quote the title use the analysis corpus).
 *
 * @returns {{ text: string, sentences: string[], paragraphs: string[] }}
 */
export function extractReadableText(html) {
  const $ = cheerio.load(String(html), { decodeEntities: true });
  $(NON_TEXT_TAGS).remove();

  const bodyEl = $('body');
  const raw = joinWithBoundarySpaces($, (bodyEl.length > 0 ? bodyEl : $('html'))[0]);
  const text = raw.replace(/\s+/g, ' ').trim();

  const paragraphs = [];
  $(PARA_TAGS).each((_, el) => {
    const t = joinWithBoundarySpaces($, el).replace(/\s+/g, ' ').trim();
    if (t.length > 0) paragraphs.push(t);
  });

  return { text, sentences: splitSentences(text), paragraphs };
}

/**
 * Depth-first walk of an element that inserts ONE space between adjacent ELEMENT
 * siblings that have no whitespace text node between them (the Option A join
 * from investigation.md — measured to make quote sentences read like the page).
 * Text-node content is emitted verbatim; element boundaries with a text node
 * in between keep their own (possibly empty) whitespace.
 */
function joinWithBoundarySpaces($, node) {
  let out = '';
  (function walk(n) {
    if (n.type === 'text') { out += n.data ?? ''; return; }
    if (n.type !== 'tag') return;
    let prevWasElement = false;
    for (const child of n.children ?? []) {
      const isEl = child.type === 'tag';
      if (isEl && prevWasElement) out += ' ';
      walk(child);
      prevWasElement = isEl;
    }
  })(node);
  return out;
}

/**
 * Extract the raw inner HTML of <head> (deterministic string). Used by the
 * fingerprints rule for head-scoped patterns (e.g. meta generator tags).
 */
export function extractHead(html) {
  const $ = cheerio.load(String(html));
  const head = $('head');
  return head.length > 0 ? (head.html() || '') : '';
}

/**
 * Main-content extraction for cross-page similarity. Similarity must compare
 * MAIN CONTENT only so a shared nav/header/footer never inflates it.
 *
 * Strategy (deterministic, documented):
 *   1. Prefer <main>, then <article> — content scoped strictly to that subtree.
 *   2. Fallback: <body> minus <nav>, <header>, <footer>, <aside>, <form>.
 *   3. Last resort: whole <html>.
 *
 * SENTENCE CORPUS (report-trust fix 2026-10-07): like extractText, `sentences`
 * is derived from the BOUNDARY-SPACED rendering of the SAME selection
 * (joinWithBoundarySpaces), so punctuation at an element boundary actually
 * splits and sentence counts are honest. `text`, `paragraphs` and `words`
 * stay on the glued `.text()` corpus — cross-page similarity (word 4-grams),
 * MATTR, TTR and stopword ratios are byte-identical to before.
 *
 * @returns {{ text: string, words: string[], paragraphs: string[], sentences: string[], stopwords: Set<string> }}
 */
export function extractMainText(html) {
  const $ = cheerio.load(String(html), { decodeEntities: true });
  $(NON_TEXT_TAGS).remove();

  let sel = $('main').first();
  if (sel.length === 0) sel = $('article').first();
  if (sel.length === 0) {
    // Fallback: body minus chrome elements.
    $('nav, header, footer, aside, form').remove();
    sel = $('body');
    if (sel.length === 0) sel = $('html');
  }

  const raw = sel.text();
  const text = raw.replace(/\s+/g, ' ').trim();

  const paragraphs = [];
  const paraSel = sel.find(PARA_TAGS);
  if (paraSel.length > 0) {
    paraSel.each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t.length > 0) paragraphs.push(t);
    });
  } else if (sel.is(PARA_TAGS)) {
    const t = $(sel).text().replace(/\s+/g, ' ').trim();
    if (t.length > 0) paragraphs.push(t);
  }

  return {
    text,
    paragraphs,
    sentences: splitSentences(joinWithBoundarySpaces($, sel[0])),
    words: tokenize(text),
    stopwords: STOPWORDS,
  };
}

export { STOPWORDS };