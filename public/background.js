const NEXT_ALARM = "suno-process-next";
const RECOVERY_ALARM = "suno-process-recovery";
const WATCHDOG_ALARM = "suno-watchdog";
const ATTEMPT_MS = 45000;
const DEFAULT_SETTINGS = { intervalSeconds: 20, styleMode: "common", useTitle: false, commonStyle: "" };
const DEFAULT_RUNNER = { running: false, paused: false, currentId: null, tabId: null, message: "" };

// Lock storage transitions, never the unbounded round-trip to a tab.
let stateLock = Promise.resolve();
function locked(action) {
  const result = stateLock.then(action);
  stateLock = result.catch(() => {});
  return result;
}
async function readState() {
  const s = await chrome.storage.local.get(["sunoQueue", "sunoRunner", "sunoSettings"]);
  return { queue: s.sunoQueue ?? [], runner: { ...DEFAULT_RUNNER, ...s.sunoRunner },
    settings: { ...DEFAULT_SETTINGS, ...s.sunoSettings } };
}
async function save(queue, runner) {
  await chrome.storage.local.set({ sunoQueue: queue, sunoRunner: runner });
  try {
    await chrome.action.setBadgeText({ text: runner.reviewRequired ? "確認" : runner.running
      ? String(queue.reduce((n, q) => n + (q.done || 0), 0)).slice(-4) : "" });
  } catch (e) { console.warn("Suno badge:", e.message); }
}
async function armWatchdog() {
  if (!(await chrome.alarms.get(WATCHDOG_ALARM))) {
    await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
  }
}
async function scheduleNext(when) {
  await chrome.alarms.create(NEXT_ALARM, { when: Math.max(Date.now() + 100, when) });
}
async function clearOneShotAlarms() {
  await Promise.all([chrome.alarms.clear(NEXT_ALARM), chrome.alarms.clear(RECOVERY_ALARM)]);
}
function interval(s) { return Math.max(10, Number(s.intervalSeconds) || 20) * 1000; }
function currentItem(queue, runner) { return queue.find(q => q.id === runner.attempt?.itemId); }
function markReview(queue, runner, message) {
  const item = currentItem(queue, runner);
  if (item) { item.status = "failed"; item.error = message; }
  Object.assign(runner, { running: false, paused: true, reviewRequired: true, message });
}
function finish(queue, runner, settings) {
  const target = currentItem(queue, runner);
  if (target) {
    const targetRepeat = target.repeat || 1;
    const done = (target.done || 0) + 1;
    const isFullyDone = done >= targetRepeat;
    Object.assign(target, { done, status: isFullyDone ? "complete" : "waiting", error: "", retries: 0 });
  }
  Object.assign(runner, { attempt: null, currentId: null, reviewRequired: false,
    nextRunAt: Date.now() + interval(settings),
    message: runner.running ? "送信を記録しました。次の曲まで待機しています。" : "送信を記録して停止しました。" });
}
async function sendToContent(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "PROCESS_ITEM_V2", item: payload });
  } catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(error?.message || "")) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tabId, { type: "PROCESS_ITEM_V2", item: payload });
  }
}

// Persist a one-use click permission before Create. A worker restart must not resend it.
async function authorize(message, sender) {
  return locked(async () => {
    const { queue, runner } = await readState();
    const a = runner.attempt;
    if (!runner.running || runner.paused || runner.reviewRequired || !a ||
        a.id !== message.attemptId || a.phase !== "preparing" ||
        a.deadline <= Date.now() || sender.tab?.id !== runner.tabId) {
      return { ok: false, error: "停止済み、または期限切れの入力です。生成しません。" };
    }
    a.phase = "clicking";
    await save(queue, runner);
    return { ok: true, deadline: a.deadline };
  });
}
async function confirmClick(message, sender) {
  return locked(async () => {
    const { queue, runner, settings } = await readState();
    const a = runner.attempt;
    if (!a || a.id !== message.attemptId || sender.tab?.id !== runner.tabId ||
        !["clicking", "clicked"].includes(a.phase)) return { ok: false };
    a.phase = "clicked";
    // A late acknowledgement must preserve an explicit pause.
    finish(queue, runner, settings);
    await save(queue, runner);
    if (runner.running) await scheduleNext(runner.nextRunAt);
    return { ok: true };
  });
}
async function settle(attemptId, response) {
  await locked(async () => {
    const { queue, runner, settings } = await readState();
    if (runner.attempt?.id !== attemptId) return;
    if (runner.attempt.phase === "clicked" || (response?.clicked && runner.attempt.phase === "clicking")) {
      finish(queue, runner, settings);
    } else if (runner.attempt.phase === "clicking") {
      markReview(queue, runner, "送信結果を確認できません。Sunoの生成一覧を確認してください。自動再送はしません。");
    } else {
      const item = currentItem(queue, runner);
      if (item) { item.status = "failed"; item.error = response?.error || "入力処理を完了できませんでした。更新直後はSunoタブを再読み込みしてください。"; }
      Object.assign(runner, { attempt: null, currentId: null, running: false, paused: true,
        message: item?.error || "入力を停止しました。" });
    }
    await save(queue, runner);
    if (runner.running) await scheduleNext(runner.nextRunAt);
  });
}
async function tick() {
  const job = await locked(async () => {
    const { queue, runner, settings } = await readState();
    const now = Date.now();
    if (runner.attempt?.phase === "clicked") {
      finish(queue, runner, settings);
      await save(queue, runner);
    }
    if (!runner.running || runner.paused || runner.reviewRequired) return;
    await armWatchdog();
    if (runner.attempt) {
      if (runner.attempt.deadline > now) return;
      if (runner.attempt.phase !== "preparing") {
        markReview(queue, runner, "生成ボタンの送信結果が不明です。Sunoを確認するまで再送を保留します。");
      } else {
        const item = currentItem(queue, runner);
        if (item) {
          item.retries = (item.retries || 0) + 1;
          item.status = item.retries <= 2 ? "waiting" : "failed";
          item.error = "Sunoからの応答が時間内に届きませんでした。";
        }
        // No click was authorized. Revoke this attempt before retrying it.
        Object.assign(runner, { attempt: null, currentId: null, nextRunAt: now + interval(settings),
          running: Boolean(item && item.retries <= 2), paused: !item || item.retries > 2,
          message: item && item.retries <= 2 ? "未送信の入力を取り消しました。間隔を空けて再試行します。" : "応答待ちが続いたため停止しました。Sunoの画面を確認してください。" });
      }
      await save(queue, runner);
      if (runner.running) await scheduleNext(runner.nextRunAt);
      return;
    }
    const legacy = queue.find(q => q.status === "processing");
    if (legacy || runner.currentId) {
      runner.attempt = { id: crypto.randomUUID(), itemId: legacy?.id || runner.currentId, phase: "legacy", deadline: 0 };
      markReview(queue, runner, "旧版で処理中だった曲があります。Sunoの生成一覧で送信済みか確認してください。");
      await save(queue, runner);
      return;
    }
    if (runner.nextRunAt > now) { await scheduleNext(runner.nextRunAt); return; }
    const item = queue.find(q => q.status === "waiting" || q.status === "failed");
    if (!item) {
      Object.assign(runner, { running: false, paused: false, message: "すべての曲を処理しました。" });
      await save(queue, runner);
      await clearOneShotAlarms();
      return;
    }
    try {
      if (!runner.tabId) throw new Error("no tab");
      await chrome.tabs.get(runner.tabId);
    } catch {
      const tabs = await chrome.tabs.query({ url: ["https://suno.com/*", "https://app.suno.ai/*"] });
      runner.tabId = tabs.find(t => t.id)?.id;
      if (!runner.tabId) {
        Object.assign(runner, { running: false, paused: true, message: "Sunoタブが見つからないため停止しました。" });
        await save(queue, runner);
        return;
      }
    }
    runner.attempt = { id: crypto.randomUUID(), itemId: item.id, phase: "preparing", deadline: now + ATTEMPT_MS };
    Object.assign(item, { status: "processing", error: "" });
    Object.assign(runner, { currentId: item.id, message: `${queue.indexOf(item) + 1}曲目「${item.title || "名称未設定"}」を入力しています。` });
    await save(queue, runner);
    await chrome.alarms.create(RECOVERY_ALARM, { when: runner.attempt.deadline });
    return { tabId: runner.tabId, payload: {
      title: settings.useTitle ? item.title || "" : "",
      style: settings.styleMode === "perSong" ? item.style || "" : settings.commonStyle || "",
      lyrics: item.lyrics ?? item.prompt ?? "", attemptId: runner.attempt.id, deadline: runner.attempt.deadline,
    } };
  });
  if (job) {
    void sendToContent(job.tabId, job.payload)
      .then(r => settle(job.payload.attemptId, r), e => settle(job.payload.attemptId, { error: e.message }))
      .catch(reportError);
  }
}
function reportError(error) { console.error("Suno runner:", error.message); }
async function pauseRunner(message) {
  await locked(async () => {
    const { queue, runner, settings } = await readState();
    runner.running = false;
    runner.paused = true;
    if (runner.attempt?.phase === "clicked") finish(queue, runner, settings);
    if (runner.attempt?.phase === "preparing") {
      const item = currentItem(queue, runner);
      if (item) item.status = "waiting";
      runner.attempt = null;
      runner.currentId = null;
    } else if (runner.attempt) {
      markReview(queue, runner, "送信途中で停止しました。Sunoの生成一覧を確認してください。");
    }
    if (!runner.reviewRequired) runner.message = message;
    await save(queue, runner);
    await clearOneShotAlarms();
  });
}
async function start(message) {
  await locked(async () => {
    const { queue, runner } = await readState();
    if (runner.reviewRequired) throw new Error("先に送信結果の確認を完了してください。");
    if (runner.running && !runner.paused) return;
    Object.assign(runner, { running: true, paused: false, tabId: message.tabId || runner.tabId,
      nextRunAt: Date.now(), message: "バックグラウンド生成を開始します。" });
    if (message.settings) await chrome.storage.local.set({ sunoSettings: message.settings });
    await armWatchdog();
    await save(queue, runner);
  });
  await tick();
}
async function resolveReview(message) {
  await locked(async () => {
    const { queue, runner, settings } = await readState();
    if (!runner.reviewRequired || !runner.attempt || !["sent", "not-sent"].includes(message.outcome)) {
      throw new Error("確認対象が変わりました。表示を確認してください。");
    }
    // Reload invalidates old content execution before an uncertain attempt can be retried.
    try { await chrome.tabs.get(runner.tabId); }
    catch { runner.tabId = null; }
    if (runner.tabId) await chrome.tabs.reload(runner.tabId);
    runner.running = false;
    runner.paused = true;
    if (message.outcome === "sent") finish(queue, runner, settings);
    else {
      const item = currentItem(queue, runner);
      if (item) Object.assign(item, { status: "waiting", error: "", retries: 0 });
      Object.assign(runner, { attempt: null, currentId: null, reviewRequired: false });
    }
    runner.message = "確認結果を保存しました。Sunoの画面が読み込まれたら再開できます。";
    await save(queue, runner);
  });
}
async function initialize() {
  await locked(async () => {
    const { queue, runner } = await readState();
    for (const q of queue) { q.lyrics ??= q.prompt ?? ""; q.done ??= 0; q.repeat ??= 1; }
    await save(queue, runner);
    if (runner.running) await armWatchdog();
  });
  await tick();
}
chrome.runtime.onInstalled.addListener(() => { void initialize().catch(reportError); });
chrome.runtime.onStartup.addListener(() => { void initialize().catch(reportError); });
chrome.alarms.onAlarm.addListener(alarm => {
  if ([NEXT_ALARM, RECOVERY_ALARM, WATCHDOG_ALARM].includes(alarm.name)) void tick().catch(reportError);
});
chrome.tabs.onRemoved.addListener(tabId => {
  void readState().then(({ runner }) => {
    if (runner.tabId === tabId) return pauseRunner("Sunoタブが閉じられたため停止しました。");
  }).catch(reportError);
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const actions = {
    START_QUEUE: () => start(message), STOP_QUEUE: () => pauseRunner("停止しました。未送信の曲から再開できます。"),
    AUTHORIZE_CLICK: () => authorize(message, sender), CONFIRM_CLICK: () => confirmClick(message, sender),
    RESOLVE_SUBMISSION: () => resolveReview(message),
  };
  if (!actions[message.type]) return false;
  actions[message.type]().then(result => sendResponse(result ?? { ok: true }),
    error => sendResponse({ ok: false, error: error.message }));
  return true;
});
// Waking a worker is not the same as starting Chrome. Rebuild timers on every wake.
void initialize().catch(reportError);
