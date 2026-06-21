import test from "node:test";
import assert from "node:assert/strict";
import { parsePromptText, summarizeQueue } from "../src/parser.js";

test("1行ごとのプロンプトを読み取る", () => {
  const result = parsePromptText("city pop instrumental\nslow rainy jazz");
  assert.equal(result.length, 2);
  assert.equal(result[0].prompt, "city pop instrumental");
  assert.equal(result[0].title, "曲 1");
});

test("見出し付きCSVを読み取る", () => {
  const result = parsePromptText('曲名,プロンプト\nNeon Morning,"80s city pop, warm bass"');
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Neon Morning");
  assert.equal(result[0].prompt, "80s city pop, warm bass");
});

test("引用符内の改行とカンマを維持する", () => {
  const result = parsePromptText('Rain,"slow jazz,\nrain sounds"');
  assert.equal(result[0].prompt, "slow jazz,\nrain sounds");
});

test("状態を集計する", () => {
  const summary = summarizeQueue([{ status: "complete" }, { status: "waiting" }, { status: "failed" }]);
  assert.deepEqual(summary, { waiting: 1, processing: 0, complete: 1, failed: 1 });
});
