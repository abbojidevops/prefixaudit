# Deploying PrefixAudit

**Total cost: ₹0.** No domain purchase, no paid hosting, no paid API.

A previous version of this document told you to register `prefixaudit.dev`
first. That was wrong: a domain costs ~$10–12/year, which breaks the
zero-capital constraint the whole project runs on. The build now defaults to
the **free subdomain Cloudflare Pages gives every project**, so you can be
live today without spending anything. Buy a domain later, out of revenue.

---

## 1. Build

```bash
npm run build
```

Writes `dist/` — the single-file auditor plus 27 generated distribution files
(`llms.txt`, `robots.txt`, `sitemap.xml`, `_redirects`, provider and rule pages).

`dist/` is a build artefact and is not committed. Always build before deploying.

## 2. The origin — one place, free by default

Every absolute URL in the build (canonical links, `og:url`, JSON-LD, sitemap,
robots, `_redirects`) is derived from **`scripts/site-config.mjs`**. You do not
edit templates.

The default is:

```
https://prefixaudit.pages.dev
```

That is the subdomain Cloudflare Pages assigns to a project named `prefixaudit`
— free, with unmetered static requests, **500 builds/month**, automatic HTTPS.
No domain required.

### To use a custom domain later

Set one environment variable and rebuild. Nothing else changes:

```bash
PREFIXAUDIT_SITE=https://prefixaudit.dev npm run build
```

`site-config.mjs` normalises the value (strips trailing slashes and paths) and
**throws** on a malformed origin — a build that fails is better than shipping a
canonical that points at a domain you don't own.

> **Switching domains later costs you search ranking.** Every canonical and
> sitemap URL changes at once. Do it early or not at all; don't start on one
> domain and migrate at 10k visitors.

### This is enforced, not just documented

`test/seo.test.mjs` rebuilds with a temporary override and asserts the sitemap,
robots and canonical all follow it, then restores the default build and checks
it is byte-identical. It also fails if **any** origin other than the configured
one and `https://schema.org` (the JSON-LD vocabulary) appears anywhere in
`dist/`. Introduce a hardcoded domain in a template and three tests fail.

## 3. Deploy to Cloudflare Pages

**Dashboard:** Workers & Pages → Create → Pages → Upload assets → drag `dist/`.

**Or CLI:**

```bash
npm i -g wrangler        # free
wrangler login           # free
wrangler pages deploy dist --project-name=prefixaudit
```

The project name **must** be `prefixaudit` for the default origin to be right;
any other name gives you `<name>.pages.dev` and you'll want
`PREFIXAUDIT_SITE=https://<name>.pages.dev npm run build`.

### Why `_redirects` matters

The sitemap advertises extension-less URLs — `/rules/dynamic-timestamp`, not
`/rules/dynamic-timestamp.html`. A bare static host **404s every one of them**,
even though they work locally where you open the `.html` file directly.

`dist/_redirects` maps each canonical URL to its real file with a `200` rewrite,
so the URL stays clean in the browser. It is generated per page rather than with
a splat, because `/rules/* → /rules/:splat.html` also rewrites
`/rules/index.html` into `/rules/index.html.html` and breaks it.

Cloudflare Pages and Netlify both read `_redirects` from the deploy root.
Elsewhere (S3, nginx, GitHub Pages) you need equivalent rewrite rules — GitHub
Pages cannot do extension-less rewrites without a 404.html hack.

> **Unverified:** the `_redirects` syntax is Cloudflare/Netlify standard and the
> file contents are checked for consistency by tests, but the rewrite engine
> itself cannot be exercised in this sandbox. The curl loop below exists to
> catch that in the first five minutes. Run it before announcing anything.

### Verify after deploy

```bash
HOST=https://prefixaudit.pages.dev   # or your custom domain
for u in / /llms.txt /robots.txt /sitemap.xml /_redirects \
         /rules/ /providers/ /rules/dynamic-timestamp /providers/anthropic; do
  printf '%-30s ' "$u"
  curl -s -o /dev/null -w '%{http_code}\n' "$HOST$u"
done
```

Then confirm every sitemap URL actually resolves:

```bash
grep -o '<loc>[^<]*' dist/sitemap.xml | sed 's/<loc>//' | while read u; do
  printf '%-50s ' "$u"
  curl -s -o /dev/null -w '%{http_code}\n' "$u"
done
```

**Every line must be 200.** A 404 here means `_redirects` did not take effect.

---

## 4. Publish to npm

Already configured: `bin`, `files`, `license`, `engines`, `keywords`, and a
`prepublishOnly` hook that runs tests → build → publish check.

```bash
npm login                       # free
npm view prefixaudit            # is the name free?
npm publish --access public
```

If `prefixaudit` is taken: publish as `@yourname/prefix-audit` (scoped, still
`npx @yourname/prefix-audit`), or rename the package but keep
`"bin": { "prefix-audit": ... }` so the command users type does not change.

### What `check-publish.mjs` verifies

`prepublishOnly` runs it automatically; you can also run it directly:

```bash
npm run check-publish
```

It packs the **real tarball**, installs it into a temp directory, and checks:

- the tarball contains exactly the expected files — **no** tests, `dist/`,
  research data or business docs
- the `bin` entry resolves and the CLI actually runs **through a symlink** —
  npm installs bins as symlinks, and an entry-point guard that does not resolve
  them makes the CLI print nothing and exit 0, which in CI means a broken
  prompt silently passes
- a broken prompt exits 1, a clean one exits 0, from the installed package
- `engines.node` matches what the code actually uses
- the version is not already published

This gate is negative-tested: leaking `test/` into `files` trips it, and
reintroducing the symlink bug trips four separate checks.

---

## 5. Post-launch checklist

- [ ] All 9 verification URLs above return **200**
- [ ] Every `<loc>` in the sitemap returns 200 (the `_redirects` test)
- [ ] `https://prefixaudit.pages.dev/llms.txt` is reachable — AI search
      assistants fetch it
- [ ] Submit the sitemap in Google Search Console and Bing Webmaster
- [ ] Run one real audit on the deployed page and confirm the score renders
- [ ] Confirm **no** network requests fire from the page (DevTools → Network).
      The "nothing leaves your browser" claim is structural, but verify once.
- [ ] Repo link present in the footer

### When you have revenue

Then, and only then: buy the domain (~$10/yr), point it at the same Pages
project, rebuild with `PREFIXAUDIT_SITE`, redeploy, and add a 301 from the
`pages.dev` subdomain so existing links and backlinks follow.
