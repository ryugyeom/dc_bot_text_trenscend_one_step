// DJMAX-style result card, rendered pixel-by-pixel into a single-frame GIF:
// big rank letter, accuracy, max combo, judgment distribution bar, and an
// early/late timing histogram per player.

import gifenc from "gifenc";
const { GIFEncoder } = gifenc;
import { drawText, drawTextCentered, measureText, sanitizeText } from "./font.js";
import { JUDGE } from "./judge.js";

const W = 520;
const HEADER_H = 46;
const PLAYER_H = 118;
const FOOTER_H = 18;

// palette indices
const BG = 0, PANEL = 1, LINE = 2, TEXT = 3, DIM = 4;
const C100 = 5, C90 = 6, C70 = 7, CBRK = 8;
const EARLY = 9, LATE = 10, GOLD = 11, PINK = 12;

const PALETTE = [
  [13, 15, 21], // BG
  [22, 26, 38], // PANEL
  [48, 54, 74], // LINE
  [235, 238, 245], // TEXT
  [120, 128, 152], // DIM
  [69, 150, 255], // MAX100
  [46, 204, 113], // MAX90
  [255, 196, 60], // MAX70
  [255, 82, 82], // BREAK
  [86, 156, 255], // early
  [255, 120, 90], // late
  [255, 213, 79], // gold
  [255, 64, 129], // pink
];

const RANK_COLOR = { SS: GOLD, S: GOLD, A: C100, B: C90, C: C70, F: CBRK };

function rect(buf, x0, y0, w, h, c, height) {
  const x1 = Math.min(W, x0 + w);
  const y1 = Math.min(height, y0 + h);
  for (let y = Math.max(0, y0); y < y1; y++) {
    buf.fill(c, y * W + Math.max(0, x0), y * W + x1);
  }
}

// players: [{ name, rank, acc, maxCombo, counts, offsetSamples, newRecord }]
export function renderResultCard(title, players) {
  const rows = players.slice(0, 4);
  const H = HEADER_H + rows.length * PLAYER_H + FOOTER_H;
  const buf = new Uint8Array(W * H).fill(BG);

  // header
  rect(buf, 0, 0, W, HEADER_H - 8, PANEL, H);
  rect(buf, 0, HEADER_H - 8, W, 2, PINK, H);
  drawText(buf, W, H, 14, 9, "RESULT", PINK, 2);
  const t = title.length > 30 ? title.slice(0, 29) + "." : title;
  drawText(buf, W, H, 14, 27, t, TEXT, 2);

  rows.forEach((p, i) => {
    const top = HEADER_H + i * PLAYER_H;
    rect(buf, 8, top + 6, W - 16, PLAYER_H - 12, PANEL, H);

    // rank letter block
    const rankCol = RANK_COLOR[p.rank] ?? TEXT;
    drawTextCentered(buf, W, H, 56, top + 26, p.rank, rankCol, p.rank.length > 1 ? 8 : 12);

    // name / acc / combo (non-latin nicknames fall back to PLAYER N)
    let name = sanitizeText(p.name, `PLAYER ${i + 1}`);
    if (name.length > 14) name = name.slice(0, 13) + ".";
    drawText(buf, W, H, 112, top + 16, name, TEXT, 2);
    if (p.newRecord) {
      const nx = 112 + measureText(name, 2) + 10;
      drawText(buf, W, H, nx, top + 16, "NEW RECORD!", GOLD, 2);
    }
    drawText(buf, W, H, 112, top + 32, `${p.acc.toFixed(2)}%`, TEXT, 3);
    drawText(buf, W, H, 112 + measureText(`${p.acc.toFixed(2)}%`, 3) + 14, top + 37, `MAX COMBO ${p.maxCombo}`, DIM, 2);

    // judgment distribution bar
    const total = Object.values(p.counts).reduce((a, b) => a + b, 0) || 1;
    const barX = 112, barY = top + 60, barW = 300;
    let x = barX;
    for (const [kind, col] of [["MAX100", C100], ["MAX90", C90], ["MAX70", C70], ["BREAK", CBRK]]) {
      const w = Math.round((p.counts[kind] / total) * barW);
      if (w > 0) rect(buf, x, barY, w, 10, col, H);
      x += w;
    }
    rect(buf, barX, barY, barW, 1, LINE, H);
    drawText(
      buf, W, H, barX, barY + 14,
      `100:${p.counts.MAX100} 90:${p.counts.MAX90} 70:${p.counts.MAX70} BR:${p.counts.BREAK}`,
      DIM, 1,
    );

    // timing histogram: 14 bins over ±350ms, early left / late right
    const hx = 112, hy = top + 84, hw = 300, hh = 24;
    const bins = new Array(14).fill(0);
    for (const d of p.offsetSamples) {
      const b = Math.floor((d + 350) / 50);
      if (b >= 0 && b < 14) bins[b]++;
    }
    const peak = Math.max(1, ...bins);
    const bw = hw / 14;
    bins.forEach((v, b) => {
      if (v === 0) return;
      const bh = Math.max(1, Math.round((v / peak) * hh));
      rect(buf, Math.round(hx + b * bw) + 1, hy + hh - bh, Math.floor(bw) - 2, bh, b < 7 ? EARLY : LATE, H);
    });
    rect(buf, hx, hy + hh, hw, 1, LINE, H);
    rect(buf, hx + hw / 2, hy, 1, hh, DIM, H); // center = on-time
    drawText(buf, W, H, hx - 0, hy + hh + 4, "EARLY", DIM, 1);
    drawText(buf, W, H, hx + hw - measureText("LATE", 1), hy + hh + 4, "LATE", DIM, 1);

    // per-row average timing
    const avg = p.offsetSamples.length
      ? p.offsetSamples.reduce((a, b) => a + b, 0) / p.offsetSamples.length
      : null;
    if (avg !== null) {
      const s = `${avg > 0 ? "+" : ""}${Math.round(avg)}MS`;
      drawTextCentered(buf, W, H, hx + hw / 2, hy + hh + 4, s, TEXT, 1);
    }
  });

  drawTextCentered(buf, W, H, W / 2, H - FOOTER_H + 5, "DJMAX DISCORD", DIM, 1);

  const gif = GIFEncoder();
  gif.writeFrame(buf, W, H, { palette: PALETTE, delay: 0, repeat: -1 });
  gif.finish();
  return Buffer.from(gif.bytes());
}
