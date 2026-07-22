import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifestPath = new URL("../public/manifest.json", import.meta.url);
const backgroundPath = new URL("../public/background.js", import.meta.url);
const contentPath = new URL("../public/content.js", import.meta.url);
const appPath = new URL("../src/App.jsx", import.meta.url);

test("バックグラウンド実行に必要な権限だけを使用する", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.deepEqual(manifest.permissions.sort(), ["activeTab", "alarms", "scripting", "storage"]);
  assert.equal(manifest.permissions.includes("tabs"), false);
});

test("接続エラー時はcontent scriptを注入し直して再試行する", async () => {
  const source = await readFile(backgroundPath, "utf8");
  assert.match(source, /Receiving end does not exist/);
  assert.match(source, /chrome\.scripting\.executeScript/);
});

test("バックグラウンドがアラームで次の曲を処理する", async () => {
  const source = await readFile(backgroundPath, "utf8");
  assert.match(source, /chrome\.alarms\.onAlarm\.addListener/);
  assert.match(source, /chrome\.tabs\.sendMessage\(tabId, \{ type: "PROCESS_ITEM", item: payload \}\)/);
});

test("バックグラウンドがトグル設定から送信内容を組み立てる", async () => {
  const source = await readFile(backgroundPath, "utf8");
  assert.match(source, /settings\.useTitle \? item\.title/);
  assert.match(source, /settings\.styleMode === "perSong" \? item\.style/);
  assert.match(source, /settings\.commonStyle/);
});

test("Suno画面側は1曲単位の処理だけを担当する", async () => {
  const source = await readFile(contentPath, "utf8");
  assert.match(source, /message\.type !== "PROCESS_ITEM"/);
  assert.doesNotMatch(source, /while \(!stopRequested\)/);
});

test("Suno画面側は空欄のタイトル・スタイルを入力しない", async () => {
  const source = await readFile(contentPath, "utf8");
  assert.match(source, /if \(item\.title\)/);
  assert.match(source, /if \(item\.style\)/);
});

test("スタイル検出はExclude Stylesを減点する", async () => {
  const source = await readFile(contentPath, "utf8");
  assert.match(source, /"exclude"/);
});

test("ポップアップはバックグラウンドへ開始命令を送る", async () => {
  const source = await readFile(appPath, "utf8");
  assert.match(source, /chrome\.runtime\.sendMessage/);
  assert.doesNotMatch(source, /chrome\.tabs\.sendMessage/);
});
