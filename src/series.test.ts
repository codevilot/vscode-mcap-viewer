import { test } from "node:test";
import * as assert from "node:assert/strict";
import { absBigint, nearestTimestampIndex, remapPositions } from "./series";

test("nearestTimestampIndex picks the closest sample", () => {
  const timestamps = [10n, 20n, 35n, 50n];
  assert.equal(nearestTimestampIndex(timestamps, 8n), 0);
  assert.equal(nearestTimestampIndex(timestamps, 22n), 1);
  assert.equal(nearestTimestampIndex(timestamps, 33n), 2);
  assert.equal(nearestTimestampIndex(timestamps, 49n), 3);
});

test("remapPositions aligns values by joint name", () => {
  const canonical = ["left", "right", "gripper"];
  const sampleNames = ["right", "left"];
  const sample = [2, 1];
  const remapped = remapPositions(canonical, sampleNames, sample);
  assert.deepEqual(remapped.slice(0, 2), [1, 2]);
  assert.equal(Number.isNaN(remapped[2]), true);
});

test("absBigint returns positive magnitude", () => {
  assert.equal(absBigint(-42n), 42n);
  assert.equal(absBigint(42n), 42n);
});
