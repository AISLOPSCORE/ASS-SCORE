/**
 * Webhook endpoint registration for the full-Stripe flow.
 *
 * Run MANUALLY by the lead at deploy (never at boot): the app only needs it
 * once per environment, and the signing secret it prints must be stored as
 * STRIPE_WEBHOOK_SECRET — a boot-time call could not do anything with it.
 *
 * What it does, given a secret key + the base URL the backend answers on:
 *   1. Lists existing webhook endpoints (limit 100).
 *   2. If one already points at <REPORT_BASE_URL || PUBLIC_BASE_URL ||
 *      'https://ass-score-production.up.railway.app'>/api/v1/webhook, it is
 *      reused (idempotent) and the function reports that — the signing secret
 *      was only visible at creation, so ops must already have it in
 *      STRIPE_WEBHOOK_SECRET (nothing is printed for the existing endpoint).
 *   3. Otherwise it creates one for that URL with
 *      enabled_events ['checkout.session.completed'] and PRINTS the returned
 *      signing secret (whsec_...) — that exact value goes into
 *      STRIPE_WEBHOOK_SECRET so the existing /api/v1/webhook route starts
 *      verifying Stripe-Signature headers (it already handles
 *      checkout.session.completed, correlates by client_reference_id, and is
 *      idempotent — backend-created Checkout Sessions carry client_reference_id
 *      and no metadata.target_url, so they flow through the payment-link
 *      branch of the webhook route, which is FINE and by design).
 *
 * CLI:  node src/registerWebhook.js [--base-url <url>]
 * Reads STRIPE_SECRET_KEY (or STRIPE_TEST_SECRET_KEY) from the environment.
 * Exits 0 on success / reused, 1 on any failure (prints the cause).
 */
import { pathToFileURL } from 'node:url';
import { createStripeClient, StripeAuthError, StripeUnavailableError } from './stripeClient.js';

export const DEFAULT_WEBHOOK_BASE = 'https://ass-score-production.up.railway.app';

/**
 * Ensure a Stripe webhook endpoint exists for the backend's /api/v1/webhook.
 * @param {object} opts
 * @param {string} [opts.apiKey]   secret key (defaults to STRIPE_SECRET_KEY)
 * @param {string} [opts.baseUrl]  backend origin; defaults to
 *   REPORT_BASE_URL || PUBLIC_BASE_URL || DEFAULT_WEBHOOK_BASE
 * @returns {Promise<{ created: boolean, webhookUrl: string,
 *   secret: string|null }>} secret is only ever non-null for a NEWLY created
 *   endpoint (Stripe reveals it once, at creation).
 */
export async function ensureWebhookEndpoint({
  apiKey = process.env.STRIPE_SECRET_KEY,
  baseUrl,
  stripe,
} = {}) {
  const key = String(apiKey ?? '').trim() || String(process.env.STRIPE_TEST_SECRET_KEY ?? '').trim();
  if (!key) {
    const err = new Error('STRIPE_SECRET_KEY is not set — cannot register the webhook endpoint');
    err.code = 'config_missing';
    throw err;
  }
  const webhookBase = (
    baseUrl ??
    process.env.REPORT_BASE_URL ??
    process.env.PUBLIC_BASE_URL ??
    DEFAULT_WEBHOOK_BASE
  ).replace(/\/+$/, '');
  const webhookUrl = `${webhookBase}/api/v1/webhook`;
  const stripeImpl = stripe ?? createStripeClient({ apiKey: key });
  let existing;
  try {
    existing = await stripeImpl.listWebhookEndpoints(100);
  } catch (err) {
    if (err instanceof StripeAuthError) throw new Error(`Could not list webhook endpoints: ${err.message}`);
    if (err instanceof StripeUnavailableError) throw new Error(`Could not list webhook endpoints (Stripe unavailable): ${err.message}`);
    throw new Error(`Could not list webhook endpoints: ${err.message ?? String(err)}`);
  }
  const data = Array.isArray(existing?.data) ? existing.data : [];
  const match = data.find((e) => (e?.url ?? '').replace(/\/+$/, '') === webhookUrl);
  if (match) {
    return { created: false, webhookUrl, secret: null, endpointId: match.id };
  }
  let created;
  try {
    created = await stripeImpl.createWebhookEndpoint({
      url: webhookUrl,
      enabled_events: ['checkout.session.completed'],
    });
  } catch (err) {
    if (err instanceof StripeAuthError) throw new Error(`Could not create webhook endpoint: ${err.message}`);
    if (err instanceof StripeUnavailableError) throw new Error(`Could not create webhook endpoint (Stripe unavailable): ${err.message}`);
    throw new Error(`Could not create webhook endpoint: ${err.message ?? String(err)}`);
  }
  return { created: true, webhookUrl, secret: created?.secret ?? null, endpointId: created?.id };
}

/** Manual CLI (see the header comment). */
async function main() {
  const args = process.argv.slice(2);
  const baseArg = args.find((a) => a.startsWith('--base-url='));
  const baseUrl = baseArg ? baseArg.split('=').slice(1).join('=') : undefined;
  const result = await ensureWebhookEndpoint({ baseUrl });
  if (result.created) {
    console.log(`[registerWebhook] created endpoint ${result.endpointId} for ${result.webhookUrl}`);
    if (result.secret) {
      console.log(`[registerWebhook] SET THIS AS STRIPE_WEBHOOK_SECRET on Railway -> ${result.secret}`);
    } else {
      console.log('[registerWebhook] WARNING: Stripe did not return a signing secret for the new endpoint');
    }
  } else {
    console.log(`[registerWebhook] endpoint already exists (${result.endpointId}) for ${result.webhookUrl}`);
    console.log('[registerWebhook] signing secret was shown at creation — STRIPE_WEBHOOK_SECRET must already hold it');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[registerWebhook] FAILED: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}