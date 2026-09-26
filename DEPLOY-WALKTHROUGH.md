# Deploy walkthrough — click by click

You have two files ready in `prefixaudit/`:

- **`dist/`** — the built site: 28 files, all at the top level, **no folders**
- **`prefixaudit-dist.zip`** — the same thing zipped (95 KB)

Neither needs a credit card. Pick **one** path below.

---

## Which host?

| | **Cloudflare Pages** ← recommended | Netlify | GitHub Pages |
|---|---|---|---|
| Cost | ₹0 | ₹0 | ₹0 |
| Bandwidth | **unmetered** | 100 GB/mo | 100 GB/mo |
| Reads `_redirects` | ✅ | ✅ | ❌ |
| Works as built | ✅ | needs one rebuild | ❌ broken URLs |

**Use Cloudflare Pages.** The build already defaults to
`https://prefixaudit.pages.dev`, so nothing has to change.

**Do not use GitHub Pages** — it cannot do extension-less rewrites, so
`/rules/dynamic-timestamp` and 17 other URLs in your sitemap would 404.

---

## Path A — Cloudflare Pages in the browser (no terminal)

### A1. Make an account

1. Go to **https://dash.cloudflare.com/sign-up**
2. Email + password. **No card is asked for.**
3. Click the link in the verification email.

### A2. Create the project

4. In the left sidebar click **Compute (Workers)** → **Workers & Pages**
5. Click the blue **Create** button (top right)
6. Click the **Pages** tab, then **Upload assets**
7. **Project name: type `prefixaudit`**

> ⚠️ This name *is* your URL. `prefixaudit` → `prefixaudit.pages.dev`.
> The build's canonical links already say `prefixaudit.pages.dev`, so any other
> name makes your SEO metadata point at the wrong place. If `prefixaudit` is
> taken, stop and see **A5** before uploading.

### A3. Upload

8. A drag-and-drop box appears. Open your `prefixaudit/dist/` folder.
9. **Select all 28 files in `dist/`** and drag them in.

> There are **no folders**. The site is stored *flat* on purpose — every file
> has a unique name (`index.html`, `_redirects`, `rules.html`,
> `provider-anthropic.html`, `rule-dynamic-timestamp.html`, …). That means it
> does not matter how you select, drag, unzip or commit them: nothing can be
> lost, renamed or mangled. Just make sure `_redirects` is among the files.

10. Click **Deploy site**

### A4. You're live

You'll get `https://prefixaudit.pages.dev`. Skip to **Verify** below.

### A5. If the name `prefixaudit` is taken

Don't upload yet. On your own computer:

```bash
cd prefixaudit
PREFIXAUDIT_SITE=https://YOURNAME.pages.dev npm run build
```

Then upload with project name `YOURNAME`.

---

## Path B — Cloudflare Pages from the terminal

Better if you'll redeploy often. Needs Node 18+ (you have 20).

```bash
npm install -g wrangler
```

If that fails with a permissions error, either prefix with `sudo` or run:

```bash
npm config set prefix ~/.npm-global
export PATH=~/.npm-global/bin:$PATH
npm install -g wrangler
```

Then:

```bash
cd prefixaudit
npm run build                                    # writes dist/
wrangler login                                   # opens a browser — approve it
wrangler pages deploy dist --project-name=prefixaudit
```

First run asks you to create the project; press Enter to accept. When it
finishes it prints the URL.

Redeploying later is just those last two lines — no login needed again.

---

## Path C — Netlify (easiest, if you want zero terminal)

1. **https://app.netlify.com/signup** — email or GitHub, no card
2. Go to **https://app.netlify.com/drop**
3. Drag **`prefixaudit-dist.zip`** onto the box. That's the whole deploy.
4. You get something like `https://random-words-12345.netlify.app`
5. **Site configuration → Change site name** → set it to `prefixaudit`
   (if free) so the URL becomes `https://prefixaudit.netlify.app`

**Then you must rebuild**, because the canonical links still say
`pages.dev`:

```bash
cd prefixaudit
PREFIXAUDIT_SITE=https://prefixaudit.netlify.app npm run build
cd dist && zip -qr ../prefixaudit-dist.zip . && cd ..
```

Re-drag the new zip. Netlify reads `_redirects` the same way Cloudflare does,
so the clean URLs work.

---

## Path D — Connect GitHub (most robust; auto-redeploys on push)

Use this if the drag-and-drop boxes keep flattening your folders. Cloudflare
reads the real files from git, so structure is guaranteed, and it gives you a
`.pages.dev` URL that honours `_redirects`.

### Put the site on GitHub

1. **github.com** → sign in (or sign up).
2. Top-right **＋** → **New repository**.
3. Name it **`prefixaudit`**, keep it **Public**, do **not** tick "Add a README".
   Click **Create repository**.
4. On the empty-repo screen click **uploading an existing file**.
5. Unzip `prefixaudit-dist.zip` and drag **all 28 files** onto the upload box.
   They're flat and uniquely named, so selection order and structure don't matter.
6. Click **Commit changes**.

   **CHECK:** the repo file list should show ~28 flat files including
   `index.html`, `_redirects`, `rules.html`, `provider-anthropic.html` and
   `rule-dynamic-timestamp.html` — and **no** `index (1).html`.

### Point Cloudflare at the repo

7. **dash.cloudflare.com** → **Compute (Workers)** → **Workers & Pages** → **Create**.
8. This time choose **Import a repository** / **Connect to Git** (not Upload).
9. Authorize GitHub and select **`prefixaudit`**.
10. Build settings — set exactly:

    | Field | Value |
    |---|---|
    | Framework preset | **None** |
    | Build command | *(leave blank)* |
    | Output directory | `/` |

11. **Save and Deploy.** URL: `https://prefixaudit.pages.dev`.

Because it's connected to git, any future `git push` rebuilds and redeploys
automatically — no more dragging.

---

## Verify — do this before telling anyone

Replace `H` with your actual URL:

```bash
H=https://prefixaudit.pages.dev
for u in / /llms.txt /robots.txt /sitemap.xml /_redirects \
         /rules/ /providers/ /rules/dynamic-timestamp /providers/anthropic; do
  printf '%-28s ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' "$H$u"
done
```

**Every line must say `200`.** Then check all 21 sitemap URLs at once:

```bash
grep -o '<loc>[^<]*' dist/sitemap.xml | sed 's/<loc>//' | while read u; do
  printf '%-52s ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' "$u"
done
```

Then open the site in a browser and confirm:

- [ ] The auditor runs — paste a prompt, a score appears
- [ ] **DevTools → Network shows no requests leaving the page.** This is the
      "nothing leaves your browser" claim; verify it once with your own eyes.
- [ ] `/rules/dynamic-timestamp` loads and the URL stays clean (no `.html`)

---

## If something breaks

| Symptom | Cause | Fix |
|---|---|---|
| Blank page at `/` | You dragged the `dist` folder, not its contents | Redeploy with the contents |
| `/rules/dynamic-timestamp` 404s but `/rules/dynamic-timestamp.html` works | `_redirects` wasn't uploaded | Confirm it's in the deploy root, not a subfolder |
| Site loads at `/dist/` | Same as blank page | Redeploy |
| Every page 404s | Only some files uploaded | Redeploy, select all 28 files |
| `wrangler: command not found` | PATH issue | See the `~/.npm-global` fix in Path B |
| Cloudflare asks for a card | You clicked Workers, not Pages | Pages direct upload is free and asks for nothing |

**One thing I could not test:** whether `_redirects` actually takes effect on
Cloudflare. The syntax is Cloudflare's own and the file is generated and
consistency-checked, but I have no account to run their rewrite engine. That
curl loop is the test. If `/rules/` returns 404 while `/rules/index.html`
returns 200, `_redirects` isn't being read — tell me and I'll switch the
sitemap to `.html` URLs instead, which needs no rewrites at all.
