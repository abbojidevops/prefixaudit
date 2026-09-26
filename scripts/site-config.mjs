/**
 * site-config.mjs — the ONE place the deployed origin lives.
 *
 * Everything that emits an absolute URL (canonical links, sitemap, robots,
 * _redirects, og:url, JSON-LD, npm homepage) reads from here. Changing the
 * origin is one edit or one env var; nothing else needs to know.
 *
 *   PREFIXAUDIT_SITE=https://prefixaudit.dev npm run build
 *
 * DEFAULT IS THE FREE SUBDOMAIN, ON PURPOSE.
 * A custom domain costs money. Cloudflare Pages hands every project a
 * `*.pages.dev` subdomain with unmetered static requests, so the default
 * origin is one that works at ₹0 the moment you deploy. Upgrade to a custom
 * domain later, out of revenue, by setting PREFIXAUDIT_SITE — not before.
 */

const ENV_KEY = 'PREFIXAUDIT_SITE';

/** Free subdomain for `wrangler pages deploy --project-name prefixaudit`. */
export const FREE_ORIGIN = 'https://prefixaudit.pages.dev';

/**
 * Resolve the origin: env override, else the free subdomain.
 *
 * Normalised so callers can concatenate `${SITE}/path` safely: no trailing
 * slash, http/https required. Throws rather than silently emitting a broken
 * canonical — a wrong origin in a sitemap is worse than a failed build.
 */
export function siteOrigin() {
  const raw = (process.env[ENV_KEY] || FREE_ORIGIN).trim();

  if (!raw) throw new Error(`${ENV_KEY} is set but empty`);

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${ENV_KEY}="${raw}" is not a valid absolute URL (need https://…)`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${ENV_KEY} must start with https:// (got "${url.protocol}")`);
  }
  if (url.username || url.password) {
    throw new Error(`${ENV_KEY} must not contain credentials`);
  }

  // Drop any trailing slash and path so `${SITE}/x` never doubles up.
  return url.origin;
}

export const SITE = siteOrigin();

/** True when building for the free subdomain rather than a custom domain. */
export const isFreeSubdomain = SITE === FREE_ORIGIN;
