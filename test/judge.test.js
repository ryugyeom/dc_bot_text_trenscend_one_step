import test from "node:test";
import assert from "node:assert/strict";
import { snowflakeToMs, msToSnowflake } from "../src/snowflake.js";
import { classify, judgePress, sweepMisses, PlayerState, rank } from "../src/judge.js";

test("snowflake round-trips a timestamp", () => {
  const now = Date.now();
  assert.equal(snowflakeToMs(msToSnowflake(now)), now);
});

test("snowflake decodes a known real ID", () => {
  // Discord's documented example: ID 175928847299117063 → 2016-04-30T11:18:25.796Z
  assert.equal(snowflakeToMs("175928847299117063"), Date.parse("2016-04-30T11:18:25.796Z"));
});

test("classify maps deltas to DJMAX windows", () => {
  assert.equal(classify(0), "MAX100");
  assert.equal(classify(-110), "MAX100");
  assert.equal(classify(111), "MAX90");
  assert.equal(classify(-200), "MAX70");
  assert.equal(classify(300), "BREAK");
  assert.equal(classify(400), null);
});

function chartOf(notes) {
  return { lanes: 4, notes: notes.sort((a, b) => a.t - b.t) };
}

test("judgePress consumes the nearest note in the lane only", () => {
  const chart = chartOf([
    { t: 1000, lane: 0 },
    { t: 1300, lane: 0 },
    { t: 1000, lane: 1 },
  ]);
  const s = new PlayerState(chart);

  const r = judgePress(chart, s, 0, 1050); // 50ms late on the first lane-0 note
  assert.equal(r.kind, "MAX100");
  assert.equal(r.deltaMs, 50);

  // same press again must hit the NEXT lane-0 note (first one is consumed)
  const r2 = judgePress(chart, s, 0, 1100);
  assert.equal(r2.deltaMs, -200); // 1300 - 1100 early
  assert.equal(r2.kind, "MAX70");

  // lane 1 untouched
  const r3 = judgePress(chart, s, 1, 1000);
  assert.equal(r3.kind, "MAX100");
  assert.equal(s.combo, 3);
});

test("stray press far from any note consumes nothing", () => {
  const chart = chartOf([{ t: 5000, lane: 2 }]);
  const s = new PlayerState(chart);
  assert.equal(judgePress(chart, s, 2, 1000), null);
  assert.equal(s.judged, 0);
});

test("sweepMisses breaks combo and judges passed notes", () => {
  const chart = chartOf([
    { t: 1000, lane: 0 },
    { t: 2000, lane: 1 },
    { t: 9000, lane: 2 },
  ]);
  const s = new PlayerState(chart);
  judgePress(chart, s, 0, 1010);
  assert.equal(s.combo, 1);

  const missed = sweepMisses(chart, s, 5000); // note@2000 long gone, note@9000 future
  assert.equal(missed, 1);
  assert.equal(s.combo, 0);
  assert.equal(s.counts.BREAK, 1);
  assert.equal(s.judged, 2);
});

test("accuracy and rank", () => {
  const chart = chartOf([
    { t: 1000, lane: 0 },
    { t: 2000, lane: 0 },
  ]);
  const s = new PlayerState(chart);
  judgePress(chart, s, 0, 1000); // 100
  judgePress(chart, s, 0, 2150); // 90
  assert.equal(s.accuracy(2), 95);
  assert.equal(rank(95), "S");
  assert.equal(rank(98), "SS");
  assert.equal(rank(10), "F");
});
