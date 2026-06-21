(() => {
  if (window.__sunoPromptRunnerLoaded) return;
  window.__sunoPromptRunnerLoaded = true;

  let processing = false;
  let stopRequested = false;
  let currentTabId = null;
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function isVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function elementText(element) {
    return [element.getAttribute("placeholder"), element.getAttribute("aria-label"), element.getAttribute("data-testid"), element.textContent]
      .filter(Boolean).join(" ").toLowerCase();
  }

  function scorePromptField(element) {
    const text = elementText(element);
    let score = element.tagName === "TEXTAREA" ? 5 : 1;
    ["lyrics", "lyric", "歌詞", "リリック"].forEach((keyword) => {
      if (text.includes(keyword)) score += 20;
    });
    ["style", "styles", "スタイル", "description", "describe"].forEach((keyword) => {
      if (text.includes(keyword)) score -= 12;
    });
    const rect = element.getBoundingClientRect();
    if (rect.height >= 120) score += 8;
    else if (rect.height >= 70) score += 3;
    return score;
  }

  function findPromptField() {
    return [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')]
      .filter((element) => isVisible(element) && !element.disabled)
      .sort((a, b) => scorePromptField(b) - scorePromptField(a))[0] ?? null;
  }

  function setFieldValue(element, value) {
    element.focus();
    if (element.isContentEditable) {
      element.textContent = value;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      return;
    }
    const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findCreateButton() {
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter((element) => isVisible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true");
    return buttons.find((element) => /^(create|生成|作成)$/i.test((element.textContent || "").trim()))
      ?? buttons.find((element) => {
        const text = elementText(element);
        return text.includes("create") && !text.includes("custom") && !text.includes("model");
      })
      ?? null;
  }

  async function updateState(queue, runner) {
    await chrome.storage.local.set({ sunoQueue: queue, sunoRunner: runner });
  }

  async function setMessage(message, patch = {}) {
    const { sunoRunner = {} } = await chrome.storage.local.get("sunoRunner");
    await chrome.storage.local.set({ sunoRunner: { ...sunoRunner, ...patch, message } });
  }

  async function runQueue() {
    if (processing) return;
    processing = true;
    stopRequested = false;

    try {
      while (!stopRequested) {
        const stored = await chrome.storage.local.get(["sunoQueue", "sunoRunner", "sunoSettings"]);
        const queue = stored.sunoQueue ?? [];
        const runner = stored.sunoRunner ?? {};
        const settings = stored.sunoSettings ?? { intervalSeconds: 20 };

        if (!runner.running || runner.paused || runner.tabId !== currentTabId) break;
        const index = queue.findIndex((item) => item.status === "waiting" || item.status === "failed");
        if (index === -1) {
          await updateState(queue, { ...runner, running: false, paused: false, currentId: null, message: "すべての曲を処理しました。" });
          break;
        }

        const item = queue[index];
        queue[index] = { ...item, status: "processing", error: "" };
        await updateState(queue, { ...runner, running: true, paused: false, currentId: item.id, message: `${index + 1}曲目「${item.title}」を入力しています。` });

        try {
          const field = findPromptField();
          if (!field) throw new Error("Lyrics入力欄が見つかりません。Customモードを開いてください。");
          setFieldValue(field, item.prompt);
          await sleep(700);
          const createButton = findCreateButton();
          if (!createButton) throw new Error("Createボタンが見つかりません。");
          createButton.click();

          const refreshed = await chrome.storage.local.get(["sunoQueue", "sunoRunner"]);
          const nextQueue = refreshed.sunoQueue ?? queue;
          const completedIndex = nextQueue.findIndex((candidate) => candidate.id === item.id);
          if (completedIndex >= 0) nextQueue[completedIndex] = { ...nextQueue[completedIndex], status: "complete", error: "" };
          await updateState(nextQueue, { ...(refreshed.sunoRunner ?? runner), running: true, currentId: null, message: `「${item.title}」をSunoへ送信しました。` });
        } catch (error) {
          const refreshed = await chrome.storage.local.get(["sunoQueue", "sunoRunner"]);
          const nextQueue = refreshed.sunoQueue ?? queue;
          const failedIndex = nextQueue.findIndex((candidate) => candidate.id === item.id);
          if (failedIndex >= 0) nextQueue[failedIndex] = { ...nextQueue[failedIndex], status: "failed", error: error.message };
          await updateState(nextQueue, { ...(refreshed.sunoRunner ?? runner), running: false, paused: true, currentId: null, message: error.message });
          break;
        }

        const waitMilliseconds = Math.max(10, Number(settings.intervalSeconds) || 20) * 1000;
        for (let elapsed = 0; elapsed < waitMilliseconds && !stopRequested; elapsed += 500) {
          await sleep(500);
          const { sunoRunner } = await chrome.storage.local.get("sunoRunner");
          if (!sunoRunner?.running || sunoRunner.paused) stopRequested = true;
        }
      }
    } finally {
      processing = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "START_QUEUE") {
      currentTabId = message.tabId;
      chrome.storage.local.get(["sunoRunner", "sunoSettings"]).then(async (stored) => {
        await chrome.storage.local.set({
          sunoSettings: message.settings ?? stored.sunoSettings ?? { intervalSeconds: 20 },
          sunoRunner: { ...(stored.sunoRunner ?? {}), running: true, paused: false, tabId: currentTabId, message: "生成を開始します。" },
        });
        runQueue();
      });
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === "STOP_QUEUE") {
      stopRequested = true;
      setMessage("停止しました。", { running: false, paused: true, currentId: null });
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  chrome.runtime.sendMessage({ type: "GET_SENDER_TAB_ID" }, async (response) => {
    currentTabId = response?.tabId ?? null;
    const { sunoRunner } = await chrome.storage.local.get("sunoRunner");
    if (sunoRunner?.running && sunoRunner.tabId === currentTabId) runQueue();
  });
})();
