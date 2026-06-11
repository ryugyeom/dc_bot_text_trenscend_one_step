import test from "node:test";
import assert from "node:assert/strict";
import { renderChartGif, FRAME_MS } from "../src/gif.js";

const tinyChart = {
  lanes: 4,
  bpm: 120,
  durationMs: 4000,
  notes: [
    { t: 2000, lane: 0 },
    { t: 2500, lane: 1 },
    { t: 3000, lane: 2 },
    { t: 3000, lane: 3 },
  ],
};

test("renders a valid GIF89a", () => {
  const buf = renderChartGif(tinyChart);
  assert.equal(buf.subarray(0, 6).toString("ascii"), "GIF89a");
  assert.ok(buf.length > 1000, "has actual frame data");
});

test("plays once — no NETSCAPE loop extension", () => {
  const buf = renderChartGif(tinyChart);
  assert.equal(buf.includes(Buffer.from("NETSCAPE2.0", "ascii")), false);
});

test("frame delay is exact (no cumulative drift from rounding)", () => {
  const buf = renderChartGif(tinyChart);
  // first Graphic Control Extension: 0x21 0xF9 0x04 <packed> <delay u16le> ...
  const i = buf.indexOf(Buffer.from([0x21, 0xf9, 0x04]));
  assert.notEqual(i, -1, "GCE present");
  const delayCs = buf.readUInt16LE(i + 4);
  assert.equal(delayCs, FRAME_MS / 10, `delay should be ${FRAME_MS}ms in centiseconds`);
  assert.equal((FRAME_MS / 10) % 1, 0, "FRAME_MS must be a whole centisecond");
});
