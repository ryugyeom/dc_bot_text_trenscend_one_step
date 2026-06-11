import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drawText, measureText } from "../src/font.js";
import { toVoiceChart } from "../src/chart.js";
import { renderResultCard } from "../src/resultcard.js";

test("font: drawText paints pixels and respects bounds", () => {
  const W = 40, H = 10;
  const buf = new Uint8Array(W * H);
  drawText(buf, W, H, 1, 1, "A1", 7, 1);
  assert.ok(buf.some((v) => v === 7), "pixels painted");
  // out-of-bounds draw must not throw or corrupt
  drawText(buf, W, H, W - 2, H - 2, "WIDE", 7, 3);
  assert.equal(measureText("AB", 2), 2 * 4 * 2 - 2);
});

test("toVoiceChart merges chords and dense stacks to one lane", () => {
  const chart = {
    lanes: 4,
    title: "T",
    notes: [
      { t: 1000, lane: 0 },
      { t: 1000, lane: 2 }, // chord → merged
      { t: 1080, lane: 1 }, // <120ms → merged
      { t: 1500, lane: 3 },
    ],
  };
  const v = toVoiceChart(chart);
  assert.equal(v.lanes, 1);
  assert.deepEqual(v.notes, [
    { t: 1000, lane: 0 },
    { t: 1500, lane: 0 },
  ]);
  assert.equal(chart.notes.length, 4, "original untouched");
});

test("result card renders a valid single-frame GIF", () => {
  const buf = renderResultCard("First Step", [
    {
      name: "Ryu",
      rank: "S",
      acc: 96.42,
      maxCombo: 88,
      counts: { MAX100: 70, MAX90: 12, MAX70: 4, BREAK: 2 },
      offsetSamples: [-30, -12, 0, 8, 14, 22, 40, -55, 120, -180],
      newRecord: true,
    },
    {
      name: "VeryLongPlayerNameHere",
      rank: "SS",
      acc: 99.1,
      maxCombo: 120,
      counts: { MAX100: 86, MAX90: 2, MAX70: 0, BREAK: 0 },
      offsetSamples: [],
      newRecord: false,
    },
  ]);
  assert.equal(buf.subarray(0, 6).toString("ascii"), "GIF89a");
  assert.ok(buf.length > 500);
});

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const FILE = join(DATA, "records.json");
const BAK = FILE + ".bak";

test("records: keeps only personal bests, sorted board", async (t) => {
  if (existsSync(FILE)) renameSync(FILE, BAK);
  t.after(() => {
    rmSync(FILE, { force: true });
    if (existsSync(BAK)) renameSync(BAK, FILE);
  });
  mkdirSync(DATA, { recursive: true });

  const { submitRecord, getBoard, getBest } = await import("../src/records.js");

  assert.equal(submitRecord("demo", "u1", { name: "A", acc: 90, rank: "A", combo: 50 }), true);
  assert.equal(submitRecord("demo", "u1", { name: "A", acc: 85, rank: "B", combo: 60 }), false, "worse run ignored");
  assert.equal(submitRecord("demo", "u1", { name: "A", acc: 95, rank: "S", combo: 70 }), true, "better run replaces");
  submitRecord("demo", "u2", { name: "B", acc: 97, rank: "S", combo: 80 });
  submitRecord("demo.voice", "u1", { name: "A", acc: 99, rank: "SS", combo: 90 });

  const board = getBoard("demo");
  assert.deepEqual(board.map((e) => e.userId), ["u2", "u1"]);
  assert.equal(getBest("demo", "u1").acc, 95);
  assert.equal(getBoard("demo.voice").length, 1, "voice board separate");
});
