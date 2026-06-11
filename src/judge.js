// DJMAX-style judgment. Windows are wider than a native client's because the
// remaining jitter (user -> Discord edge) is real, but per-user calibration
// removes the constant part of the delay, so these stay meaningful.

export const JUDGE = {
  MAX100: { window: 110, rate: 100, label: "MAX 100%" },
  MAX90: { window: 180, rate: 90, label: "MAX 90%" },
  MAX70: { window: 260, rate: 70, label: "MAX 70%" },
  BREAK: { window: 350, rate: 0, label: "BREAK" },
};

// past this, a press doesn't consume any note at all
export const CONSUME_WINDOW = JUDGE.BREAK.window;

export function classify(deltaMs) {
  const d = Math.abs(deltaMs);
  if (d <= JUDGE.MAX100.window) return "MAX100";
  if (d <= JUDGE.MAX90.window) return "MAX90";
  if (d <= JUDGE.MAX70.window) return "MAX70";
  if (d <= JUDGE.BREAK.window) return "BREAK";
  return null;
}

export class PlayerState {
  constructor(chart) {
    this.hit = new Array(chart.notes.length).fill(false);
    this.counts = { MAX100: 0, MAX90: 0, MAX70: 0, BREAK: 0 };
    this.combo = 0;
    this.maxCombo = 0;
    this.score = 0; // sum of rates
    this.judged = 0;
    this.lastJudge = null; // { kind, deltaMs }
    this.offsetSamples = []; // deltas of clean hits, for post-game stats
  }

  applyJudge(kind, deltaMs = null) {
    this.counts[kind]++;
    this.judged++;
    this.score += JUDGE[kind].rate;
    if (kind === "BREAK") {
      this.combo = 0;
    } else {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      if (deltaMs !== null) this.offsetSamples.push(deltaMs);
    }
    this.lastJudge = { kind, deltaMs };
  }

  accuracy(totalNotes) {
    const total = totalNotes ?? this.judged;
    return total === 0 ? 0 : this.score / total;
  }
}

// Find + consume the nearest unhit note on `lane` within CONSUME_WINDOW of
// songPosMs. Returns { kind, deltaMs, noteIndex } or null (stray press).
export function judgePress(chart, state, lane, songPosMs) {
  let best = -1;
  let bestDelta = Infinity;
  for (let i = 0; i < chart.notes.length; i++) {
    const n = chart.notes[i];
    if (n.lane !== lane || state.hit[i]) continue;
    if (n.t - songPosMs > CONSUME_WINDOW) break; // notes are sorted by t
    const delta = songPosMs - n.t; // + = late, - = early
    if (Math.abs(delta) <= CONSUME_WINDOW && Math.abs(delta) < Math.abs(bestDelta)) {
      best = i;
      bestDelta = delta;
    }
  }
  if (best === -1) return null;
  state.hit[best] = true;
  const kind = classify(bestDelta);
  state.applyJudge(kind, bestDelta);
  return { kind, deltaMs: bestDelta, noteIndex: best };
}

// Mark every note whose window has fully passed as BREAK (a miss).
export function sweepMisses(chart, state, songPosMs) {
  let missed = 0;
  for (let i = 0; i < chart.notes.length; i++) {
    if (state.hit[i]) continue;
    if (chart.notes[i].t >= songPosMs - CONSUME_WINDOW) break;
    state.hit[i] = true;
    state.applyJudge("BREAK");
    missed++;
  }
  return missed;
}

export function rank(accuracyPct) {
  if (accuracyPct >= 98) return "SS";
  if (accuracyPct >= 95) return "S";
  if (accuracyPct >= 90) return "A";
  if (accuracyPct >= 80) return "B";
  if (accuracyPct >= 70) return "C";
  return "F";
}
