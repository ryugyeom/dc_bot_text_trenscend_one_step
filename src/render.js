// Text rendering for the playfield. Message edits are rate-limited (~1/sec
// sustained), so this is a periodic *guide* — the voice channel audio is the
// real timing reference. Notes "fall" toward the NOW line at the bottom.

import { JUDGE } from "./judge.js";

const ROWS = 8;
const ROW_MS = 500;

export function renderField(chart, songPosMs) {
  const lanes = chart.lanes;
  const lines = [];
  lines.push("  " + Array.from({ length: lanes }, (_, i) => ` ${i + 1} `).join(""));
  lines.push(" ┌" + "───".repeat(lanes) + "┐");
  for (let r = 0; r < ROWS; r++) {
    const from = songPosMs + (ROWS - 1 - r) * ROW_MS;
    const to = from + ROW_MS;
    const cells = new Array(lanes).fill(" · ");
    for (const n of chart.notes) {
      if (n.t >= from && n.t < to) cells[n.lane] = " ● ";
      if (n.t >= to) break;
    }
    lines.push(" │" + cells.join("") + "│");
  }
  lines.push(" ╞" + "═══".repeat(lanes) + "╡ ◀ NOW");
  return lines.join("\n");
}

export function renderProgress(durationMs, songPosMs) {
  const ratio = Math.min(1, Math.max(0, songPosMs / durationMs));
  const filled = Math.round(ratio * 14);
  const bar = "▰".repeat(filled) + "▱".repeat(14 - filled);
  return `${bar}  ${fmtTime(songPosMs)} / ${fmtTime(durationMs)}`;
}

export function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function scoreboardLine(name, state, totalNotes) {
  const acc = state.accuracy(state.judged).toFixed(1);
  const last = state.lastJudge ? JUDGE[state.lastJudge.kind].label : "—";
  const comboTxt = state.combo > 0 ? `${state.combo} COMBO` : "—";
  return `**${name}** · ${acc}% · ${comboTxt} · 최근: ${last}`;
}

export function judgeBreakdown(state) {
  const c = state.counts;
  return `MAX100 ×${c.MAX100} | MAX90 ×${c.MAX90} | MAX70 ×${c.MAX70} | BREAK ×${c.BREAK}`;
}
