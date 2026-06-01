# JioTV Smart Curation Agent

A rules-based agent that reads the **live curation** on https://www.jiotv.com, scores it across four dimensions, and recommends actionable changes — rendered on a mobile-friendly GitHub Pages dashboard.

No API keys. No ML. Every point of every score is explainable and traceable to the product docs.

---

## How it works (architecture)

```
GitHub Actions (you trigger it)
   └─ agent/scrape.js   → headless Chromium renders jiotv.com, captures live curation → docs/data/snapshot.json
   └─ agent/run.js      → rules engine scores it → docs/data/report.json (+ history.json)
   └─ commits the JSON back to the repo
GitHub Pages
   └─ docs/index.html   → "Run Agent" renders the latest committed report (mweb)
```

**Why a GitHub Actions job and not pure browser fetch?** A static page *cannot* read jiotv.com directly — the browser blocks cross-origin requests (CORS), and jiotv.com is a JS-rendered app whose curation loads from internal APIs after boot. Reading the live site genuinely requires a server-side headless browser, which is what the Actions job provides. The Pages site renders what that job produces.

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

- **Change weights / thresholds:** `agent/rubric.js`
- **Add a scoring rule:** add a check inside the relevant `score*()` function in `agent/scorer.js` (each pushes `{severity, dimension, issue, action}`)
- **Adapt to real API shapes:** the scraper's normalizer (`agent/scrape.js`) is defensive and field-name-agnostic; once you confirm jiotv.com's actual payload keys, tighten `pluck()` and `extractRails()` for cleaner extraction.

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

jiotv.com may sit behind a login or geo-gate. If the headless run can't capture structured curation, `scrape.js` falls back to reading visible rail headers from the DOM and records a `note` in the report (shown on the dashboard) — the pipeline never hard-fails. Item-level scoring is only as rich as what the live site exposes to the rendering session.
