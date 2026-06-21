const DEFAULT_SETTINGS = { intervalSeconds: 20 };
const DEFAULT_RUNNER = { running: false, paused: false, currentId: null, tabId: null, message: "" };

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(["sunoQueue", "sunoRunner", "sunoSettings"]);
  await chrome.storage.local.set({
    sunoQueue: stored.sunoQueue ?? [],
    sunoRunner: stored.sunoRunner ?? DEFAULT_RUNNER,
    sunoSettings: stored.sunoSettings ?? DEFAULT_SETTINGS,
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_SENDER_TAB_ID") {
    sendResponse({ tabId: sender.tab?.id ?? null });
  }
});
