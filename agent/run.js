// run.js
// Scores docs/data/snapshot.json -> docs/data/report.json, and appends a
// compact entry to docs/data/history.json for trend display on the dashboard.

const fs = require("fs");
const path = require("path");
const { scoreSnapshot } = require("./scorer");

const DATA = path.join(__dirname, "..", "docs", "data");

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

const snapshot = readJSON(path.join(DATA, "snapshot.json"), null);
if (!snapshot) {
  console.error("No snapshot.json found — run scrape.js first.");
  process.exit(1);
}

const report = scoreSnapshot(snapshot);
fs.writeFileSync(path.join(DATA, "report.json"), JSON.stringify(report, null, 2));

// Append to history (keep last 60 runs).
const history = readJSON(path.join(DATA, "history.json"), []);
history.push({
  scoredAt: report.scoredAt,
  overall: report.overall,
  grade: report.grade,
  dims: Object.fromEntries(Object.entries(report.dimensions).map(([k, v]) => [k, v.score])),
});
fs.writeFileSync(path.join(DATA, "history.json"), JSON.stringify(history.slice(-60), null, 2));

console.log(`Scored: overall ${report.overall} (${report.grade}), ${report.recommendations.length} recommendations.`);
