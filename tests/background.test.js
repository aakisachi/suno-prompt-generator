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

test("繰り返し生成: doneを進め、repeat回に達するまで待機へ戻す", async () => {
  const source = await readFile(backgroundPath, "utf8");
  assert.match(source, /const done = \(target\.done \|\| 0\) \+ 1/);
  assert.match(source, /done >= targetRepeat/);
  assert.match(source, /isFullyDone \? "complete" : "waiting"/);
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

test("スタイル検出はExclude Styles/スタイルを除外を候補から外す", async () => {
  const source = await readFile(contentPath, "utf8");
  assert.match(source, /"exclude"/);
  assert.match(source, /"除外"/);
});

test("Suno v6の作成フォーム専用欄を別の編集パネルより優先する", async () => {
  const source = await readFile(contentPath, "utf8");
  assert.match(source, /aria-label=\"歌詞エディタ\"/);
  assert.match(source, /aria-label=\"Lyrics editor\" i/);
  assert.match(source, /data-testid=\"create-form-styles-wrapper\"/);
});

test("日本語UIの要素名（歌詞エディタ・スタイル・曲名）に対応する", async () => {
  const source = await readFile(contentPath, "utf8");
  assert.match(source, /lyrics\|歌詞\|リリック/);
  assert.match(source, /styles\?\|スタイル/);
  assert.match(source, /曲名\|タイトル/);
  assert.match(source, /include: \["title", "タイトル", "曲名"\]/);
});

test("英語UIの要素名も引き続き検出できる", async () => {
  const source = await readFile(contentPath, "utf8");
  assert.match(source, /"lyrics", "lyric"/);
  assert.match(source, /include: \["style", "styles", "スタイル"\]/);
  assert.match(source, /\(song \)\?title/);
});

test("作成/Createボタンはworkspace等の別ボタンを除外する", async () => {
  const source = await readFile(contentPath, "utf8");
  assert.match(source, /CREATE_EXACT = \/\^\(create\|生成\|作成\)\$\/i/);
  assert.match(source, /CREATE_EXCLUDE[\s\S]{0,120}workspace/);
  assert.match(source, /CREATE_EXCLUDE[\s\S]{0,120}ワークスペース/);
  assert.match(source, /create song\|曲を作成\|曲を生成/);
});

test("ポップアップはバックグラウンドへ開始命令を送る", async () => {
  const source = await readFile(appPath, "utf8");
  assert.match(source, /chrome\.runtime\.sendMessage/);
  assert.doesNotMatch(source, /chrome\.tabs\.sendMessage/);
});
