import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHART_DIR = join(ROOT, "charts");

export function listCharts() {
  if (!existsSync(CHART_DIR)) return [];
  return readdirSync(CHART_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

export function loadChart(name) {
  const path = join(CHART_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  const chart = JSON.parse(readFileSync(path, "utf8"));
  chart.notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
  chart.path = path;
  chart.mtimeMs = statSync(path).mtimeMs;
  chart.audioPath = join(ROOT, chart.audio);
  if (!existsSync(chart.audioPath)) {
    throw new Error(`chart "${name}" audio missing: ${chart.audio} (run \`npm run gen\`?)`);
  }
  return chart;
}

// VOICE mode: collapse all lanes into one tappable stream. Notes closer than
// 120ms apart (chords, dense stacks) merge into a single note.
export function toVoiceChart(chart) {
  const merged = [];
  for (const n of chart.notes) {
    if (merged.length && n.t - merged[merged.length - 1].t < 120) continue;
    merged.push({ t: n.t, lane: 0 });
  }
  return {
    ...chart,
    lanes: 1,
    notes: merged,
    voice: true,
    title: `${chart.title} — VOICE`,
  };
}
