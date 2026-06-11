// Pre-rendered falling-note GIF. The whole chart becomes one play-once GIF:
//   [3s built-in countdown] + [the full song's notes falling to the hit line]
// The bot sends it, waits (COUNTDOWN_MS - estimated client load time), then
// starts the audio — so the GIF's note section begins ≈ when the music does.
// Clients can't be perfectly synced (no control over when they start playing
// a GIF), so this is the *visual* chart; judgment stays on the audio clock.
//
// Rendered once per chart and cached in cache/<name>.gif.

import gifenc from "gifenc"; // CJS package — named exports live on default
const { GIFEncoder } = gifenc;
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./chart.js";
import { drawTextCentered } from "./font.js";

export const COUNTDOWN_MS = 3000; // baked into the head of every GIF
export const FRAME_MS = 80; // 12.5fps → exactly 8cs per GIF frame
const LOOKAHEAD = 1800; // ms of upcoming notes visible above the hit line
const NOTE_H = 12;
const HIT_Y = 256;
const H = 300;
const MAX_RENDER_MS = 150_000; // GIF length cap (file size guard)

const laneWidth = (lanes) =>
  lanes === 1 ? 150 : lanes === 4 ? 56 : Math.floor(224 / lanes);

// palette indices
const BG = 0, SEP = 1, BEAT = 2, MEASURE = 3, HITLINE = 4;
const LANE = 5; // 5..8 note colors,  9..12 bright tops
const PROGRESS = 13, FLASH = 14;

const PALETTE = [
  [14, 16, 22], // BG
  [35, 40, 56], // SEP
  [44, 51, 71], // BEAT
  [71, 80, 105], // MEASURE
  [255, 64, 129], // HITLINE
  [69, 150, 255], [46, 204, 113], [255, 82, 82], [232, 236, 244], // lanes
  [156, 198, 255], [140, 232, 180], [255, 163, 163], [255, 255, 255], // bright
  [255, 213, 79], // PROGRESS
  [255, 255, 255], // FLASH
  [20, 24, 34], // spare
];

function rect(buf, W, x0, y0, w, h, c) {
  const x1 = Math.min(W, x0 + w);
  const y1 = Math.min(H, y0 + h);
  for (let y = Math.max(0, y0); y < y1; y++) {
    buf.fill(c, y * W + Math.max(0, x0), y * W + x1);
  }
}

export function renderChartGif(chart) {
  const lanes = chart.lanes;
  const LANE_W = laneWidth(lanes);
  const W = lanes * LANE_W + (lanes + 1);
  const laneX = (i) => 1 + i * (LANE_W + 1);
  const beatMs = 60000 / chart.bpm;
  const songMs = Math.min(chart.durationMs, MAX_RENDER_MS);
  const totalMs = COUNTDOWN_MS + songMs + 400;
  const frames = Math.ceil(totalMs / FRAME_MS);
  const firstNote = chart.notes[0]?.t ?? 0;

  const gif = GIFEncoder();
  const buf = new Uint8Array(W * H);
  let noteFrom = 0; // sliding index into sorted notes

  for (let f = 0; f < frames; f++) {
    const gifT = f * FRAME_MS;
    const pos = gifT - COUNTDOWN_MS; // song position (negative = countdown)
    buf.fill(BG);

    // lane separators
    for (let i = 0; i <= lanes; i++) rect(buf, W, i * (LANE_W + 1), 0, 1, HIT_Y + 4, SEP);

    const yOf = (t) => HIT_Y - Math.round(((t - pos) / LOOKAHEAD) * HIT_Y);

    // scrolling beat / measure lines
    const fromBeat = Math.max(0, Math.floor(pos / beatMs));
    for (let b = fromBeat; b * beatMs <= pos + LOOKAHEAD; b++) {
      const y = yOf(b * beatMs);
      if (y < 0 || y >= HIT_Y) continue;
      rect(buf, W, 1, y, W - 2, 1, b % 4 === 0 ? MEASURE : BEAT);
    }

    // notes (sorted by t; advance the window start as time passes)
    while (noteFrom < chart.notes.length && chart.notes[noteFrom].t < pos - 300) noteFrom++;
    for (let i = noteFrom; i < chart.notes.length; i++) {
      const n = chart.notes[i];
      if (n.t > pos + LOOKAHEAD) break;
      const bottom = yOf(n.t);
      const top = bottom - NOTE_H;
      if (bottom < 0 || top > HIT_Y + 2) continue;
      const x = laneX(n.lane) + 4;
      rect(buf, W, x, Math.max(0, top), LANE_W - 8, Math.min(bottom, HIT_Y + 2) - Math.max(0, top), LANE + n.lane);
      if (top >= 0) rect(buf, W, x, top, LANE_W - 8, 2, LANE + 4 + n.lane);
    }

    // hit line over everything
    rect(buf, W, 0, HIT_Y, W, 3, HITLINE);

    // key indicators + labels (digits for 4B, TAP for voice mode)
    for (let i = 0; i < lanes; i++) {
      rect(buf, W, laneX(i) + 8, HIT_Y + 9, LANE_W - 16, 16, LANE + i);
      const label = lanes === 1 ? "TAP" : String(i + 1);
      drawTextCentered(buf, W, H, laneX(i) + LANE_W / 2, HIT_Y + 12, label, BG, 2);
    }

    // countdown: READY + blocks 3 → 2 → 1 (one disappears per second)
    if (pos < 0) {
      drawTextCentered(buf, W, H, W / 2, 64, "READY", FLASH, 3);
      const left = Math.ceil(-pos / 1000); // 3, 2, 1
      const bw = 40, gap = 14;
      const x0 = Math.floor((W - (3 * bw + 2 * gap)) / 2);
      for (let i = 0; i < left; i++) {
        rect(buf, W, x0 + i * (bw + gap), 100, bw, bw, FLASH);
      }
    }

    // lead-in beat flash (border pulse on the beats just before the first note)
    if (pos >= 0 && pos < firstNote) {
      const sinceBeat = ((pos % beatMs) + beatMs) % beatMs;
      if (firstNote - pos <= 4 * beatMs + 50 && sinceBeat < 110) {
        rect(buf, W, 0, 0, W, 2, FLASH);
        rect(buf, W, 0, 0, 2, HIT_Y, FLASH);
        rect(buf, W, W - 2, 0, 2, HIT_Y, FLASH);
      }
    }

    // progress bar
    if (pos >= 0) {
      rect(buf, W, 0, H - 4, Math.round((W * pos) / songMs), 3, PROGRESS);
    }

    gif.writeFrame(buf, W, H, {
      palette: PALETTE,
      delay: FRAME_MS,
      repeat: -1, // play once, no loop — freezes on the final frame
    });
  }

  gif.finish();
  return Buffer.from(gif.bytes());
}

// Render-and-cache. Returns the cached gif path.
export function ensureChartGif(chart, chartName) {
  const dir = join(ROOT, "cache");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${chartName}.gif`);
  const fresh =
    existsSync(out) && chart.mtimeMs && statSync(out).mtimeMs >= chart.mtimeMs;
  if (!fresh) writeFileSync(out, renderChartGif(chart));
  return out;
}
