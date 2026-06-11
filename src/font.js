// Tiny 3x5 bitmap font for pixel rendering (GIF/result cards).
// Each glyph is 5 rows × 3 cols, encoded as strings ("1" = pixel on).

const GLYPHS = {
  0: "111 101 101 101 111",
  1: "010 110 010 010 111",
  2: "111 001 111 100 111",
  3: "111 001 011 001 111",
  4: "101 101 111 001 001",
  5: "111 100 111 001 111",
  6: "111 100 111 101 111",
  7: "111 001 001 010 010",
  8: "111 101 111 101 111",
  9: "111 101 111 001 111",
  A: "010 101 111 101 101",
  B: "110 101 110 101 110",
  C: "011 100 100 100 011",
  D: "110 101 101 101 110",
  E: "111 100 110 100 111",
  F: "111 100 110 100 100",
  G: "011 100 101 101 011",
  H: "101 101 111 101 101",
  I: "111 010 010 010 111",
  J: "001 001 001 101 010",
  K: "101 110 100 110 101",
  L: "100 100 100 100 111",
  M: "101 111 111 101 101",
  N: "110 101 101 101 101",
  O: "010 101 101 101 010",
  P: "110 101 110 100 100",
  Q: "010 101 101 110 011",
  R: "110 101 110 110 101",
  S: "011 100 010 001 110",
  T: "111 010 010 010 010",
  U: "101 101 101 101 111",
  V: "101 101 101 101 010",
  W: "101 101 111 111 101",
  X: "101 101 010 101 101",
  Y: "101 101 010 010 010",
  Z: "111 001 010 100 111",
  "%": "101 001 010 100 101",
  "+": "000 010 111 010 000",
  "-": "000 000 111 000 000",
  ".": "000 000 000 000 010",
  ":": "000 010 000 010 000",
  "!": "010 010 010 000 010",
  "/": "001 001 010 100 100",
  "×": "000 101 010 101 000",
  " ": "000 000 000 000 000",
};

const parsed = Object.fromEntries(
  Object.entries(GLYPHS).map(([ch, s]) => [ch, s.split(" ")]),
);

export const CHAR_W = 3;
export const CHAR_H = 5;

// width of `text` at `scale` (1px letter-spacing per char)
export function measureText(text, scale = 1) {
  return text.length * (CHAR_W + 1) * scale - scale;
}

export function drawText(buf, W, H, x, y, text, color, scale = 1) {
  let cx = x;
  for (const raw of String(text).toUpperCase()) {
    const g = parsed[raw] ?? parsed[" "];
    for (let r = 0; r < CHAR_H; r++) {
      for (let c = 0; c < CHAR_W; c++) {
        if (g[r][c] !== "1") continue;
        for (let dy = 0; dy < scale; dy++) {
          const py = y + r * scale + dy;
          if (py < 0 || py >= H) continue;
          const rowBase = py * W;
          for (let dx = 0; dx < scale; dx++) {
            const px = cx + c * scale + dx;
            if (px >= 0 && px < W) buf[rowBase + px] = color;
          }
        }
      }
    }
    cx += (CHAR_W + 1) * scale;
  }
  return cx;
}

export function drawTextCentered(buf, W, H, cx, y, text, color, scale = 1) {
  return drawText(buf, W, H, Math.round(cx - measureText(text, scale) / 2), y, text, color, scale);
}

// Strip characters the font can't draw (e.g. Korean nicknames); if nothing
// drawable remains, use the fallback.
export function sanitizeText(text, fallback) {
  const kept = [...String(text).toUpperCase()]
    .filter((ch) => ch in parsed && ch !== " ")
    .join("");
  return kept.length >= 2 ? kept : fallback;
}
