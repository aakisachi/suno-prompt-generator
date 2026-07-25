import test from "node:test";
import assert from "node:assert/strict";
import { parsePromptText, migrateItem, summarizeQueue } from "../src/parser.js";

test("1行ごとのリリックを読み取る", () => {
  const result = parsePromptText("city pop instrumental\nslow rainy jazz", { multilinePerSong: false });
  assert.equal(result.length, 2);
  assert.equal(result[0].lyrics, "city pop instrumental");
  assert.equal(result[0].title, "");
  assert.equal(result[0].style, "");
});

test("タイトルありの2列CSVを読み取る", () => {
  const result = parsePromptText('Neon Morning,"80s city pop, warm bass"', { useTitle: true, multilinePerSong: false });
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Neon Morning");
  assert.equal(result[0].lyrics, "80s city pop, warm bass");
});

test("タイトル+曲ごとスタイルの3列CSVを読み取る", () => {
  const result = parsePromptText(
    'Neon Morning,"80s city pop, warm bass","[Verse] walking down the street"',
    { useTitle: true, styleMode: "perSong", multilinePerSong: false },
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
  const result = parsePromptText('"slow jazz,\nrain sounds"', { multilinePerSong: false });
  assert.equal(result[0].lyrics, "slow jazz,\nrain sounds");
});

test("空行とカンマを含む長文プロンプトは既定で1曲になる", () => {
  const text = [
    "[Instrumental].",
    "",
    "Slow modern morning cafe bossa nova. 58–64 BPM.",
    "",
    "Use warm nylon-string acoustic guitar, soft Fender Rhodes, mellow upright bass.",
    "No vocals. No lyrics. No saxophone lead.",
  ].join("\n");
  const result = parsePromptText(text);
  assert.equal(result.length, 1);
  assert.equal(result[0].lyrics, text);
});

test("multilinePerSongをオフにすると1行1曲へ戻る", () => {
  const result = parsePromptText("line one\nline two\nline three", { multilinePerSong: false });
  assert.equal(result.length, 3);
});

test("1曲扱いでも「---」があれば曲を分割する", () => {
  const result = parsePromptText("first song\nsecond line\n---\nanother song");
  assert.equal(result.length, 2);
  assert.equal(result[0].lyrics, "first song\nsecond line");
  assert.equal(result[1].lyrics, "another song");
});

test("1曲扱いでも見出し付きCSVは列名で分割する", () => {
  const result = parsePromptText('スタイル,リリック\n"lofi, chill","night drive"\n"jazz","rain"');
  assert.equal(result.length, 2);
  assert.equal(result[0].style, "lofi, chill");
});

test("新規itemはrepeat=1, done=0を持つ", () => {
  const [item] = parsePromptText("city pop");
  assert.equal(item.repeat, 1);
  assert.equal(item.done, 0);
});

test("旧データのpromptをlyricsへ移行し、repeat/doneを補完する", () => {
  const migrated = migrateItem({ id: "a", title: "曲 1", prompt: "city pop", status: "waiting" });
  assert.equal(migrated.lyrics, "city pop");
  assert.equal(migrated.style, "");
  assert.equal(migrated.repeat, 1);
  assert.equal(migrated.done, 0);
  assert.equal("prompt" in migrated, false);
});

test("状態を集計する", () => {
  const summary = summarizeQueue([{ status: "complete" }, { status: "waiting" }, { status: "failed" }]);
  assert.deepEqual(summary, { waiting: 1, processing: 0, complete: 1, failed: 1 });
});
