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
 * @returns {{ title: string, text: string, paragraphs: string[], sentences: string[], words: string[] }}
 */
export function extractText(html) {
  const $ = cheerio.load(String(html), { decodeEntities: true });
  $(NON_TEXT_TAGS).remove();

  const title = $('title').first().text().replace(/\s+/g, ' ').trim();

  const bodyEl = $('body');
  const raw = (bodyEl.length > 0 ? bodyEl : $('html')).text();
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
    sentences: splitSentences(text),
    words: tokenize(text),
    stopwords: STOPWORDS,
  };
}

export { STOPWORDS };