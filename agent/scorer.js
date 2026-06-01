// scorer.js
// Pure-function scoring engine. Input: a normalized curation snapshot.
// Output: per-dimension scores, an overall score, and actionable recommendations.
//
// A "snapshot" looks like:
// {
//   capturedAt: "2026-06-01T09:00:00Z",
//   source: "https://www.jiotv.com",
//   tabs: [
//     { id, name, banners: [ {title, deeplink} ],
//       rails: [ { title, type, items: [ {title, language, genre, ageRating,
//                                         lastUpdated, deeplink, hasArtwork,
//                                         rightsExpiry, isAd} ] } ] }
//   ]
// }

const R = require("./rubric");

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const lc = (s) => (s || "").toString().trim().toLowerCase();
const daysBetween = (a, b) => Math.floor((a - b) / 86400000);

function allItems(snapshot) {
  const items = [];
  for (const tab of snapshot.tabs || []) {
    for (const rail of tab.rails || []) {
      for (const it of rail.items || []) {
        items.push({ ...it, _tab: tab.name, _rail: rail.title });
      }
    }
  }
  return items;
}

// ---------- Dimension 1: Constitutional Alignment ----------
function scoreConstitution(snapshot, now) {
  const recs = [];
  const items = allItems(snapshot);
  let score = 100;

  // 1a. Language inclusivity — how many first-class languages are represented?
  const langs = new Set(items.map((i) => lc(i.language)).filter(Boolean));
  const covered = R.FIRST_CLASS_LANGUAGES.filter((l) => langs.has(l));
  const langCoverage = covered.length / R.FIRST_CLASS_LANGUAGES.length;
  if (langCoverage < 0.5) {
    const penalty = Math.round((0.5 - langCoverage) * 60);
    score -= penalty;
    const missing = R.FIRST_CLASS_LANGUAGES.filter((l) => !langs.has(l)).slice(0, 6);
    recs.push({
      severity: langCoverage < 0.25 ? "high" : "medium",
      dimension: "constitution",
      issue: `Only ${covered.length}/${R.FIRST_CLASS_LANGUAGES.length} first-class languages appear in curation.`,
      action: `Add rails or items in under-represented languages (e.g. ${missing.join(", ")}). Constitution Art. II.7: every language is a full citizen, not a translated Hindi app.`,
    });
  }

  // 1b. Hindi/English dominance check — no single language should swamp the surface.
  const langCounts = {};
  items.forEach((i) => { const l = lc(i.language); if (l) langCounts[l] = (langCounts[l] || 0) + 1; });
  const total = items.filter((i) => i.language).length || 1;
  const hindiEng = ((langCounts.hindi || 0) + (langCounts.english || 0)) / total;
  if (hindiEng > 0.8 && total > 10) {
    score -= 12;
    recs.push({
      severity: "medium",
      dimension: "constitution",
      issue: `${Math.round(hindiEng * 100)}% of language-tagged items are Hindi/English.`,
      action: "Rebalance toward regional languages so non-Hindi/English users don't feel like second-class citizens (Art. II.7).",
    });
  }

  // 1c. Genre diversity — "diversity is a promise to a diverse country".
  const genres = new Set(items.map((i) => lc(i.genre)).filter(Boolean));
  const genreCoverage = R.DIVERSITY_GENRES.filter((g) => genres.has(g)).length / R.DIVERSITY_GENRES.length;
  if (genreCoverage < 0.4) {
    score -= Math.round((0.4 - genreCoverage) * 50);
    recs.push({
      severity: "medium",
      dimension: "constitution",
      issue: `Genre spread is narrow (${genres.size} distinct genres surfaced).`,
      action: "Broaden rails to cover more of India's content spectrum (news, sports, devotional, regional, kids, music). Art. II.2.",
    });
  }

  // 1d. Child safety — kids tab must not surface non-kids age ratings.
  const kidsTabs = (snapshot.tabs || []).filter((t) => R.THRESHOLDS.KIDS_TAB_NAMES.includes(lc(t.name)));
  for (const kt of kidsTabs) {
    const unsafe = [];
    for (const rail of kt.rails || []) {
      for (const it of rail.items || []) {
        const rating = lc(it.ageRating);
        if (rating && !["u", "u/a 7+", "ua7+", "7+"].includes(rating)) {
          unsafe.push(it.title);
        }
      }
    }
    if (unsafe.length) {
      score -= 30; // child safety is a top-ranked principle; heavy penalty
      recs.push({
        severity: "high",
        dimension: "constitution",
        issue: `Kids tab surfaces ${unsafe.length} item(s) above U/A 7+ (e.g. "${unsafe[0]}").`,
        action: "Remove non-kids content from kids surfaces immediately. Art. IV/V: kids content must be siloed; safety is the default state.",
      });
    }
  }

  // 1e. Honest monetization — editorial rails shouldn't be stuffed with ad items.
  const adItems = items.filter((i) => i.isAd || R.AD_MARKERS.includes(lc(i.title).split(" ")[0]));
  if (adItems.length / (items.length || 1) > 0.15) {
    score -= 10;
    recs.push({
      severity: "medium",
      dimension: "constitution",
      issue: `Ad/promoted items are a large share of editorial curation (${adItems.length}).`,
      action: "Keep sponsored placements clearly distinguishable and limited in editorial rails. Art. II.10.",
    });
  }

  return { score: clamp(score), recs, evidence: { langCoverage, genreCoverage, hindiEng } };
}

// ---------- Dimension 2: Strategy Alignment ----------
function scoreStrategy(snapshot, now) {
  const recs = [];
  let score = 100;
  const railTitles = [];
  for (const tab of snapshot.tabs || [])
    for (const rail of tab.rails || []) railTitles.push(lc(rail.title) + " " + lc(rail.type));
  const blob = railTitles.join(" | ");

  // 2a. Pillar coverage.
  const pillarsHit = Object.entries(R.PILLAR_SIGNALS).filter(([, sigs]) =>
    sigs.some((s) => blob.includes(s))
  ).map(([p]) => p);
  const missingPillars = Object.keys(R.PILLAR_SIGNALS).filter((p) => !pillarsHit.includes(p));
  if (missingPillars.length) {
    score -= missingPillars.length * 15;
    recs.push({
      severity: missingPillars.length > 1 ? "high" : "medium",
      dimension: "strategy",
      issue: `Strategic pillar(s) under-served: ${missingPillars.join(", ")}.`,
      action:
        missingPillars.includes("discovery")
          ? "Add personalization rails (For You, Because You Watched, Continue Watching). Discovery is the pillar that fights the leaky bucket."
          : `Surface rails that serve the ${missingPillars.join(" & ")} pillar(s) per product-strategy.md §3.`,
    });
  }

  // 2b. Segment coverage.
  const segHit = Object.entries(R.SEGMENT_SIGNALS).filter(([, sigs]) =>
    sigs.some((s) => blob.includes(s))
  ).map(([seg]) => seg);
  const segMiss = Object.keys(R.SEGMENT_SIGNALS).filter((s) => !segHit.includes(s));
  if (segMiss.length > 2) {
    score -= (segMiss.length - 2) * 8;
    recs.push({
      severity: "medium",
      dimension: "strategy",
      issue: `Curation doesn't clearly serve ${segMiss.length} of 5 target segments (${segMiss.join(", ")}).`,
      action: "Ensure at least one rail speaks to each priority segment; the TV Loyalist and Feature Phone segments are the strategic moat.",
    });
  }

  // 2c. Continue Watching presence — direct retention lever.
  if (!blob.includes("continue watching")) {
    score -= 10;
    recs.push({
      severity: "medium",
      dimension: "strategy",
      issue: "No 'Continue Watching' rail detected on entry surfaces.",
      action: "Add Continue Watching high on the For You tab — it's the cheapest re-engagement hook for week-on-week retention.",
    });
  }

  return { score: clamp(score), recs, evidence: { pillarsHit, segHit } };
}

// ---------- Dimension 3: Freshness & Integrity ----------
function scoreFreshness(snapshot, now) {
  const recs = [];
  const items = allItems(snapshot);
  let score = 100;
  let stale = 0, deadLinks = 0, noArt = 0, expired = 0;

  for (const it of items) {
    if (it.lastUpdated) {
      const d = daysBetween(now, new Date(it.lastUpdated));
      const freshRail = /trending|new|top 10|for you|today/.test(lc(it._rail));
      if (freshRail && d > R.THRESHOLDS.STALE_DAYS) stale++;
    }
    if (it.deeplink && !/^jioplay:\/\/|^https?:\/\//.test(it.deeplink)) deadLinks++;
    if (it.hasArtwork === false) noArt++;
    if (it.rightsExpiry && new Date(it.rightsExpiry) < now) expired++;
  }

  if (expired) {
    score -= Math.min(40, expired * 8);
    recs.push({
      severity: "high",
      dimension: "freshness",
      issue: `${expired} item(s) have expired streaming rights but are still surfaced.`,
      action: "Pull expired-rights items now — surfacing them risks partner-contract violations (Constitution Art. II.9; legal.md §7).",
    });
  }
  if (deadLinks) {
    score -= Math.min(25, deadLinks * 5);
    recs.push({
      severity: deadLinks > 3 ? "high" : "medium",
      dimension: "freshness",
      issue: `${deadLinks} item(s) have malformed or missing deeplinks.`,
      action: "Fix deeplinks (expected jioplay:// or https://). A tap that goes nowhere breaks 'the stream is the product'.",
    });
  }
  if (stale) {
    score -= Math.min(20, stale * 3);
    recs.push({
      severity: "medium",
      dimension: "freshness",
      issue: `${stale} item(s) on freshness-sensitive rails are older than ${R.THRESHOLDS.STALE_DAYS} days.`,
      action: "Refresh Trending/New Releases/Top 10 rails; stale items on these rails erode trust in the surface.",
    });
  }
  if (noArt) {
    score -= Math.min(15, noArt * 2);
    recs.push({
      severity: "low",
      dimension: "freshness",
      issue: `${noArt} item(s) are missing artwork.`,
      action: "Backfill thumbnails; tiles without artwork tank CTR and look broken.",
    });
  }

  return { score: clamp(score), recs, evidence: { stale, deadLinks, noArt, expired } };
}

// ---------- Dimension 4: Engagement Heuristics ----------
function scoreEngagement(snapshot, now) {
  const recs = [];
  let score = 100;

  // 4a. Duplicate items across rails (repetition fatigue).
  const seen = {};
  const items = allItems(snapshot);
  items.forEach((i) => { const k = lc(i.title); if (k) seen[k] = (seen[k] || 0) + 1; });
  const dups = Object.entries(seen).filter(([, c]) => c > 1);
  const dupItems = dups.reduce((a, [, c]) => a + (c - 1), 0);
  if (items.length && dupItems / items.length > R.THRESHOLDS.DUP_RATIO_FLAG) {
    score -= Math.min(30, Math.round((dupItems / items.length) * 60));
    recs.push({
      severity: "medium",
      dimension: "engagement",
      issue: `${dupItems} duplicated item-slots across rails (${dups.length} titles repeat).`,
      action: "De-duplicate across rails. Repetition wastes scarce above-the-fold real estate and signals weak curation.",
    });
  }

  // 4b. Rail length sanity.
  let shortRails = 0, longRails = 0, tooManyRails = 0, bannerOverflow = 0;
  for (const tab of snapshot.tabs || []) {
    if ((tab.rails || []).length > R.THRESHOLDS.MAX_RAILS_PER_TAB) tooManyRails++;
    if ((tab.banners || []).length > R.THRESHOLDS.MAX_BANNERS_PER_TAB) bannerOverflow++;
    for (const rail of tab.rails || []) {
      const n = (rail.items || []).length;
      if (n < R.THRESHOLDS.MIN_ITEMS_PER_RAIL) shortRails++;
      if (n > R.THRESHOLDS.MAX_ITEMS_PER_RAIL) longRails++;
    }
  }
  if (shortRails) {
    score -= Math.min(20, shortRails * 4);
    recs.push({
      severity: "medium",
      dimension: "engagement",
      issue: `${shortRails} rail(s) have fewer than ${R.THRESHOLDS.MIN_ITEMS_PER_RAIL} items.`,
      action: "Merge or hide thin rails — a near-empty rail reads as broken and pushes good content below the fold.",
    });
  }
  if (longRails) {
    score -= Math.min(10, longRails * 3);
    recs.push({
      severity: "low",
      dimension: "engagement",
      issue: `${longRails} rail(s) exceed ${R.THRESHOLDS.MAX_ITEMS_PER_RAIL} items.`,
      action: "Cap rail length; users rarely scroll past ~20 tiles horizontally.",
    });
  }
  if (bannerOverflow) {
    score -= 8;
    recs.push({
      severity: "low",
      dimension: "engagement",
      issue: `${bannerOverflow} tab(s) exceed the ${R.THRESHOLDS.MAX_BANNERS_PER_TAB}-banner ceiling.`,
      action: "Trim carousel banners to the 8-banner max (CMS + CleverTap combined) per product-overview §3.1.",
    });
  }

  // 4c. Position discipline — Continue Watching / personalization should sit near top.
  for (const tab of snapshot.tabs || []) {
    const rails = tab.rails || [];
    const cwIndex = rails.findIndex((r) => lc(r.title).includes("continue watching"));
    if (cwIndex > 3) {
      score -= 6;
      recs.push({
        severity: "low",
        dimension: "engagement",
        issue: `'Continue Watching' sits at position ${cwIndex + 1} on the ${tab.name} tab.`,
        action: "Promote Continue Watching into the top 3 rails — resumption is the highest-intent action.",
      });
      break;
    }
  }

  return { score: clamp(score), recs, evidence: { dupItems, shortRails, longRails } };
}

// ---------- Aggregate ----------
function scoreSnapshot(snapshot, nowDate) {
  const now = nowDate || new Date();
  const dims = {
    constitution: scoreConstitution(snapshot, now),
    strategy: scoreStrategy(snapshot, now),
    freshness: scoreFreshness(snapshot, now),
    engagement: scoreEngagement(snapshot, now),
  };

  let overall = 0;
  for (const [key, def] of Object.entries(R.DIMENSIONS)) {
    overall += dims[key].score * def.weight;
  }
  overall = Math.round(overall);

  const recommendations = []
    .concat(...Object.values(dims).map((d) => d.recs))
    .sort((a, b) => {
      const rank = { high: 0, medium: 1, low: 2 };
      return rank[a.severity] - rank[b.severity];
    });

  const grade =
    overall >= 85 ? "A" : overall >= 70 ? "B" : overall >= 55 ? "C" : overall >= 40 ? "D" : "F";

  // Per-tab quick stats for the dashboard.
  const tabStats = (snapshot.tabs || []).map((t) => ({
    name: t.name,
    rails: (t.rails || []).length,
    items: (t.rails || []).reduce((a, r) => a + (r.items || []).length, 0),
    banners: (t.banners || []).length,
  }));

  return {
    capturedAt: snapshot.capturedAt || now.toISOString(),
    scoredAt: now.toISOString(),
    source: snapshot.source || "unknown",
    overall,
    grade,
    dimensions: Object.fromEntries(
      Object.entries(dims).map(([k, v]) => [
        k,
        { label: R.DIMENSIONS[k].label, weight: R.DIMENSIONS[k].weight, score: v.score, evidence: v.evidence },
      ])
    ),
    recommendations,
    tabStats,
    totals: {
      tabs: (snapshot.tabs || []).length,
      rails: tabStats.reduce((a, t) => a + t.rails, 0),
      items: tabStats.reduce((a, t) => a + t.items, 0),
    },
  };
}

module.exports = { scoreSnapshot, allItems };
