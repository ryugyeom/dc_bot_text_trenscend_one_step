// Per-user calibration offsets, persisted as a flat JSON file.
// Typed input and button input travel different client paths, so each gets
// its own offset: { "<userId>": { "button": 120, "typed": 45 } }.
// offset > 0 means the user's inputs arrive late by that many ms on average.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const FILE = join(DATA, "offsets.json");

function load() {
  if (!existsSync(FILE)) return {};
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    // migrate v1 (plain number, measured via buttons) → v2 (per-method)
    for (const [id, v] of Object.entries(raw)) {
      if (typeof v === "number") raw[id] = { button: v };
    }
    return raw;
  } catch {
    return {};
  }
}

function save(all) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(FILE, JSON.stringify(all, null, 2));
}

// method: "button" | "typed"
export function getOffset(userId, method) {
  const u = load()[userId];
  if (!u) return 0;
  // fall back to the other method's value — better than nothing
  return u[method] ?? u.button ?? u.typed ?? 0;
}

export function getOffsets(userId) {
  return load()[userId] ?? {};
}

export function setOffset(userId, method, ms) {
  const all = load();
  all[userId] = { ...all[userId], [method]: Math.round(ms) };
  save(all);
}
