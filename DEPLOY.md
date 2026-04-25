# Deploying intime to Railway + intimeapp.org

> **Database:** intime uses **Supabase** (hosted Postgres) for all storage — no Railway
> volume, no local database file. Just set the env vars and the app is stateless.

---

## Section 1: Pre-deploy local checklist

### 1a — Create required Supabase tables

Two tables were added recently and must exist before deploying.
Run these in your Supabase project → **SQL Editor**:

```sql
-- Timer state (one row per user, upserted on every timer transition)
CREATE TABLE timer_state (
  user_id       TEXT PRIMARY KEY,
  mode          TEXT NOT NULL,
  status        TEXT NOT NULL,
  duration_secs INTEGER NOT NULL,
  started_at    BIGINT,
  elapsed_secs  INTEGER NOT NULL DEFAULT 0,
  wasted_at     BIGINT,
  updated_at    BIGINT NOT NULL
);

-- Chat history (append-only, last 50 loaded on sign-in)
CREATE TABLE chat_messages (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL,   -- 'user' | 'model'
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ON chat_messages (user_id, created_at);
```

### 1b — Run security tests locally

Start the server:
```bash
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000
```

**Test 1 — HttpOnly cookie is set on sign-in**
1. Open `http://localhost:8000/app` in Chrome
2. Sign in with Google
3. DevTools → Application → Cookies → `http://localhost:8000`
4. Confirm a `session` cookie exists with **HttpOnly** checked and **Secure** unchecked (dev mode)

**Test 2 — Unauthenticated requests are rejected**
```bash
curl -i http://localhost:8000/get-profile
# Expected: HTTP 401  {"detail":"Not authenticated"}

curl -i http://localhost:8000/timer/state
# Expected: HTTP 401

curl -i http://localhost:8000/chat/history
# Expected: HTTP 401
```

**Test 3 — Session survives a page refresh**
1. Sign in at `http://localhost:8000/app`
2. Hard-refresh the page (Cmd+Shift+R / Ctrl+Shift+R)
3. Confirm: still signed in (no Google sign-in button appears, user badge shows)

### 1c — Confirm no secrets in git

```bash
git log --all --full-history -- .env
# Should return nothing. If it shows commits, your .env was once committed —
# rotate ALL secrets before deploying.

grep -r "sk_live_\|sk_test_\|whsec_" --include="*.py" --include="*.js" --include="*.html" .
# Should return nothing.
```

### 1d — Stripe is in TEST mode for first deploy

Your `.env` should have `STRIPE_SECRET_KEY=sk_test_...`.
Do not use live keys until Section 10.

---

## Section 2: Push to GitHub

```bash
git add .
git commit -m "Production-ready deploy config"
git push origin main
```

---

## Section 3: Deploy to Railway

1. Go to [railway.com](https://railway.com) → Login with GitHub
2. Click **"+ New Project"** → **"Deploy from GitHub repo"**
3. Authorize Railway to access the intime repo
4. Select the repo → Railway auto-detects the `Dockerfile` and starts building
5. Wait for first deploy to complete (2–5 min) — watch the build log tab
6. Service → **Settings → Networking → "Generate Domain"**
   (gives a temp URL like `intime-production.up.railway.app`)
7. Visit the temp URL — it will fail to fully work until env vars are added in Section 4

---

## Section 4: Configure environment variables in Railway

Service → **Variables** → click **"Raw Editor"** and paste:

```
ENV=production
APP_URL=https://intimeapp.org
SESSION_SECRET_KEY=<paste output of: openssl rand -hex 32>
GOOGLE_CLIENT_ID=121246915230-hrfas5irqhnb8sgg8qoc37ba51dqkg0g.apps.googleusercontent.com
SUPABASE_URL=https://<your-project-id>.supabase.co
SUPABASE_KEY=<anon key from Supabase dashboard>
GEMINI_API_KEY=<from aistudio.google.com>
STRIPE_SECRET_KEY=sk_test_<your test key>
STRIPE_WEBHOOK_SECRET=whsec_<placeholder — update after Section 6>
STRIPE_PRICE_ID_PRO_MONTHLY=price_<your price ID>
```

> **Do not add PORT** — Railway injects it automatically. Adding it manually
> causes a conflict.

After saving, Railway auto-redeploys (~1 min). Visit the temp URL — the app
should now load and sign-in should work. Stripe webhook and custom domain are
still pending.

---

## Section 5: Connect custom domain intimeapp.org (via Cloudflare DNS)

**Why Cloudflare:** The DNS spec forbids CNAME records on apex/root domains
(`intimeapp.org`). Railway only provides CNAME targets. Cloudflare does
**CNAME flattening** automatically, making apex CNAMEs work transparently.
It's free.

### Step 5a — Add domain to Cloudflare

1. If intimeapp.org is registered elsewhere (Namecheap, GoDaddy, Porkbun, etc.):
   a. Sign up at [cloudflare.com](https://cloudflare.com) (free plan)
   b. Dashboard → **"+ Add a site"** → enter `intimeapp.org` → choose **Free**
   c. Cloudflare scans existing DNS and gives you 2 nameservers
      (e.g. `amara.ns.cloudflare.com`, `greg.ns.cloudflare.com`)
   d. At your registrar, find **Domain / Nameservers** settings, replace current
      nameservers with the 2 Cloudflare ones
   e. Wait for propagation (usually <1 hour, up to 24h). Cloudflare emails when ready.

### Step 5b — Add custom domains in Railway

1. Service → **Settings → Networking → Custom Domains**
2. Click **"+ Add Domain"** → enter `intimeapp.org`
   → Railway gives a CNAME target like `xyz123.up.railway.app`. Copy it.
3. Click **"+ Add Domain"** again → enter `www.intimeapp.org`
   → Copy that CNAME target too (may be the same or different).

### Step 5c — Add DNS records in Cloudflare

1. Cloudflare dashboard → your site → **DNS → Records**
2. Delete any existing `A`, `AAAA`, or `CNAME` records for `@` and `www`
3. Add:
   - Type `CNAME` | Name `@` | Target `<railway-cname-for-root>` | Proxy **OFF** (gray cloud)
   - Type `CNAME` | Name `www` | Target `<railway-cname-for-www>` | Proxy **OFF** (gray cloud)

> **Why proxy OFF first?** Cloudflare proxy can interfere with Railway's automatic
> Let's Encrypt SSL provisioning. Once Railway shows a green checkmark and SSL is
> active, you can optionally flip proxy to ON (orange) for CDN benefits.

### Step 5d — Wait for Railway SSL

Back in Railway, wait for a green checkmark next to both domains (usually 2–10 min,
up to 72h). Railway auto-issues Let's Encrypt SSL.

Visit `https://intimeapp.org` — should load the app with a valid SSL certificate.

---

## Section 6: Configure Stripe webhook for production

1. [Stripe Dashboard](https://dashboard.stripe.com) → **Developers → Webhooks → "+ Add endpoint"**
2. Endpoint URL: `https://intimeapp.org/api/stripe/webhook`
3. Select events:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
   - `invoice.payment_succeeded`
4. Save → click the new webhook → **"Signing secret"** → Reveal → copy the `whsec_...` value
5. Railway → **Variables** → update `STRIPE_WEBHOOK_SECRET` with the real value
6. Railway auto-redeploys on save

**Local webhook testing:**
```bash
stripe listen --forward-to localhost:8000/api/stripe/webhook
# Copy the whsec_ value it prints and put it in your local .env
```

---

## Section 7: Configure Google OAuth for production

[Google Cloud Console](https://console.cloud.google.com) →
**APIs & Services → Credentials → your OAuth 2.0 Client ID → Edit:**

- **Authorized JavaScript origins** — add:
  - `https://intimeapp.org`
  - `https://www.intimeapp.org`
- **Authorized redirect URIs** — no changes needed (intime uses the GSI client-side
  flow; only JavaScript origins matter)

Save. Changes propagate within a few minutes.

---

## Section 8: Post-deploy end-to-end test

- [ ] `https://intimeapp.org` loads the landing page, SSL valid (green lock)
- [ ] Click "Get Started Free" → reaches `/app`
- [ ] Google sign-in button appears, sign-in works, session cookie is set
      (DevTools → Application → Cookies → `session` with HttpOnly checked)
- [ ] Refresh page while signed in → stays signed in, no popup flash
- [ ] Start a Focus timer, refresh mid-session → timer restores in running state
- [ ] Chat with Study Friend → works; refresh → history reloads from server
- [ ] Click "Get Pro — $9/mo" → redirects to Stripe Checkout
- [ ] Complete checkout with test card `4242 4242 4242 4242` (any future expiry, any CVC)
- [ ] Redirected back to `/app?upgraded=true` → within ~10 seconds Pro features unlock
- [ ] Stripe Dashboard → Webhooks → your endpoint → Recent deliveries shows 200 responses
- [ ] `https://intimeapp.org/health` returns `{"status":"ok"}`
- [ ] Railway logs show structured lines: `method=GET path=/health status=200 ms=1`

---

## Section 9: Rollback plan

Railway → service → **Deployments** tab → find the last known-good deployment →
click **"⋯" → Redeploy**. Reverts in ~1 minute.

---

## Section 10: Go live with real payments

Once all test-mode flows pass end-to-end:

1. [Stripe Dashboard](https://dashboard.stripe.com) → toggle **Test mode → Live mode**
2. Create a new Product + Recurring Price in Live mode ($9/month) —
   live Price IDs are separate from test Price IDs
3. Create a new webhook endpoint in Live mode with the same 5 events (Section 6)
4. Railway → **Variables** — swap values:

   | Variable | Replace with |
   |---|---|
   | `STRIPE_SECRET_KEY` | `sk_live_...` |
   | `STRIPE_WEBHOOK_SECRET` | `whsec_...` (live webhook signing secret) |
   | `STRIPE_PRICE_ID_PRO_MONTHLY` | `price_...` (live price ID) |

5. Railway auto-redeploys. Run Section 8 checklist once more with a real card.

---

## Human checklist (what you do manually)

- [ ] Confirm `intimeapp.org` is registered and you control DNS
- [ ] Create `timer_state` and `chat_messages` tables in Supabase (Section 1a SQL)
- [ ] Sign up for [Railway](https://railway.com) (GitHub login)
- [ ] Sign up for [Cloudflare](https://cloudflare.com) free plan, transfer DNS nameservers
- [ ] Generate `SESSION_SECRET_KEY`: `openssl rand -hex 32`
- [ ] Copy Supabase URL + anon key from Supabase dashboard → Settings → API
- [ ] Copy Gemini API key from [aistudio.google.com](https://aistudio.google.com)
- [ ] Copy Google OAuth Client ID from Google Cloud Console
- [ ] Copy Stripe test keys from Stripe dashboard → Developers → API keys
- [ ] Create a test Product + Price in Stripe, copy the Price ID
- [ ] Fill all env vars in Railway (Section 4)
- [ ] Set up Stripe webhook, copy signing secret, update Railway var (Section 6)
- [ ] Add `https://intimeapp.org` to Google OAuth authorized origins (Section 7)
- [ ] Run post-deploy end-to-end test checklist (Section 8)
- [ ] Swap to live Stripe keys after test-mode verification (Section 10)
