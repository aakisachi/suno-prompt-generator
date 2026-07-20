(() => {
  if (window.__sunoPromptRunnerLoaded) return;
  window.__sunoPromptRunnerLoaded = true;

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  const FIELDS = {
    lyrics: {
      include: ["lyrics", "lyric", "歌詞", "リリック"],
      exclude: ["style", "スタイル", "description", "describe", "title", "タイトル", "exclude"],
      preferLarge: true,
    },
    style: {
      include: ["style", "styles", "スタイル"],
      exclude: ["exclude", "除外", "lyrics", "lyric", "歌詞", "リリック", "title", "タイトル"],
      preferLarge: false,
    },
    title: {
      include: ["title", "タイトル"],
      exclude: ["style", "スタイル", "lyrics", "歌詞", "リリック", "playlist", "exclude"],
      preferLarge: false,
    },
  };

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

  function scoreField(element, { include, exclude, preferLarge }) {
    const text = elementText(element);
    let score = 0;
    let matched = false;
    include.forEach((keyword) => {
      if (text.includes(keyword)) {
        score += 20;
        matched = true;
      }
    });
    exclude.forEach((keyword) => {
      if (text.includes(keyword)) score -= 30;
    });
    if (preferLarge) {
      if (element.tagName === "TEXTAREA") score += 5;
      const rect = element.getBoundingClientRect();
      if (rect.height >= 120) score += 8;
      else if (rect.height >= 70) score += 3;
    }
    return { score, matched };
  }

  function findField(config, { requireKeyword = true } = {}) {
    const ranked = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"], input:not([type])')]
      .filter((element) => isVisible(element) && !element.disabled)
      .map((element) => ({ element, ...scoreField(element, config) }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best) return null;
    if (requireKeyword && (!best.matched || best.score <= 0)) return null;
    return best.element;
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

  // 空文字のフィールドは触らない＝Suno画面に入力済みの値を温存する
  async function processItem(item) {
    if (item.title) {
      const titleField = findField(FIELDS.title);
      if (!titleField) throw new Error("タイトル入力欄が見つかりません。「タイトルを入力する」をオフにするか、Customモードを確認してください。");
      setFieldValue(titleField, item.title);
      await sleep(250);
    }

    if (item.style) {
      const styleField = findField(FIELDS.style);
      if (!styleField) throw new Error("スタイル入力欄が見つかりません。Customモードを開いてください。");
      setFieldValue(styleField, item.style);
      await sleep(250);
    }

    const lyricsField = findField(FIELDS.lyrics, { requireKeyword: false });
    if (!lyricsField) throw new Error("Lyrics入力欄が見つかりません。Customモードを開いてください。");
    setFieldValue(lyricsField, item.lyrics ?? item.prompt ?? "");
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
