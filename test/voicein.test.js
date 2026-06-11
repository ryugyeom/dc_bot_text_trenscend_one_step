import test from "node:test";
import assert from "node:assert/strict";
import { OnsetDetector, rmsInt16 } from "../src/voicein.js";

test("rmsInt16 measures PCM energy", () => {
  const silent = Buffer.alloc(1920 * 2);
  assert.equal(rmsInt16(silent), 0);

  const loud = Buffer.alloc(1920 * 2);
  for (let i = 0; i < 1920; i++) loud.writeInt16LE(i % 2 ? 10000 : -10000, i * 2);
  assert.ok(Math.abs(rmsInt16(loud) - 10000) < 1);
});

test("onset fires once per attack, blocked by refractory", () => {
  const det = new OnsetDetector({ floor: 700, ratio: 4, refractoryMs: 160 });
  let t = 0;
  const feed = (rms) => det.feed(rms, (t += 20)); // 20ms frames

  // ambient noise — no hits, noise floor adapts
  for (let i = 0; i < 25; i++) assert.equal(feed(100), false);

  assert.equal(feed(8000), true, "clap triggers");
  assert.equal(feed(7000), false, "decay tail inside refractory ignored");
  assert.equal(feed(6000), false);

  // wait out the refractory in near-silence
  for (let i = 0; i < 20; i++) feed(50);
  assert.equal(feed(9000), true, "next tap triggers again");
});

test("loud steady noise does not retrigger forever", () => {
  const det = new OnsetDetector({ floor: 700, ratio: 4, refractoryMs: 160 });
  let t = 0;
  const feed = (rms) => det.feed(rms, (t += 20));

  for (let i = 0; i < 10; i++) feed(80);
  assert.equal(feed(5000), true, "onset of sustained sound");

  // sustained hum: noise EMA catches up, ratio gate closes
  let extra = 0;
  for (let i = 0; i < 200; i++) if (feed(5000)) extra++;
  assert.ok(extra <= 2, `sustained tone retriggered ${extra} times`);
});
