const NEXT_ALARM = "suno-process-next";
const RECOVERY_ALARM = "suno-process-recovery";
const DEFAULT_SETTINGS = { intervalSeconds: 20, styleMode: "common", useTitle: false, commonStyle: "" };
const DEFAULT_RUNNER = { running: false, paused: false, currentId: null, tabId: null, message: "" };

let processing = false;

async function setBadge(queue, runner) {
  const completed = queue.reduce((total, item) => total + (item.done || 0), 0);
  if (runner.running) {
    await chrome.action.setBadgeBackgroundColor({ color: "#0b67e3" });
    await chrome.action.setBadgeText({ text: String(completed).slice(-4) });
    return;
  }
  if (queue.length > 0 && completed === queue.length) {
    await chrome.action.setBadgeBackgroundColor({ color: "#16884a" });
    await chrome.action.setBadgeText({ text: "完了" });
    return;
  }
  await chrome.action.setBadgeText({ text: "" });
}

async function updateState(queue, runner) {
  await chrome.storage.local.set({ sunoQueue: queue, sunoRunner: runner });
  await setBadge(queue, runner);
}

async function clearRunnerAlarms() {
  await Promise.all([
    chrome.alarms.clear(NEXT_ALARM),
    chrome.alarms.clear(RECOVERY_ALARM),
  ]);
}

async function pauseRunner(message) {
  const stored = await chrome.storage.local.get(["sunoQueue", "sunoRunner"]);
  const queue = stored.sunoQueue ?? [];
  const runner = stored.sunoRunner ?? DEFAULT_RUNNER;
  const nextQueue = queue.map((item) => (
    item.status === "processing" ? { ...item, status: "waiting", error: "" } : item
  ));
  await clearRunnerAlarms();
  await updateState(nextQueue, {
    ...runner,
    running: false,
    paused: true,
    currentId: null,
    message,
  });
}

async function scheduleNext(intervalSeconds) {
  await chrome.alarms.clear(NEXT_ALARM);
  chrome.alarms.create(NEXT_ALARM, {
    when: Date.now() + Math.max(10, Number(intervalSeconds) || 20) * 1000,
  });
}

// 拡張機能の更新直後は既存タブに旧content scriptしか無く通信できないため、
// 接続エラー時はcontent.jsを注入し直してから1回だけ再試行する
async function sendToContent(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "PROCESS_ITEM", item: payload });
  } catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(error?.message || "")) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return chrome.tabs.sendMessage(tabId, { type: "PROCESS_ITEM", item: payload });
  }
}

async function findSunoTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://suno.com/*", "https://app.suno.ai/*"],
  });
  return tabs.find((tab) => tab.id) ?? null;
}

async function processNext() {
  if (processing) return;
  processing = true;

  try {
    const stored = await chrome.storage.local.get(["sunoQueue", "sunoRunner", "sunoSettings"]);
    let queue = stored.sunoQueue ?? [];
    let runner = stored.sunoRunner ?? DEFAULT_RUNNER;
    const settings = { ...DEFAULT_SETTINGS, ...(stored.sunoSettings ?? {}) };

    if (!runner.running || runner.paused) return;

    if (runner.currentId) {
      queue = queue.map((item) => (
        item.id === runner.currentId && item.status === "processing"
          ? { ...item, status: "waiting", error: "" }
          : item
      ));
      runner = { ...runner, currentId: null };
    }

    let tabId = runner.tabId;
    try {
      if (!tabId) throw new Error("Sunoタブが未設定です。");
      await chrome.tabs.get(tabId);
    } catch {
      const replacementTab = await findSunoTab();
      if (!replacementTab?.id) {
        await pauseRunner("Sunoタブが見つからないため停止しました。");
        return;
      }
      tabId = replacementTab.id;
      runner = { ...runner, tabId };
    }

    const index = queue.findIndex((item) => item.status === "waiting" || item.status === "failed");
    if (index === -1) {
      await clearRunnerAlarms();
      await updateState(queue, {
        ...runner,
        running: false,
        paused: false,
        currentId: null,
        message: "すべての曲を処理しました。",
      });
      return;
    }

    const item = queue[index];
    const displayTitle = item.title || `曲 ${index + 1}`;
    const repeat = item.repeat || 1;
    // このitemの現在の生成回数（done完了済み+1回目）。繰り返し中の進捗表示に使う。
    const runLabel = repeat > 1 ? `（${(item.done || 0) + 1}/${repeat}）` : "";
    queue[index] = { ...item, status: "processing", error: "" };
    runner = {
      ...runner,
      running: true,
      paused: false,
      currentId: item.id,
      tabId,
      message: `${index + 1}曲目「${displayTitle}」${runLabel}を入力しています。`,
    };
    await updateState(queue, runner);

    chrome.alarms.create(RECOVERY_ALARM, { when: Date.now() + 120000 });

    // トグル設定から実際にSunoへ入力する値を決める。空文字の欄はcontent側が入力をスキップする。
    const payload = {
      title: settings.useTitle ? item.title || "" : "",
      style: settings.styleMode === "perSong" ? item.style || "" : settings.commonStyle || "",
      lyrics: item.lyrics ?? item.prompt ?? "",
    };

    try {
      const response = await sendToContent(tabId, payload);
      if (!response?.ok) throw new Error(response?.error || "Suno画面の操作に失敗しました。");

      await chrome.alarms.clear(RECOVERY_ALARM);
      const refreshed = await chrome.storage.local.get(["sunoQueue", "sunoRunner"]);
      const nextQueue = refreshed.sunoQueue ?? queue;
      const currentRunner = refreshed.sunoRunner ?? runner;
      // 1回送信できたのでdoneを進める。repeat回に達したら完了、まだなら待機へ戻して次の回で再生成する。
      const completedIndex = nextQueue.findIndex((candidate) => candidate.id === item.id);
      let isFullyDone = true;
      if (completedIndex >= 0) {
        const target = nextQueue[completedIndex];
        const targetRepeat = target.repeat || 1;
        const done = (target.done || 0) + 1;
        isFullyDone = done >= targetRepeat;
        nextQueue[completedIndex] = {
          ...target,
          done,
          status: isFullyDone ? "complete" : "waiting",
          error: "",
        };
      }
      const wasStopped = !currentRunner.running || currentRunner.paused;
      const progressLabel = repeat > 1 ? `（${(item.done || 0) + 1}/${repeat}）` : "";
      const nextRunner = {
        ...currentRunner,
        running: !wasStopped,
        paused: wasStopped,
        currentId: null,
        message: wasStopped
          ? `「${displayTitle}」${progressLabel}の送信後に停止しました。`
          : `「${displayTitle}」${progressLabel}をSunoへ送信しました。バックグラウンドで続行します。`,
      };
      await updateState(nextQueue, nextRunner);
      if (!wasStopped) await scheduleNext(settings.intervalSeconds);
    } catch (error) {
      await chrome.alarms.clear(RECOVERY_ALARM);
      const refreshed = await chrome.storage.local.get(["sunoQueue", "sunoRunner"]);
      const nextQueue = refreshed.sunoQueue ?? queue;
      const failedIndex = nextQueue.findIndex((candidate) => candidate.id === item.id);
      if (failedIndex >= 0) {
        nextQueue[failedIndex] = { ...nextQueue[failedIndex], status: "failed", error: error.message };
      }
      await updateState(nextQueue, {
        ...(refreshed.sunoRunner ?? runner),
        running: false,
        paused: true,
        currentId: null,
        message: error.message,
      });
    }
  } finally {
    processing = false;
  }
}

async function initializeStorage() {
  const stored = await chrome.storage.local.get(["sunoQueue", "sunoRunner", "sunoSettings"]);
  // 旧バージョン(prompt)のキューをlyricsへ移行しつつ、処理中断分を待機へ戻す
  const queue = (stored.sunoQueue ?? []).map(({ prompt, ...item }) => ({
    ...item,
    title: item.title ?? "",
    style: item.style ?? "",
    lyrics: item.lyrics ?? prompt ?? "",
    repeat: item.repeat ?? 1,
    done: item.done ?? 0,
    status: item.status === "processing" ? "waiting" : item.status,
    error: item.status === "processing" ? "" : item.error,
  }));
  const runner = { ...(stored.sunoRunner ?? DEFAULT_RUNNER), currentId: null };
  await chrome.storage.local.set({
    sunoQueue: queue,
    sunoRunner: runner,
    sunoSettings: stored.sunoSettings ?? DEFAULT_SETTINGS,
  });
  await setBadge(queue, runner);
  return runner;
}

chrome.runtime.onInstalled.addListener(async () => {
  await clearRunnerAlarms();
  const runner = await initializeStorage();
  if (runner.running && !runner.paused) {
    chrome.alarms.create(NEXT_ALARM, { when: Date.now() + 2000 });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await clearRunnerAlarms();
  const runner = await initializeStorage();
  if (!runner.running || runner.paused) return;
  chrome.alarms.create(NEXT_ALARM, { when: Date.now() + 5000 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === NEXT_ALARM || alarm.name === RECOVERY_ALARM) processNext();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { sunoRunner } = await chrome.storage.local.get("sunoRunner");
  if (sunoRunner?.running && sunoRunner.tabId === tabId) {
    await pauseRunner("処理対象のSunoタブが閉じられたため停止しました。");
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "START_QUEUE") {
    (async () => {
      const stored = await chrome.storage.local.get(["sunoRunner", "sunoSettings"]);
      await clearRunnerAlarms();
      await chrome.storage.local.set({
        sunoSettings: message.settings ?? stored.sunoSettings ?? DEFAULT_SETTINGS,
        sunoRunner: {
          ...(stored.sunoRunner ?? DEFAULT_RUNNER),
          running: true,
          paused: false,
          currentId: null,
          tabId: message.tabId,
          message: "バックグラウンド生成を開始します。",
        },
      });
      await processNext();
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "STOP_QUEUE") {
    pauseRunner("停止しました。再開すると続きから処理します。")
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
