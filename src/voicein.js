// Voice receive as a game controller — the only user→bot channel in Discord
// that travels over UDP/RTP instead of HTTP. Two signals, merged:
//
//   1. speaking start — fires the instant a user begins transmitting.
//      For push-to-talk users, tapping the PTT key IS a key press.
//   2. amplitude onsets — each user's opus stream is decoded live and a
//      sudden energy rise over the noise floor counts as a hit. Lets
//      voice-activity users clap / tap the desk / say "ta" per note.
//
// Latency is ~30-80ms with far less jitter than interactions, and the
// constant part is absorbed by /calibrate (method: "voice").

import prism from "prism-media";
import { EndBehaviorType } from "@discordjs/voice";

const HIT_REFRACTORY = 160; // ms — one hit per tap, shared across both signals

// Pure, testable onset detector over per-frame RMS values (20ms frames).
export class OnsetDetector {
  constructor({ floor = 700, ratio = 4, refractoryMs = 160 } = {}) {
    this.floor = floor;
    this.ratio = ratio;
    this.refractoryMs = refractoryMs;
    this.noise = 0; // EMA of recent non-hit energy
    this.lastHit = -Infinity;
  }

  // returns true exactly once per percussive attack
  feed(rms, nowMs) {
    const inRefractory = nowMs - this.lastHit < this.refractoryMs;
    const trig = !inRefractory && rms > this.floor && rms > this.noise * this.ratio;
    if (trig) this.lastHit = nowMs;
    // adapt on EVERY frame: sustained sound (talking, humming) raises the
    // floor inside the refractory window, so it can't machine-gun hits —
    // only fresh attacks over the current floor trigger
    this.noise = this.noise * 0.9 + rms * 0.1;
    return trig;
  }
}

export function rmsInt16(pcm) {
  // pcm: Buffer of interleaved s16le samples
  const n = pcm.length >> 1;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i << 1);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

export class VoiceInput {
  // onHit(userId, epochMs, kind: "ptt" | "onset")
  constructor(connection, onHit) {
    this.connection = connection;
    this.onHit = onHit;
    this.streams = new Map(); // userId -> { opus, decoder }
    this.detectors = new Map();
    this.lastHit = new Map();
    this.onSpeakStart = (userId) => {
      this.hit(userId, "ptt");
      this.ensureStream(userId);
    };
    this.stopped = false;
  }

  start() {
    this.connection.receiver.speaking.on("start", this.onSpeakStart);
  }

  hit(userId, kind) {
    const now = Date.now();
    if (now - (this.lastHit.get(userId) ?? -Infinity) < HIT_REFRACTORY) return;
    this.lastHit.set(userId, now);
    try {
      this.onHit(userId, now, kind);
    } catch {}
  }

  ensureStream(userId) {
    if (this.stopped || this.streams.has(userId)) return;
    const receiver = this.connection.receiver;
    const opus = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    opus.pipe(decoder);

    let det = this.detectors.get(userId);
    if (!det) {
      det = new OnsetDetector();
      this.detectors.set(userId, det);
    }
    decoder.on("data", (pcm) => {
      if (det.feed(rmsInt16(pcm), Date.now())) this.hit(userId, "onset");
    });

    const cleanup = () => {
      this.streams.delete(userId);
      decoder.removeAllListeners("data");
      try { decoder.destroy(); } catch {}
    };
    opus.once("end", cleanup);
    opus.once("error", cleanup);
    decoder.once("error", () => {});

    this.streams.set(userId, { opus, decoder });
  }

  stop() {
    this.stopped = true;
    try {
      this.connection.receiver.speaking.off("start", this.onSpeakStart);
    } catch {}
    for (const { opus, decoder } of this.streams.values()) {
      try { opus.destroy(); } catch {}
      try { decoder.destroy(); } catch {}
    }
    this.streams.clear();
  }
}
