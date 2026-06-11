import test from "node:test";
import assert from "node:assert/strict";
import { SongClock } from "../src/clock.js";
import { msToSnowflake } from "../src/snowflake.js";

test("atSnowflake maps a press onto the playback timeline", () => {
  const clock = new SongClock();
  clock.attach({ playbackDuration: 10_000 }); // 10s of audio dispatched

  // a press Discord received 150ms ago should land at 10_000 - 150
  const id = msToSnowflake(Date.now() - 150);
  const pos = clock.atSnowflake(id);
  assert.ok(Math.abs(pos - 9850) <= 3, `expected ≈9850, got ${pos}`);
});

test("clock not started until audio actually dispatched", () => {
  const clock = new SongClock();
  assert.equal(clock.started, false);
  clock.attach({ playbackDuration: 0 });
  assert.equal(clock.started, false);
  clock.attach({ playbackDuration: 20 });
  assert.equal(clock.started, true);
});
