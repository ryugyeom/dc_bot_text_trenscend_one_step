// Generates the demo song (WAV) and THREE difficulty charts (JSON) from one
// source of truth. Difficulties are strict subsets (easy ⊂ normal ⊂ hard) and
// the audio bakes a tone for every note in the *union* (= hard), so every
// chart note is audible on every difficulty.
// Also generates the calibration metronome and pre-bakes opus + GIF caches.
//
// Usage: npm run gen

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const SAMPLE_RATE = 44100;

// ---------- tiny synth ----------

function makeBuffer(durationMs) {
  return new Float32Array(Math.ceil((durationMs / 1000) * SAMPLE_RATE));
}

function addTone(buf, atMs, freq, durMs, gain = 0.5, decay = 18) {
  const start = Math.floor((atMs / 1000) * SAMPLE_RATE);
  const len = Math.floor((durMs / 1000) * SAMPLE_RATE);
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-decay * t);
    buf[start + i] += Math.sin(2 * Math.PI * freq * t) * env * gain;
  }
}

function addKick(buf, atMs, gain = 0.8) {
  const start = Math.floor((atMs / 1000) * SAMPLE_RATE);
  const len = Math.floor(0.12 * SAMPLE_RATE);
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const t = i / SAMPLE_RATE;
    const freq = 150 * Math.exp(-25 * t) + 45; // pitch drop
    const env = Math.exp(-22 * t);
    buf[start + i] += Math.sin(2 * Math.PI * freq * t) * env * gain;
  }
}

function addHat(buf, atMs, gain = 0.18) {
  const start = Math.floor((atMs / 1000) * SAMPLE_RATE);
  const len = Math.floor(0.04 * SAMPLE_RATE);
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-90 * t);
    buf[start + i] += (Math.random() * 2 - 1) * env * gain;
  }
}

function writeWav(path, buf) {
  // normalize to avoid clipping
  let peak = 0;
  for (const s of buf) peak = Math.max(peak, Math.abs(s));
  const scale = peak > 0 ? 0.89 / peak : 1;

  const pcm = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) {
    pcm.writeInt16LE(Math.round(buf[i] * scale * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([header, pcm]));
}

// ---------- demo song + tiered charts ----------

const BPM = 120;
const BEAT = 60000 / BPM; // 500ms
const LEAD_IN = 2000;
const BEATS = 64; // 32s of music

// per-lane pitches (pentatonic-ish so chords sound fine)
const LANE_FREQ = [659.25, 783.99, 880.0, 987.77]; // E5 G5 A5 B5

const TIER = { EASY: 0, NORMAL: 1, HARD: 2 };
const all = []; // { t, lane, tier }

function put(beat, lane, tier) {
  all.push({
    t: Math.round(LEAD_IN + beat * BEAT),
    lane: ((lane % 4) + 4) % 4,
    tier,
  });
}

for (let b = 0; b < BEATS; b++) {
  // easy backbone: a note every 2 beats, lanes sweeping
  if (b % 2 === 0) put(b, Math.floor(b / 2), TIER.EASY);
  // normal: fill the odd beats + an offbeat accent each 4 beats
  else put(b, b * 3, TIER.NORMAL);
  if (b % 4 === 2) put(b + 0.5, b * 3 + 2, TIER.NORMAL);
  // hard: running 8ths from the second half + chords on late downbeats
  else if (b >= 16) put(b + 0.5, b * 5 + 1, TIER.HARD);
  if (b >= 32 && b % 4 === 0) put(b, Math.floor(b / 2) + 1, TIER.HARD);
}
// shared finale: big chord on the last downbeat
put(BEATS - 0.5, 2, TIER.HARD);
put(BEATS, 0, TIER.EASY);
put(BEATS, 3, TIER.NORMAL);

const byTier = (max) =>
  all
    .filter((n) => n.tier <= max)
    .map(({ t, lane }) => ({ t, lane }))
    .sort((a, b) => a.t - b.t || a.lane - b.lane);

const songLenMs = LEAD_IN + (BEATS + 1) * BEAT + 2000;
const song = makeBuffer(songLenMs);

// groove: kick every beat, hat on offbeats (feel only, not notes)
for (let b = 0; b <= BEATS; b++) {
  addKick(song, LEAD_IN + b * BEAT);
  addHat(song, LEAD_IN + (b + 0.5) * BEAT);
}
// lead-in count: 4 ticks so players catch the tempo before beat 0
for (let i = 0; i < 4; i++) addTone(song, i * BEAT, 1318.5, 60, 0.3, 40);

// every union (hard) note gets its own audible tone (lane-pitched)
for (const n of byTier(TIER.HARD)) addTone(song, n.t, LANE_FREQ[n.lane], 180, 0.42, 14);

mkdirSync(join(root, "audio"), { recursive: true });
mkdirSync(join(root, "charts"), { recursive: true });

writeWav(join(root, "audio", "demo.wav"), song);

const CHARTS = [
  ["demo-easy", "First Step (EZ)", 2, TIER.EASY],
  ["demo", "First Step", 5, TIER.NORMAL],
  ["demo-hard", "First Step (HD)", 8, TIER.HARD],
];
for (const [name, title, level, tier] of CHARTS) {
  const notes = byTier(tier);
  writeFileSync(
    join(root, "charts", `${name}.json`),
    JSON.stringify(
      {
        title,
        artist: "gen-demo-audio.js",
        bpm: BPM,
        level,
        lanes: 4,
        audio: "audio/demo.wav",
        durationMs: Math.round(songLenMs),
        notes,
      },
      null,
      2,
    ),
  );
  console.log(`chart          : ${name} (LV.${level}, ${notes.length} notes)`);
}

// ---------- calibration metronome ----------
// 12 ticks, first at 1000ms, 1000ms apart. calibrate.js depends on these numbers.

const TICKS = 12;
const FIRST_TICK = 1000;
const TICK_INTERVAL = 1000;

const met = makeBuffer(FIRST_TICK + TICKS * TICK_INTERVAL + 500);
for (let i = 0; i < TICKS; i++) {
  addTone(met, FIRST_TICK + i * TICK_INTERVAL, 1760, 80, 0.6, 35);
}
writeWav(join(root, "audio", "metronome.wav"), met);

console.log(`demo.wav       : ${(songLenMs / 1000).toFixed(1)}s`);
console.log(`metronome.wav  : ${TICKS} ticks @ ${TICK_INTERVAL}ms (first at ${FIRST_TICK}ms)`);

// ---------- pre-bake playback assets ----------
// opus pre-encode (kills runtime transcode jitter) + falling-note GIF caches

const { ensureOgg } = await import("../src/audio.js");
const { ensureChartGif } = await import("../src/gif.js");
const { loadChart, toVoiceChart } = await import("../src/chart.js");
const { statSync } = await import("node:fs");

for (const wav of ["demo.wav", "metronome.wav"]) {
  const ogg = ensureOgg(join(root, "audio", wav));
  console.log(`opus 인코딩    : ${wav} → ${ogg.replace(root, ".")}`);
}
for (const [name] of CHARTS) {
  const chart = loadChart(name);
  for (const [key, c] of [[name, chart], [`${name}.voice`, toVoiceChart(chart)]]) {
    const t0 = Date.now();
    const gifPath = ensureChartGif(c, key);
    console.log(
      `GIF 렌더       : ${gifPath.replace(root, ".")} (${(statSync(gifPath).size / 1024 / 1024).toFixed(2)}MB, ${Date.now() - t0}ms)`,
    );
  }
}
