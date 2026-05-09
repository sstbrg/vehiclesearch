# Yad2 AI Search

Natural-language search over Yad2 vehicles, with AI scoring each listing against qualitative criteria like "single owner", "no accidents", "garage kept".

## Architecture

```
Browser (React/Vite)
   │
   ├──→ /yad2?url=...      ──→ gw.yad2.co.il (browses listings)
   └──→ /gemini POST       ──→ generativelanguage.googleapis.com (parses + evaluates)
        │
        Cloudflare Worker (yad2-ai)
        – GEMINI_API_KEY secret
        – PROXY_TOKEN secret (optional, gates both endpoints)
```

The Worker exists for two reasons:
1. Yad2 blocks browser-origin fetches (Cloudflare/PerimeterX); a server-side proxy with the right headers gets through and adds CORS.
2. Gemini API key must never live in the browser.

## Deploy

### Option A: Local wrangler (one-time)

```bash
npm install
cd worker && wrangler deploy && wrangler secret put GEMINI_API_KEY && cd ..
cp .env.example .env  # edit VITE_PROXY_URL
npm run dev
```

### Option B: GitHub Actions (auto-deploy on push to main)

`.github/workflows/deploy-worker.yml` deploys the Worker on every push to `main` that touches `worker/**`, and can also be run manually via the Actions tab. Add these repo secrets at **Settings → Secrets and variables → Actions**:

| Secret | Where to get it |
|--------|----------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → "Edit Cloudflare Workers" template |
| `CLOUDFLARE_ACCOUNT_ID` | Right sidebar of Workers & Pages, or in the dashboard URL |
| `GEMINI_API_KEY`       | https://aistudio.google.com/apikey (free tier, no card required) |

The action uses `cloudflare/wrangler-action@v3` and pushes `GEMINI_API_KEY` to the Worker on each deploy. To enable the optional `PROXY_TOKEN` gate later, add the secret in GitHub and re-add it to the `secrets:` block in the workflow.

### Frontend on Cloudflare Pages

`.github/workflows/deploy-pages.yml` builds the Vite app and deploys it to a Cloudflare Pages project named `yad2-ai-search`. The build bakes `VITE_PROXY_URL=https://yad2-ai.sstbrg.workers.dev` into the bundle.

Reuses the same `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets as the Worker workflow. **The token needs `Cloudflare Pages:Edit` in addition to Workers permissions.** If the deploy fails with a 403, edit the token at https://dash.cloudflare.com/profile/api-tokens and add the Pages permission, or re-create with a custom token covering both.

After the first successful run the app is live at `https://yad2-ai-search.pages.dev`.

## Custom domain on steinberg-tech.com

Domain must be on Cloudflare DNS (free plan is fine). Then in `worker/wrangler.toml` uncomment the `routes` block and `wrangler deploy`. The DNS record + TLS cert are auto-created.

## Costs

- Cloudflare Workers free tier: 100k requests/day
- Google AI Studio free tier (Gemini 2.5 Flash): generous daily quota for personal use; one search = 1 parse call + 1 evaluation call. Hard limits and rate caps at https://ai.google.dev/gemini-api/docs/rate-limits

## Known limits

- Manufacturer/model: looks up brand IDs from Yad2's manufacturer-list endpoint. If Yad2 changes the response shape, the brand chip turns red and brand isn't filtered server-side.
- AI sees the search-feed text only (1-2 lines per listing). For full ad descriptions, add per-listing detail fetches via `gw.yad2.co.il/api/item/{token}`.
- Heavy Yad2 scraping risks IP blocks. Worker caches 60s; don't aggressively poll.

## Roadmap

- [ ] Per-listing detail fetch ("deep mode") for fuller AI evaluation
- [ ] Save searches + scheduled runs (Cloudflare Cron Triggers + KV for seen IDs + Telegram bot for alerts)
- [ ] Model resolver (currently client-side text match)
- [ ] Real estate, second-hand goods (same gateway pattern, different feed paths)
