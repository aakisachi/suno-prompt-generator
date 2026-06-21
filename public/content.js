(() => {
  if (window.__sunoPromptRunnerLoaded) return;
  window.__sunoPromptRunnerLoaded = true;

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

  async function processItem(item) {
    const field = findPromptField();
    if (!field) throw new Error("Lyrics入力欄が見つかりません。Customモードを開いてください。");
    setFieldValue(field, item.prompt);
    await sleep(700);

    const createButton = findCreateButton();
    if (!createButton) throw new Error("Createボタンが見つかりません。");
    createButton.click();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "PROCESS_ITEM") return false;

    processItem(message.item)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();
