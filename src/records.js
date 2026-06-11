// Per-chart best records: data/records.json
// { "<chartKey>": { "<userId>": { name, acc, rank, combo, date } } }
// chartKey = chart name, with ".voice" suffix in voice mode.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const FILE = join(DATA, "records.json");

function load() {
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

// returns true if this run is a new personal best
export function submitRecord(chartKey, userId, entry) {
  const all = load();
  const board = (all[chartKey] ??= {});
  const prev = board[userId];
  if (prev && prev.acc >= entry.acc) return false;
  board[userId] = { ...entry, date: new Date().toISOString().slice(0, 10) };
  mkdirSync(DATA, { recursive: true });
  writeFileSync(FILE, JSON.stringify(all, null, 2));
  return true;
}

export function getBoard(chartKey, limit = 10) {
  const board = load()[chartKey] ?? {};
  return Object.entries(board)
    .map(([userId, e]) => ({ userId, ...e }))
    .sort((a, b) => b.acc - a.acc || b.combo - a.combo)
    .slice(0, limit);
}

export function getBest(chartKey, userId) {
  return load()[chartKey]?.[userId] ?? null;
}
