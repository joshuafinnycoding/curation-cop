// scrape.js
// Reads live curation from https://www.jiotv.com using headless Chromium.
//
// Strategy: jiotv.com is a JS-rendered SPA whose home/tab content loads from
// internal JSON APIs after boot. We launch a real browser, navigate, and capture
// the network responses that look like curation payloads (rails/banners/items),
// then normalize them into the snapshot shape that scorer.js expects.
//
// Because the exact API shapes are owned by Jio and can change, the normalizer is
// defensive: it pulls the fields it recognizes and leaves the rest. If nothing
// usable is captured (login wall, geo-block, markup change), it writes a snapshot
// with an `error` note instead of crashing the pipeline — the dashboard surfaces that.

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const TARGET = process.env.JIOTV_URL || "https://www.jiotv.com";
const OUT = path.join(__dirname, "..", "docs", "data");
const TIMEOUT = 45000;

// Heuristics to decide whether a captured JSON response is curation data.
function looksLikeCuration(json) {
  if (!json || typeof json !== "object") return false;
  const s = JSON.stringify(json).toLowerCase();
  return (
    (s.includes("rail") || s.includes("banner") || s.includes("carousel") || s.includes("tray")) &&
    (s.includes("title") || s.includes("name")) &&
    s.length > 200
  );
}

// Best-effort field extraction from an unknown-but-curation-ish object tree.
function pluck(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

function normalizeItem(raw) {
  return {
    title: pluck(raw, ["title", "name", "showName", "channel_name", "clipName"]) || "Untitled",
    language: lcSafe(pluck(raw, ["language", "lang", "languageName"])),
    genre: lcSafe(pluck(raw, ["genre", "category", "categoryName", "channelCategory"])),
    ageRating: lcSafe(pluck(raw, ["ageRating", "age_rating", "certification", "rating"])),
    lastUpdated: pluck(raw, ["lastUpdated", "updatedAt", "modified", "publishTime"]),
    deeplink: pluck(raw, ["deeplink", "deepLink", "url", "uri", "action"]),
    hasArtwork: !!pluck(raw, ["image", "thumbnail", "logoUrl", "poster", "banner_url"]),
    rightsExpiry: pluck(raw, ["rightsExpiry", "expiry", "validTill", "rights_expiry"]),
    isAd: /sponsor|promot|\bad\b/i.test(JSON.stringify(raw).slice(0, 300)),
  };
}
const lcSafe = (s) => (s == null ? undefined : String(s).trim());

// Walk a captured payload and try to build rails.
function extractRails(json) {
  const rails = [];
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    const title = pluck(node, ["title", "name", "railTitle", "trayName", "header"]);
    const itemsArr =
      node.items || node.data || node.content || node.list || node.tiles || node.assets;
    if (title && Array.isArray(itemsArr) && itemsArr.length && typeof itemsArr[0] === "object") {
      rails.push({
        title: String(title),
        type: lcSafe(pluck(node, ["type", "layout", "railType"])) || "rail",
        items: itemsArr.slice(0, 60).map(normalizeItem),
      });
    }
    Object.values(node).forEach(visit);
  };
  visit(json);
  return rails;
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const captured = [];
  let browser;
  const snapshot = {
    capturedAt: new Date().toISOString(),
    source: TARGET,
    tabs: [],
  };

  try {
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
      viewport: { width: 412, height: 915 }, // mweb viewport
      locale: "en-IN",
    });
    const page = await ctx.newPage();

    page.on("response", async (resp) => {
      try {
        const ct = resp.headers()["content-type"] || "";
        if (!ct.includes("json")) return;
        const json = await resp.json().catch(() => null);
        if (looksLikeCuration(json)) captured.push({ url: resp.url(), json });
      } catch (_) {}
    });

    await page.goto(TARGET, { waitUntil: "networkidle", timeout: TIMEOUT });
    // Give SPA + lazy rails a moment, and scroll to trigger lazy loads.
    await page.waitForTimeout(4000);
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(800);
    }

    // Build rails from everything captured. Group under a single "Home" tab
    // unless payloads carry a tab/page identifier.
    const rails = [];
    for (const c of captured) rails.push(...extractRails(c.json));

    // De-dupe rails by title.
    const byTitle = {};
    for (const r of rails) if (r.items.length && !byTitle[r.title]) byTitle[r.title] = r;
    const dedup = Object.values(byTitle);

    if (dedup.length) {
      snapshot.tabs = [{ id: "home", name: "Home", banners: [], rails: dedup }];
    } else {
      // Fallback: at least record the DOM-visible rail headers so the run isn't empty.
      const headers = await page
        .$$eval("h2,h3,[class*='title'],[class*='rail'],[class*='tray']", (els) =>
          els.map((e) => e.textContent.trim()).filter((t) => t && t.length < 60).slice(0, 30)
        )
        .catch(() => []);
      snapshot.tabs = [
        {
          id: "home",
          name: "Home",
          banners: [],
          rails: headers.map((h) => ({ title: h, type: "rail", items: [] })),
        },
      ];
      snapshot.error =
        "No structured curation JSON was captured (likely login wall, geo-block, or API change). " +
        "Rail headers were read from the DOM as a fallback; item-level scoring is limited.";
    }
  } catch (err) {
    snapshot.error = `Scrape failed: ${err.message}`;
  } finally {
    if (browser) await browser.close();
  }

  fs.writeFileSync(path.join(OUT, "snapshot.json"), JSON.stringify(snapshot, null, 2));
  console.log(
    `Wrote snapshot: ${snapshot.tabs.reduce((a, t) => a + t.rails.length, 0)} rails, ` +
      `${snapshot.tabs.reduce((a, t) => a + t.rails.reduce((x, r) => x + r.items.length, 0), 0)} items.` +
      (snapshot.error ? ` NOTE: ${snapshot.error}` : "")
  );
}

run();
