/**
 * White-label report branding.
 *
 * Agencies can inject their own branding into a scan request while the metric
 * stays the A.S.S. Score. Validation is strict and defensive:
 *   - `branding` must be a plain object (missing/null -> no branding).
 *   - Each field, when present, must be a string of the right shape:
 *       agencyName : non-empty text            (max 120 chars)
 *       logoUrl    : http(s) URL with a host   (max 500 chars)
 *       accentColor: hex color #rgb/#rrggbb/#rrggbbaa (max 9 chars)
 *       footerText : non-empty text            (max 200 chars)
 *   - Unknown keys are ignored; fields that are empty after trim are dropped.
 * Anything else -> { ok: false } -> the API must 400 `invalid_branding`
 * BEFORE the target is scanned.
 *
 * The report renderer only ever receives the normalized object (or null), so
 * injected HTML/JS never survives: every value is HTML-escaped at render time
 * and logoUrl is re-checked to be http(s) there too (defense in depth).
 */

const MAX_AGENCY_NAME = 120;
const MAX_LOGO_URL = 500;
const MAX_FOOTER_TEXT = 200;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** http(s) with a host — same spirit as webhook URL validation. */
export function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return false;
  }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0;
}

/**
 * Validate + normalize a branding object from a scan request.
 *
 * @param {unknown} value - req.body.branding
 * @returns {{ ok: true, branding: null | { agencyName?: string, logoUrl?: string,
 *           accentColor?: string, footerText?: string } } | { ok: false, message: string }}
 */
export function validateBranding(value) {
  if (value === undefined || value === null) return { ok: true, branding: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'branding must be an object' };
  }

  const out = {};
  const fail = (field, why) => ({ ok: false, message: `branding.${field} ${why}` });

  if ('agencyName' in value) {
    if (typeof value.agencyName !== 'string') return fail('agencyName', 'must be a string');
    const v = value.agencyName.trim();
    if (v === '') return fail('agencyName', 'must not be empty');
    if (v.length > MAX_AGENCY_NAME) return fail('agencyName', `must be at most ${MAX_AGENCY_NAME} characters`);
    out.agencyName = v;
  }

  if ('logoUrl' in value) {
    if (typeof value.logoUrl !== 'string') return fail('logoUrl', 'must be a string');
    const v = value.logoUrl.trim();
    if (v === '') return fail('logoUrl', 'must not be empty');
    if (v.length > MAX_LOGO_URL) return fail('logoUrl', `must be at most ${MAX_LOGO_URL} characters`);
    if (!isHttpUrl(v)) return fail('logoUrl', 'must be an http(s) URL with a host');
    out.logoUrl = new URL(v).href;
  }

  if ('accentColor' in value) {
    if (typeof value.accentColor !== 'string') return fail('accentColor', 'must be a string');
    const v = value.accentColor.trim();
    if (!HEX_COLOR.test(v)) return fail('accentColor', 'must be a hex color like #336699');
    out.accentColor = v;
  }

  if ('footerText' in value) {
    if (typeof value.footerText !== 'string') return fail('footerText', 'must be a string');
    const v = value.footerText.trim();
    if (v === '') return fail('footerText', 'must not be empty');
    if (v.length > MAX_FOOTER_TEXT) return fail('footerText', `must be at most ${MAX_FOOTER_TEXT} characters`);
    out.footerText = v;
  }

  if (Object.keys(out).length === 0) return { ok: true, branding: null };
  return { ok: true, branding: out };
}