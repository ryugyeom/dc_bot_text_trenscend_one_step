import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const FILE = join(DATA, "offsets.json");
const BACKUP = FILE + ".bak";

test("store: per-method offsets + v1 migration", async (t) => {
  if (existsSync(FILE)) renameSync(FILE, BACKUP);
  t.after(() => {
    rmSync(FILE, { force: true });
    if (existsSync(BACKUP)) renameSync(BACKUP, FILE);
  });

  mkdirSync(DATA, { recursive: true });
  // v1 format: plain number (was measured via buttons)
  writeFileSync(FILE, JSON.stringify({ u1: 120 }));

  const { getOffset, setOffset, getOffsets } = await import("../src/store.js");

  assert.equal(getOffset("u1", "button"), 120);
  assert.equal(getOffset("u1", "typed"), 120, "falls back to button value");
  assert.equal(getOffset("nobody", "typed"), 0);

  setOffset("u1", "typed", 45);
  assert.equal(getOffset("u1", "typed"), 45);
  assert.equal(getOffset("u1", "button"), 120, "button offset untouched");
  assert.deepEqual(getOffsets("u1"), { button: 120, typed: 45 });
});
