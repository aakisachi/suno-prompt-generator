import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const source = await readFile(new URL("../public/background.js", import.meta.url), "utf8");
const clone = x => JSON.parse(JSON.stringify(x));
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
function harness(count = 2, persisted) {
  const db = persisted || { sunoQueue: Array.from({ length: count }, (_, i) => ({
    id: String(i), title: `song ${i}`, lyrics: `lyrics ${i}`, style: `style ${i}`, status: "waiting", done: 0, repeat: 1,
  })), sunoRunner: { running: false, paused: false }, sunoSettings: { intervalSeconds: 20, useTitle: true, styleMode: "perSong" } };
  let now = 100000, listener, alarmListener, reloads = 0, badgeFails = false;
  const sent = [], alarms = new Map(), errors = [];
  const event = () => ({ addListener() {} });
  const chrome = {
    storage: { local: { get: async () => clone(db), set: async v => Object.assign(db, clone(v)) } },
    action: { setBadgeText: async () => { if (badgeFails) throw new Error("badge unavailable"); } },
    alarms: { get: async n => alarms.get(n), create: async (n, a) => alarms.set(n, a),
      clear: async n => alarms.delete(n), onAlarm: { addListener: f => { alarmListener = f; } } },
    tabs: { get: async () => ({ id: 1 }), query: async () => [{ id: 1 }], reload: async () => { reloads++; },
      sendMessage: (_id, m) => new Promise(resolve => sent.push({ ...clone(m), resolve })), onRemoved: event() },
    scripting: { executeScript: async () => {} },
    runtime: { onInstalled: event(), onStartup: event(), onMessage: { addListener: f => { listener = f; } } },
  };
  const ctx = vm.createContext({ chrome, crypto: { randomUUID }, Date: { now: () => now },
    console: { error: (...x) => errors.push(x), warn() {} } });
  vm.runInContext(source, ctx);
  const message = (m, tabId) => new Promise(resolve => listener(m, tabId ? { tab: { id: tabId } } : {}, resolve));
  return { db, sent, alarms, errors, message, flush, advance: n => { now += n; },
    start: () => message({ type: "START_QUEUE", tabId: 1 }),
    fire: async (name = "suno-watchdog") => { alarmListener({ name }); await flush(); },
    authorize: job => message({ type: "AUTHORIZE_CLICK", attemptId: job.item.attemptId }, 1),
    confirm: job => message({ type: "CONFIRM_CLICK", attemptId: job.item.attemptId }, 1),
    get reloads() { return reloads; }, failBadge: () => { badgeFails = true; } };
}

test("200曲: 各曲の完了保存、個別スタイル、重複クリック許可なし", async () => {
  const h = harness(200); await h.flush(); await h.start(); await h.flush();
  for (let i = 0; i < 200; i++) {
    const job = h.sent[i];
    assert.ok(job, `missing item ${i + 1}`);
    assert.equal(job.type, "PROCESS_ITEM_V2");
    assert.equal(job.item.style, `style ${i}`);
    assert.equal((await h.authorize(job)).ok, true);
    assert.equal((await h.authorize(job)).ok, false);
    assert.equal((await h.confirm(job)).ok, true);
    job.resolve({ ok: true, clicked: true }); await h.flush();
    h.advance(21000); await h.fire();
  }
  assert.equal(h.sent.length, 200);
  assert.equal(h.db.sunoQueue.every(q => q.done === 1 && q.status === "complete"), true);
  assert.equal(h.db.sunoRunner.running, false);
  assert.equal(h.errors.length, 0);
});

test("未送信の応答が返らなくても期限後に復帰し、古い要求を拒否", async () => {
  const h = harness(); await h.flush(); await h.start(); await h.flush();
  const old = h.sent[0]; h.advance(46000); await h.fire();
  assert.equal(h.db.sunoQueue[0].status, "waiting");
  assert.equal((await h.authorize(old)).ok, false);
  h.advance(21000); await h.fire();
  assert.equal(h.sent.length, 2);
  assert.notEqual(h.sent[1].item.attemptId, old.item.attemptId);
  old.resolve({ ok: true, clicked: true }); await h.flush();
  assert.equal(h.db.sunoQueue[0].done, 0);
  assert.equal(h.db.sunoRunner.attempt.id, h.sent[1].item.attemptId);
});

test("未送信のタイムアウトは2回だけ自動再試行して停止", async () => {
  const h = harness(); await h.flush(); await h.start(); await h.flush();
  for (let i = 0; i < 3; i++) { h.advance(46000); await h.fire(); h.advance(21000); await h.fire(); }
  assert.equal(h.sent.length, 3);
  assert.equal(h.db.sunoRunner.paused, true);
  assert.equal(h.db.sunoQueue[0].done, 0);
});

test("次曲アラームが消えても周期監視が次の曲を処理する", async () => {
  const h = harness(); await h.flush(); await h.start(); await h.flush();
  await h.authorize(h.sent[0]); await h.confirm(h.sent[0]);
  h.alarms.delete("suno-process-next"); h.advance(30000); await h.fire();
  assert.equal(h.sent.length, 2);
  assert.equal(h.alarms.get("suno-watchdog").periodInMinutes, 0.5);
});

test("送信記録があれば元の応答が失われても二重送信しない", async () => {
  const h = harness(); await h.flush(); await h.start(); await h.flush();
  await h.authorize(h.sent[0]); await h.confirm(h.sent[0]);
  h.advance(60000); await h.fire();
  assert.equal(h.db.sunoQueue[0].done, 1);
  assert.equal(h.sent[1].item.lyrics, "lyrics 1");
});

test("クリック許可後に応答が消えた場合は再送せず確認を要求", async () => {
  const h = harness(); await h.flush(); await h.start(); await h.flush();
  await h.authorize(h.sent[0]); h.advance(46000); await h.fire();
  assert.equal(h.db.sunoRunner.reviewRequired, true);
  assert.equal((await h.start()).ok, false);
  await h.fire(); assert.equal(h.sent.length, 1);
  assert.equal(h.db.sunoQueue[0].done, 0);
});

test("停止した入力に遅い応答が来てもクリックを許可しない", async () => {
  const h = harness(); await h.flush(); await h.start(); await h.flush();
  await h.message({ type: "STOP_QUEUE" });
  assert.equal((await h.authorize(h.sent[0])).ok, false);
  h.advance(60000); await h.fire(); assert.equal(h.sent.length, 1);
  assert.equal(h.db.sunoQueue[0].status, "waiting");
});

test("停止後のクリック確認は完了だけ記録し、次を開始しない", async () => {
  const h = harness(); await h.flush(); await h.start(); await h.flush();
  await h.authorize(h.sent[0]); await h.message({ type: "STOP_QUEUE" });
  await h.confirm(h.sent[0]); h.advance(60000); await h.fire();
  assert.equal(h.db.sunoQueue[0].done, 1);
  assert.equal(h.db.sunoRunner.running, false);
  assert.equal(h.sent.length, 1);
});

test("worker再起動でも送信不明の記録を保持する", async () => {
  const h = harness(); await h.flush(); await h.start(); await h.flush(); await h.authorize(h.sent[0]);
  const restarted = harness(2, clone(h.db)); await restarted.flush();
  assert.equal(restarted.sent.length, 0);
  restarted.advance(46000); await restarted.fire();
  assert.equal(restarted.db.sunoRunner.reviewRequired, true);
  assert.equal(restarted.sent.length, 0);
});

test("旧版の処理中は未送信に戻さず確認を要求する", async () => {
  const h = harness(1, { sunoQueue: [{ id: "old", status: "processing", done: 0 }],
    sunoRunner: { running: true, currentId: "old", tabId: 1 } }); await h.flush();
  assert.equal(h.db.sunoRunner.reviewRequired, true); assert.equal(h.sent.length, 0);
});

test("確認後は古いタブ操作を破棄し、明示再開まで待つ", async () => {
  for (const outcome of ["sent", "not-sent"]) {
    const h = harness(); await h.flush(); await h.start(); await h.flush();
    await h.authorize(h.sent[0]); h.advance(46000); await h.fire();
    const result = await h.message({ type: "RESOLVE_SUBMISSION", outcome });
    assert.equal(result.ok, true); assert.equal(h.reloads, 1);
    assert.equal(h.db.sunoQueue[0].done, outcome === "sent" ? 1 : 0);
    assert.equal(h.db.sunoRunner.running, false); assert.equal(h.db.sunoRunner.reviewRequired, false);
    h.advance(60000); await h.fire(); assert.equal(h.sent.length, 1);
  }
});

test("開始の二重クリック、バッジ失敗、繰り返し回数を処理", async () => {
  const h = harness(1); h.db.sunoQueue[0].repeat = 2; h.failBadge(); await h.flush();
  await Promise.all([h.start(), h.start()]); await h.flush(); assert.equal(h.sent.length, 1);
  await h.authorize(h.sent[0]); await h.confirm(h.sent[0]);
  assert.equal(h.db.sunoQueue[0].status, "waiting");
  h.advance(21000); await h.fire(); await h.authorize(h.sent[1]); await h.confirm(h.sent[1]);
  assert.equal(h.db.sunoQueue[0].done, 2); assert.equal(h.db.sunoQueue[0].status, "complete");
});

test("別タブからのクリック許可は拒否", async () => {
  const h = harness(); await h.flush(); await h.start(); await h.flush();
  const result = await h.message({ type: "AUTHORIZE_CLICK", attemptId: h.sent[0].item.attemptId }, 99);
  assert.equal(result.ok, false);
});
