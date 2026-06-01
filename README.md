# JioTV Smart Curation Agent

A rules-based agent that reads the **live curation** on https://www.jiotv.com, scores it across four dimensions, and recommends actionable changes — rendered on a mobile-friendly GitHub Pages dashboard.

No API keys. No ML. Every point of every score is explainable and traceable to the product docs.

---

## How it works (architecture)

```
GitHub Actions (you trigger it)
   └─ agent/scrape.js   → headless Chromium visits EACH top-nav tab of jiotv.com
   │                      (/, /sports, /movies, /kids, /news, /shows, /specials,
   │                       /premium, /tv-guide), extracts rails + items per tab
   │                      → docs/data/snapshot.json
   └─ agent/run.js      → rules engine scores it → docs/data/report.json (+ history.json)
   └─ commits the JSON back to the repo
GitHub Pages
   └─ docs/index.html   → "Run Agent" renders the latest report, per-tab (mweb)
```

Each top-nav tab on jiotv.com is its own route, so the scraper navigates to each URL directly (more reliable than clicking the nav), waits for the SPA to hydrate, scrolls to trigger lazy rails, and extracts rails/items straight from the rendered DOM. Every tab becomes its own labeled entry in the snapshot, so the scorer's per-tab logic — including Kids-tab safety — works correctly.

**Why a GitHub Actions job and not pure browser fetch?** A static page cannot read jiotv.com directly — the browser blocks cross-origin requests (CORS), and the site only fills in once its JavaScript runs. Reading the live site genuinely requires a server-side headless browser, which is what the Actions job provides.

---

## Setup

1. Push this repo to GitHub.
2. **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, folder: `/docs`.
3. **Settings → Actions → General** → Workflow permissions: *Read and write*.
4. **Actions tab → Run Curation Agent → Run workflow.** This scrapes, scores, and commits the first report.
5. Open your Pages URL and tap **Run Agent**.

The page ships with a sample report so it renders immediately, even before the first real run.

---

## The four scoring dimensions

| Dimension | Weight | What it checks | Grounded in |
|---|---|---|---|
| **Constitutional Alignment** | 35% | Language inclusivity (12+ first-class languages), genre diversity, kids-tab safety, honest monetization | `product-constitution.md` Art. II, V, VII |
| **Strategy Alignment** | 25% | Pillar coverage (Content / Distribution / Discovery), target-segment fit, Continue Watching presence | `product-strategy.md` §3–4 |
| **Freshness & Integrity** | 25% | Expired streaming rights, dead deeplinks, stale items on fresh rails, missing artwork | `legal.md` §7, Constitution Art. II.9 |
| **Engagement Heuristics** | 15% | Duplicate items across rails, rail-length sanity, banner ceiling (8), position discipline | `product-overview.md` §3 |

Thresholds live in `agent/rubric.js` — one place, easy to defend in review.

---

## Tuning

- **Add / remove tabs (no code):** open the dashboard → **⚙ Manage Tab URLs** → add a name + path (e.g. `Music` / `/music`) or remove one → **Save tabs.json** → commit the file to `docs/data/tabs.json`. The next agent run scrapes the updated list. You can also edit `docs/data/tabs.json` directly. *(TV Guide is intentionally excluded — it's an EPG grid, not rails.)*
- **Change weights / thresholds:** `agent/rubric.js`
- **Add a scoring rule:** add a check inside the relevant `score*()` function in `agent/scorer.js` (each pushes `{severity, dimension, issue, action}`)
- **Adapt to real API shapes:** the scraper's extractor (`agent/scrape.js`) walks the DOM by position; if JioTV's markup changes, adjust `extractInPage()`.

---

## Local run

```bash
npm install
npm run agent      # scrape + score
# then open docs/index.html via any static server
python3 -m http.server --directory docs
```

---

## A note on the scraper

The scraper walks all nine top-nav tabs. In a live run it reliably captures the rail-based tabs (For You, Premium, Movies, Sports, Specials, Kids, News, Shows) — hundreds of real items across ~80 rails. Two caveats:

- **TV Guide** is an EPG time-grid, not rails, so it yields no rail-style items (expected).
- **Render timing varies.** This SPA hydrates inconsistently under headless Chromium; on a given run a slow tab may occasionally come back empty. The scraper retries empty-but-populated tabs and labels any tab it couldn't capture with a `note` shown on the dashboard, so the pipeline never hard-fails and you're never misled about what was captured. Re-running the workflow typically fills any tab that flaked.

As a guest (logged out), the tabs expose free/discovery curation; personalization rails like "Continue Watching" only appear for authenticated sessions — which is itself a useful signal the agent reports.
