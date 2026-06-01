// rubric.js
// The scoring rubric for the JioTV Smart Curation Agent.
// Pure rules / heuristics. No API key, no ML. Every score is explainable.
//
// Four dimensions, each scored 0-100, then combined into a weighted overall score.
// Grounded in product-constitution.md, product-strategy.md, accessibility.md.

const DIMENSIONS = {
  constitution: {
    label: "Constitutional Alignment",
    weight: 0.35,
    blurb:
      "Diversity of content, child-safety posture, and language inclusivity per the Product Constitution (Articles II, V, VII).",
  },
  strategy: {
    label: "Strategy Alignment",
    weight: 0.25,
    blurb:
      "Coverage of strategic pillars (Content / Distribution / Discovery) and named target segments per product-strategy.md.",
  },
  freshness: {
    label: "Freshness & Integrity",
    weight: 0.25,
    blurb:
      "Staleness of items, expired streaming rights, dead deeplinks, and missing artwork.",
  },
  engagement: {
    label: "Engagement Heuristics",
    weight: 0.15,
    blurb:
      "Position discipline, rail repetition, duplicate items, and rail-length sanity for the leaky-bucket retention problem.",
  },
};

// ----- Reference vocabularies (from the product docs) -----

// 12+ Indian languages JioTV commits to as first-class citizens.
const FIRST_CLASS_LANGUAGES = [
  "hindi", "english", "tamil", "telugu", "kannada", "malayalam",
  "marathi", "bengali", "gujarati", "punjabi", "odia", "assamese",
  "urdu", "bhojpuri",
];

// Genres that signal content diversity (Constitution: "diversity is a promise to a diverse country").
const DIVERSITY_GENRES = [
  "news", "sports", "movies", "entertainment", "kids", "devotional",
  "music", "regional", "lifestyle", "infotainment", "comedy", "drama",
];

// Strategy pillars and the rail intents that map to them.
const PILLAR_SIGNALS = {
  content: ["fast", "free", "premium", "ott", "linear", "trending", "new releases", "top 10"],
  discovery: ["for you", "because you watched", "recommended", "continue watching", "more like this", "personalized"],
  distribution: ["live", "regional", "language", "near you", "in your area"],
};

// Named target segments from strategy doc -> rail signals that serve them.
const SEGMENT_SIGNALS = {
  "Cord-Cutter": ["sports", "premium", "trending", "ott"],
  "TV Loyalist": ["live", "news", "regional", "tv guide"],
  "Family Household": ["kids", "devotional", "family"],
  "Feature Phone User": ["free", "live", "news"],
  "Premium Seeker": ["premium", "ott", "sports", "new releases"],
};

// Ad-related rail markers — Constitution Art. II.10 (honest monetization) &
// design rule "never use ads within the design" for editorial surfaces.
const AD_MARKERS = ["sponsored", "promoted", "ad", "advertisement"];

module.exports = {
  DIMENSIONS,
  FIRST_CLASS_LANGUAGES,
  DIVERSITY_GENRES,
  PILLAR_SIGNALS,
  SEGMENT_SIGNALS,
  AD_MARKERS,
  // Tunable thresholds (kept in one place so they're easy to defend in review).
  THRESHOLDS: {
    STALE_DAYS: 7,             // catch-up window; items older than this on a "fresh" rail are stale
    MAX_RAILS_PER_TAB: 25,     // sanity ceiling
    MIN_ITEMS_PER_RAIL: 4,     // a rail shorter than this looks broken/empty
    MAX_ITEMS_PER_RAIL: 50,    // More Like This caps at 50 per overview
    KIDS_TAB_NAMES: ["kids"],
    DUP_RATIO_FLAG: 0.25,      // >25% of a rail duplicated elsewhere = repetition flag
    MAX_BANNERS_PER_TAB: 8,    // overview: max 8 banners per tab (CMS + CT)
  },
};
