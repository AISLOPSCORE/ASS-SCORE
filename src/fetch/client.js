import { validateUrl, resolveAndCheck } from './ssrf.js';

const CONNECT_TIMEOUT_MS = 10_000; // hard connect + read timeout
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB response body cap
const MAX_REDIRECTS = 3; // max redirect hops, each hop re-validated against SSRF rules
const USER_AGENT = 'A.S.S.Score/0.1 (deterministic rule-based scanner)';

export class FetchError extends Error {
  constructor(message) { super(message); this.name = 'FetchError'; }
}
export class BodyTooLargeError extends FetchError {
  constructor(message) { super(message); this.name = 'BodyTooLargeError'; }
}
export class TooManyRedirectsError extends FetchError {
  constructor(message) { super(message); this.name = 'TooManyRedirectsError'; }
}

/**
 * Fetch an HTML page with SSRF-safe redirect handling.
 * Every hop (initial URL + each redirect) is passed through validateUrl()
 * and resolveAndCheck() before the actual request is made, so a redirect can
 * never land us on a private/loopback/link-local address.
 */
export class Fetcher {
  constructor({
    timeoutMs = CONNECT_TIMEOUT_MS,
    maxBodyBytes = MAX_BODY_BYTES,
    maxRedirects = MAX_REDIRECTS,
    userAgent = USER_AGENT,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxBodyBytes = maxBodyBytes;
    this.maxRedirects = maxRedirects;
    this.userAgent = userAgent;
    this.fetchImpl = fetchImpl;
  }

  async fetchHtml(rawUrl, { signal } = {}) {
    let url = validateUrl(rawUrl);
    await resolveAndCheck(url);
    let hopCount = 0;

    for (;;) {
      if (signal?.aborted) {
        throw new FetchError('Request aborted before it started (scan budget expired)');
      }
      const ctrl = new AbortController();
      const onExternalAbort = () => ctrl.abort();
      if (signal) signal.addEventListener('abort', onExternalAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);

      let response;
      try {
        response = await this.fetchImpl(url.href, {
          redirect: 'manual', // we follow redirects ourselves so every hop is re-validated
          signal: ctrl.signal,
          headers: {
            'user-agent': this.userAgent,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1',
          },
        });
      } catch (err) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onExternalAbort);
        if (signal?.aborted) {
          throw new FetchError('Request aborted (scan budget expired)');
        }
        if (ctrl.signal.aborted || err?.name === 'AbortError') {
          throw new FetchError(`Request to ${url.hostname} timed out after ${this.timeoutMs}ms`);
        }
        throw new FetchError(`Network error fetching ${url.href}: ${err.message}`);
      }

      const status = response.status;

      // Redirect hop: cancel the body, re-validate the Location target, repeat.
      if (status >= 300 && status < 400) {
        await response.body?.cancel?.().catch(() => {});
        clearTimeout(timer);
        signal?.removeEventListener('abort', onExternalAbort);
        const location = response.headers.get('location');
        if (!location) throw new FetchError(`Redirect response from ${url.href} had no Location header`);
        if (++hopCount > this.maxRedirects) {
          throw new TooManyRedirectsError(`Too many redirects (max ${this.maxRedirects}) from ${rawUrl}`);
        }
        url = validateUrl(new URL(location, url).href);
        await resolveAndCheck(url);
        continue;
      }

      // Enforce the body-size cap: cheap Content-Length check first, streaming
      // check below for chunked/unknown-length bodies.
      const declaredLength = Number(response.headers.get('content-length') ?? 0);
      if (declaredLength > this.maxBodyBytes) {
        await response.body?.cancel?.().catch(() => {});
        clearTimeout(timer);
        signal?.removeEventListener('abort', onExternalAbort);
        throw new BodyTooLargeError(`Response from ${url.hostname} exceeds the ${this.maxBodyBytes}-byte cap`);
      }

      let body = '';
      try {
        const reader = response.body?.getReader?.();
        if (reader) {
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (signal?.aborted) {
              throw new FetchError('Request aborted (scan budget expired)');
            }
            if (ctrl.signal.aborted) {
              throw new FetchError(`Request to ${url.hostname} timed out after ${this.timeoutMs}ms`);
            }
            if (Buffer.byteLength(body, 'utf8') + value.byteLength > this.maxBodyBytes) {
              throw new BodyTooLargeError(`Response from ${url.hostname} exceeds the ${this.maxBodyBytes}-byte cap`);
            }
            body += decoder.decode(value, { stream: true });
          }
          body += decoder.decode();
        } else {
          body = await response.text();
          if (Buffer.byteLength(body, 'utf8') > this.maxBodyBytes) {
            throw new BodyTooLargeError(`Response from ${url.hostname} exceeds the ${this.maxBodyBytes}-byte cap`);
          }
        }
      } catch (err) {
        if (signal?.aborted) {
          throw new FetchError('Request aborted (scan budget expired)');
        }
        if (ctrl.signal.aborted || err?.name === 'AbortError') {
          throw new FetchError(`Request to ${url.hostname} timed out after ${this.timeoutMs}ms`);
        }
        if (err instanceof FetchError) throw err;
        throw new FetchError(`Network error reading response from ${url.hostname}: ${err.message}`);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onExternalAbort);
      }

      return { status, url: url.href, body };
    }
  }
}