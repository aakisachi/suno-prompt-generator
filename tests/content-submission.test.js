import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/content.js", import.meta.url), "utf8");
const check = source.slice(source.indexOf("  function checkDeadline"), source.indexOf("  const FIELD_SELECTOR"));
const process = source.slice(source.indexOf("  async function processItem"), source.indexOf("  chrome.runtime.onMessage"));
function harness({ permit = true, loseConfirmation = false, permissionDelay = 0, buttonDelay = 0 } = {}) {
  let now = 1000, clicks = 0, polls = 0;
  const messages = [], fills = [];
  const ctx = vm.createContext({ Date: { now: () => now }, Number,
    findTitleField: () => "title", findStyleField: () => "style", findLyricsField: () => "lyrics",
    fillField: async (field, value) => fills.push([field, value]),
    sleep: async n => { now += n; },
    findCreateButton: () => ++polls > buttonDelay ? { click: () => { clicks++; } } : null,
    chrome: { runtime: { sendMessage: async m => {
      messages.push(m.type);
      if (m.type === "AUTHORIZE_CLICK") { now += permissionDelay; return { ok: permit }; }
      if (loseConfirmation) throw new Error("lost acknowledgement");
      return { ok: true };
    } } },
  });
  vm.runInContext(check + process, ctx);
  return { run: (changes = {}) => ctx.processItem({ title: "title", style: "style", lyrics: "lyrics", attemptId: "one", deadline: 45000, ...changes }),
    messages, fills, get clicks() { return clicks; } };
}
test("Createは入力後の許可を得て一度だけクリックし、記録を返す", async () => {
  const h = harness(); const r = await h.run();
  assert.equal(r.clicked, true); assert.equal(h.clicks, 1);
  assert.deepEqual(h.messages, ["AUTHORIZE_CLICK", "CONFIRM_CLICK"]);
  assert.deepEqual(h.fills.map(x => x[0]), ["title", "style", "lyrics"]);
});
test("停止・失効による許可拒否はクリックしない", async () => {
  const h = harness({ permit: false }); await assert.rejects(h.run()); assert.equal(h.clicks, 0);
});
test("遅れて届いたクリック許可は期限を再確認して拒否", async () => {
  const h = harness({ permissionDelay: 50000 }); await assert.rejects(h.run(), /期限/); assert.equal(h.clicks, 0);
});
test("確認メッセージが失われてもクリック済みの応答を返す", async () => {
  const h = harness({ loseConfirmation: true }); assert.equal((await h.run()).clicked, true); assert.equal(h.clicks, 1);
});
test("ボタン表示に5秒以上かかっても期限内なら続行", async () => {
  const h = harness({ buttonDelay: 15 }); await h.run(); assert.equal(h.clicks, 1);
});
test("旧プロトコル・期限切れはフィールド変更前に拒否", async () => {
  for (const changes of [{ attemptId: undefined }, { deadline: 500 }]) {
    const h = harness(); await assert.rejects(h.run(changes)); assert.equal(h.clicks, 0); assert.equal(h.fills.length, 0);
  }
});
