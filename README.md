# Yad2 AI Search

Natural-language search over Yad2 vehicles, with AI scoring each listing against qualitative criteria like "single owner", "no accidents", "garage kept".

## Architecture

```
Browser (React/Vite)
   │
   ├──→ /yad2?url=...      ──→ gw.yad2.co.il (browses listings)
   └──→ /claude POST       ──→ api.anthropic.com (parses + evaluates)
        │
        Cloudflare Worker (yad2-ai)
        – ANTHROPIC_API_KEY secret
        – PROXY_TOKEN secret (optional)
```

The Worker exists for two reasons:
1. Yad2 blocks browser-origin fetches (Cloudflare/PerimeterX); a server-side proxy with the right headers gets through and adds CORS.
2. Anthropic API key must never live in the browser.

## Deploy

### Option A: Local wrangler (one-time)

```bash
npm install
cd worker && wrangler deploy && wrangler secret put ANTHROPIC_API_KEY && cd ..
cp .env.example .env  # edit VITE_PROXY_URL
npm run dev
```

### Option B: GitHub Actions (auto-deploy on push to main)

`.github/workflows/deploy-worker.yml` deploys the Worker on every push to `main` that touches `worker/**`, and can also be run manually via the Actions tab. Add these repo secrets at **Settings → Secrets and variables → Actions**:

| Secret | Where to get it |
|--------|----------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → "Edit Cloudflare Workers" template |
| `CLOUDFLARE_ACCOUNT_ID` | Right sidebar of any zone in Cloudflare dashboard |
| `ANTHROPIC_API_KEY`    | console.anthropic.com → API keys |
| `PROXY_TOKEN`          | Optional. Random string if you want to gate `/yad2` and `/claude` |

The action uses `cloudflare/wrangler-action@v3` and pushes the secrets to the Worker on each deploy.

## Custom domain on steinberg-tech.com

Domain must be on Cloudflare DNS (free plan is fine). Then in `worker/wrangler.toml` uncomment the `routes` block and `wrangler deploy`. The DNS record + TLS cert are auto-created.

## Costs

- Cloudflare Workers free tier: 100k requests/day
- Anthropic API: pay-per-use; one search = 1 parse call (~1k tokens) + 1 evaluation call (~3-5k tokens) ≈ $0.01-0.03 per search with Sonnet 4.6

## Known limits

- Manufacturer/model: looks up brand IDs from Yad2's manufacturer-list endpoint. If Yad2 changes the response shape, the brand chip turns red and brand isn't filtered server-side.
- AI sees the search-feed text only (1-2 lines per listing). For full ad descriptions, add per-listing detail fetches via `gw.yad2.co.il/api/item/{token}`.
- Heavy Yad2 scraping risks IP blocks. Worker caches 60s; don't aggressively poll.

## Roadmap

- [ ] Per-listing detail fetch ("deep mode") for fuller AI evaluation
- [ ] Save searches + scheduled runs (Cloudflare Cron Triggers + KV for seen IDs + Telegram bot for alerts)
- [ ] Model resolver (currently client-side text match)
- [ ] Real estate, second-hand goods (same gateway pattern, different feed paths)
