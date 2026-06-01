// scrape.js
// Reads live curation from https://www.jiotv.com across ALL top-nav tabs.
//
// jiotv.com is a server-rendered SPA where each top-nav tab is its own route
// (/, /sports, /movies, /kids, /news, /shows, /specials, /premium, /tv-guide).
// Visiting each URL directly is more reliable than clicking the nav. For each
// tab we wait for hydration, scroll to trigger lazy rails, and extract rails +
// items straight from the DOM, then normalize into the snapshot shape that
// scorer.js expects.

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE_DEFAULT = process.env.JIOTV_URL || "https://www.jiotv.com";
const OUT = path.join(__dirname, "..", "docs", "data");
const CONFIG = path.join(OUT, "tabs.json");
const NAV_TIMEOUT = 45000;
const HYDRATE_TIMEOUT = 28000;

// Tabs are loaded from docs/data/tabs.json so they can be managed without
// editing code (the dashboard has an editor that regenerates this file).
// Falls back to a built-in list if the config is missing or malformed.
const DEFAULT_TABS = [
  { id: "for_you",  name: "For You",  path: "/" },
  { id: "premium",  name: "Premium",  path: "/premium" },
  { id: "movies",   name: "Movies",   path: "/movies" },
  { id: "sports",   name: "Sports",   path: "/sports" },
  { id: "specials", name: "Specials", path: "/specials" },
  { id: "kids",     name: "Kids",     path: "/kids" },
  { id: "news",     name: "News",     path: "/news" },
  { id: "shows",    name: "Shows",    path: "/shows" },
];

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    const tabs = Array.isArray(cfg.tabs) && cfg.tabs.length ? cfg.tabs : DEFAULT_TABS;
    // sanitize: require name + path; derive id if missing
    const clean = tabs
      .filter((t) => t && t.name && t.path)
      .map((t) => ({
        id: t.id || String(t.name).toLowerCase().replace(/[^a-z0-9]+/g, "_"),
        name: String(t.name).trim(),
        path: String(t.path).trim().startsWith("/") ? String(t.path).trim() : "/" + String(t.path).trim(),
      }));
    return { base: cfg.base || BASE_DEFAULT, tabs: clean.length ? clean : DEFAULT_TABS };
  } catch {
    return { base: BASE_DEFAULT, tabs: DEFAULT_TABS };
  }
}

const { base: BASE, tabs: TABS } = loadConfig();

// Nav labels / boilerplate that are not real rail titles. Tab names are added
// dynamically from the config so new tabs are auto-excluded as rail titles.
const NON_RAIL = [
  ...TABS.map((t) => t.name),
  "TV Guide",
  "Explore", "Support", "Home", "Guest User",
  "Experience non-stop entertainment on JioTV app!",
  "See All", "Watch Free Now",
  "Download on the Apple App Store", "Get it on Google Play Store",
];

function extractInPage(NON_RAIL) {
  const clean = (s) => (s || "").toString().replace(/\s+/g, " ").trim();
  const skip = new Set(NON_RAIL);
  const LANGS = ["hindi","english","tamil","telugu","kannada","malayalam","marathi",
    "bengali","gujarati","punjabi","odia","assamese","urdu","bhojpuri"];
  const GENRES = ["news","sports","movies","kids","music","devotional","entertainment",
    "comedy","drama","lifestyle"];
  const sniff = (text, list) => { const t = (text||"").toLowerCase(); return list.find(x=>t.includes(x)); };
  const isTimeSlot = (t) => /\b\d{1,2}:\d{2}\b/.test(t) || /^(mon|tue|wed|thu|fri|sat|sun),/i.test(t);

  // Walk the document in DOM order, tracking the "current rail" heading. Every
  // content tile (img[alt]) gets attached to the most recent valid heading.
  // This is layout-agnostic — works for rail strips, grids, and EPG-ish pages.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  const rails = [];
  let current = null;

  const pushItem = (img) => {
    const alt = clean(img.getAttribute("alt"));
    if (!alt || alt.length > 70) return;
    if (/google play|app store|^logo$/i.test(alt)) return;
    if (!current) { // tiles before any heading -> bucket
      current = { title: "Featured", type: "rail", items: [] };
      rails.push(current);
    }
    const a = img.closest("a");
    const href = a ? a.getAttribute("href") : null;
    const titlePart = alt.split(/ on /i)[0];
    current.items.push({
      title: titlePart || alt,
      channel: alt.includes(" on ") ? alt.split(/ on /i).pop() : undefined,
      language: sniff(alt, LANGS),
      genre: sniff((current.title || "") + " " + alt, GENRES),
      ageRating: undefined,
      deeplink: href && /^\//.test(href) ? "https://www.jiotv.com" + href : (href || undefined),
      hasArtwork: !!(img.getAttribute("src") || img.getAttribute("data-src")),
    });
  };

  let node;
  while ((node = walker.nextNode())) {
    const tag = node.tagName;
    if (tag === "H2" || tag === "H3") {
      const title = clean(node.textContent);
      if (title && title.length < 55 && !skip.has(title) && !isTimeSlot(title)) {
        current = { title, type: /channel/i.test(title) ? "channel" : "rail", items: [] };
        rails.push(current);
      }
    } else if (tag === "IMG" && node.getAttribute("alt")) {
      pushItem(node);
    }
  }

  // de-dupe items within each rail; drop empty rails
  const railsClean = [];
  const seenR = new Set();
  for (const r of rails) {
    const seen = new Set();
    r.items = r.items.filter((it) => { const k = it.title.toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; }).slice(0, 50);
    if (!r.items.length) continue;
    const rk = r.title.toLowerCase();
    if (seenR.has(rk)) continue; seenR.add(rk);
    railsClean.push(r);
  }

  const banners = [...document.querySelectorAll("[class*='carousel'] img[alt], [class*='banner'] img[alt], [class*='hero'] img[alt]")]
    .map((i) => ({ title: clean(i.getAttribute("alt")) })).filter((b) => b.title).slice(0, 8);

  return { rails: railsClean, banners };
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const snapshot = { capturedAt: new Date().toISOString(), source: BASE, tabs: [] };
  let browser;

  try {
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const ctx = await browser.newContext({
      userAgent: "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
      viewport: { width: 412, height: 915 },
      locale: "en-IN",
      ignoreHTTPSErrors: true,
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);

    const fingerprints = {};

    // Count content tiles that aren't nav chrome / store badges — the real hydration signal.
    const tileCount = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("img[alt]")].filter((i) => {
          const a = (i.getAttribute("alt") || "").trim();
          return a && a.length < 70 && !/google play|app store|logo/i.test(a);
        }).length
      );

    for (const tab of TABS) {
      const entry = { id: tab.id, name: tab.name, path: tab.path, banners: [], rails: [] };
      // Up to 3 attempts; a tab that genuinely has content shouldn't stay empty.
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await page.goto(BASE + tab.path, { waitUntil: "load", timeout: NAV_TIMEOUT });
          // Wait until real content tiles appear (not just nav), polling up to HYDRATE_TIMEOUT.
          await page
            .waitForFunction(
              () =>
                [...document.querySelectorAll("img[alt]")].filter((i) => {
                  const a = (i.getAttribute("alt") || "").trim();
                  return a && a.length < 70 && !/google play|app store|logo/i.test(a);
                }).length >= 4,
              { timeout: HYDRATE_TIMEOUT }
            )
            .catch(() => {});
          // Settle + lazy-load by scrolling the full page, then back to top.
          // Home ("/") hydrates slowest, so give it extra settle time.
          await page.waitForTimeout(tab.path === "/" ? 4000 : 1800);
          for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 1400); await page.waitForTimeout(500); }
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForTimeout(600);

          const before = await tileCount();
          const { rails, banners } = await page.evaluate(extractInPage, NON_RAIL);
          entry.rails = rails; entry.banners = banners;

          if (rails.length || before === 0) break; // got content, or genuinely empty
          // tiles existed but extractor found nothing — retry once more
        } catch (err) {
          entry.note = `Failed to load (attempt ${attempt}): ${err.message}`;
        }
      }
      try {
        const { rails, banners } = { rails: entry.rails, banners: entry.banners };

        const fp = entry.rails.map((r) => r.title.toLowerCase()).sort().join("|");
        const mirror = Object.entries(fingerprints).find(([, f]) => f && f === fp && fp.length);
        if (mirror && entry.rails.length) entry.note = `Content mirrors the "${mirror[0]}" tab — likely guest-gated.`;
        fingerprints[tab.name] = fp;
        if (!entry.rails.length && !entry.note) entry.note = "No rails captured (tab may require login or had no content).";
      } catch (err) {
        entry.note = entry.note || `Extraction error: ${err.message}`;
      }
      snapshot.tabs.push(entry);
      console.log(`${tab.name.padEnd(9)} -> ${entry.rails.length} rails, ` +
        `${entry.rails.reduce((a, r) => a + r.items.length, 0)} items` + (entry.note ? `  [${entry.note}]` : ""));
    }

    const totalItems = snapshot.tabs.reduce((a, t) => a + t.rails.reduce((x, r) => x + r.items.length, 0), 0);
    if (totalItems === 0) snapshot.error = "No curation captured across any tab (possible geo-block, markup change, or all tabs gated).";
  } catch (err) {
    snapshot.error = `Scrape failed: ${err.message}`;
  } finally {
    if (browser) await browser.close();
  }

  fs.writeFileSync(path.join(OUT, "snapshot.json"), JSON.stringify(snapshot, null, 2));
  const rails = snapshot.tabs.reduce((a, t) => a + t.rails.length, 0);
  const items = snapshot.tabs.reduce((a, t) => a + t.rails.reduce((x, r) => x + r.items.length, 0), 0);
  console.log(`\nWrote snapshot: ${snapshot.tabs.length} tabs, ${rails} rails, ${items} items.` + (snapshot.error ? ` NOTE: ${snapshot.error}` : ""));
}

run();
