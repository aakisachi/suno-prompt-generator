import test from "node:test";
import assert from "node:assert/strict";
import { parsePromptText, migrateItem, summarizeQueue } from "../src/parser.js";

test("1行ごとのリリックを読み取る", () => {
  const result = parsePromptText("city pop instrumental\nslow rainy jazz");
  assert.equal(result.length, 2);
  assert.equal(result[0].lyrics, "city pop instrumental");
  assert.equal(result[0].title, "");
  assert.equal(result[0].style, "");
});

test("タイトルありの2列CSVを読み取る", () => {
  const result = parsePromptText('Neon Morning,"80s city pop, warm bass"', { useTitle: true });
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Neon Morning");
  assert.equal(result[0].lyrics, "80s city pop, warm bass");
});

test("タイトル+曲ごとスタイルの3列CSVを読み取る", () => {
  const result = parsePromptText(
    'Neon Morning,"80s city pop, warm bass","[Verse] walking down the street"',
    { useTitle: true, styleMode: "perSong" },
  );
  assert.equal(result[0].title, "Neon Morning");
  assert.equal(result[0].style, "80s city pop, warm bass");
  assert.equal(result[0].lyrics, "[Verse] walking down the street");
});

test("見出し付きCSVは列名で判定する", () => {
  const result = parsePromptText('スタイル,リリック\n"lofi, chill","night drive"');
  assert.equal(result[0].style, "lofi, chill");
  assert.equal(result[0].lyrics, "night drive");
});

test("旧形式（曲名,プロンプト）の見出し付きCSVも読み取る", () => {
  const result = parsePromptText('曲名,プロンプト\nNeon Morning,"80s city pop, warm bass"');
  assert.equal(result[0].title, "Neon Morning");
  assert.equal(result[0].lyrics, "80s city pop, warm bass");
});

test("---区切りのブロック形式で複数行リリックを読み取る", () => {
  const text = [
    "タイトル: 朝のネオン",
    "スタイル: 80s city pop, warm bass",
    "リリック:",
    "[Verse]",
    "街を歩く",
    "---",
    "title: Second Song",
    "lyrics: single line",
  ].join("\n");
  const result = parsePromptText(text);
  assert.equal(result.length, 2);
  assert.equal(result[0].title, "朝のネオン");
  assert.equal(result[0].style, "80s city pop, warm bass");
  assert.equal(result[0].lyrics, "[Verse]\n街を歩く");
  assert.equal(result[1].title, "Second Song");
  assert.equal(result[1].lyrics, "single line");
});

test("引用符内の改行とカンマを維持する", () => {
  const result = parsePromptText('"slow jazz,\nrain sounds"');
  assert.equal(result[0].lyrics, "slow jazz,\nrain sounds");
});

test("旧データのpromptをlyricsへ移行する", () => {
  const migrated = migrateItem({ id: "a", title: "曲 1", prompt: "city pop", status: "waiting" });
  assert.equal(migrated.lyrics, "city pop");
  assert.equal(migrated.style, "");
  assert.equal("prompt" in migrated, false);
});

test("状態を集計する", () => {
  const summary = summarizeQueue([{ status: "complete" }, { status: "waiting" }, { status: "failed" }]);
  assert.deepEqual(summary, { waiting: 1, processing: 0, complete: 1, failed: 1 });
});
