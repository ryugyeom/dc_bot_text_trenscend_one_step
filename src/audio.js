// Audio preparation. Transcoding WAV→Opus *during* playback (ffmpeg pipe +
// JS opus encoder) is the main source of send-side jitter, so we pre-encode
// every chart's audio to Ogg/Opus once and cache it. At play time the bot
// only demuxes — near-zero per-frame CPU, stable 20ms packet cadence.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createReadStream } from "node:fs";
import { createAudioResource, StreamType } from "@discordjs/voice";
import ffmpegPath from "ffmpeg-static";
import { ROOT } from "./chart.js";

const CACHE = join(ROOT, "cache");

// Returns the path to a cached .ogg for the given audio file, encoding it
// if missing or stale. Throws on encode failure.
export function ensureOgg(audioPath) {
  if (/\.(ogg|opus)$/i.test(audioPath)) return audioPath; // already opus

  mkdirSync(CACHE, { recursive: true });
  const out = join(CACHE, basename(audioPath).replace(/\.[^.]+$/, "") + ".ogg");

  const fresh =
    existsSync(out) && statSync(out).mtimeMs >= statSync(audioPath).mtimeMs;
  if (fresh) return out;

  const r = spawnSync(
    ffmpegPath,
    [
      "-y",
      "-i", audioPath,
      "-c:a", "libopus",
      "-b:a", "128k",
      "-ar", "48000",
      "-ac", "2",
      "-frame_duration", "20",
      out,
    ],
    { stdio: "pipe" },
  );
  if (r.status !== 0) {
    throw new Error(`ffmpeg 인코딩 실패: ${r.stderr?.toString().slice(-300)}`);
  }
  return out;
}

export function createPreparedResource(audioPath) {
  const ogg = ensureOgg(audioPath);
  return createAudioResource(createReadStream(ogg), {
    inputType: StreamType.OggOpus,
  });
}
