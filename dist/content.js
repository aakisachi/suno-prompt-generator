(() => {
  if (window.__sunoPromptRunnerLoaded) return;
  window.__sunoPromptRunnerLoaded = true;

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  const FIELD_SELECTOR = 'textarea, [contenteditable="true"], input[type="text"], input:not([type])';

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

  // 判定は属性のみを使う。textContentを含めると歌詞本文の単語（style等）で誤検出する。
  function attrText(element) {
    return [element.getAttribute("placeholder"), element.getAttribute("aria-label"), element.getAttribute("data-testid")]
      .filter(Boolean).join(" ").toLowerCase();
  }

  function candidates() {
    return [...document.querySelectorAll(FIELD_SELECTOR)]
      .filter((element) => isVisible(element) && !element.disabled);
  }

  function findByKeywords({ include, exclude, preferLarge }) {
    const ranked = candidates()
      .map((element) => {
        const text = attrText(element);
        // 除外語を含む欄（例: Exclude styles）は候補から完全に外す
        if (exclude.some((keyword) => text.includes(keyword))) return null;
        let score = 0;
        let matched = false;
        include.forEach((keyword) => {
          if (text.includes(keyword)) {
            score += 20;
            matched = true;
          }
        });
        if (preferLarge) {
          if (element.tagName === "TEXTAREA") score += 5;
          const rect = element.getBoundingClientRect();
          if (rect.height >= 120) score += 8;
          else if (rect.height >= 70) score += 3;
        }
        return { element, score, matched };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    return ranked.find((candidate) => candidate.matched)?.element ?? null;
  }

  // セクション見出し（Lyrics / Styles）から親を辿って入力欄を探す
  function findByHeading(headingPattern, selector) {
    const headers = [...document.querySelectorAll("div, span, button, h1, h2, h3")]
      .filter((element) => {
        const text = (element.textContent || "").trim();
        return text.length < 20 && headingPattern.test(text);
      });
    for (const header of headers) {
      let node = header;
      for (let depth = 0; depth < 6 && node; depth += 1) {
        node = node.parentElement;
        const field = node?.querySelector(selector);
        if (field && isVisible(field)) return field;
      }
    }
    return null;
  }

  // Simpleモードで誤ってSong Description欄へ入力しないよう、確実に特定できた場合だけ返す
  function findLyricsField() {
    return findByKeywords(FIELDS.lyrics)
      ?? findByHeading(/^lyrics$/i, '[contenteditable="true"], textarea');
  }

  // Sunoのスタイル欄は属性にstyleの語を持たないため、見出し「Styles」からの探索を優先する
  function findStyleField() {
    return findByHeading(/^styles?$/i, 'textarea, [contenteditable="true"]')
      ?? findByKeywords(FIELDS.style);
  }

  function findTitleField() {
    return findByKeywords(FIELDS.title)
      ?? findByHeading(/^(song )?title$/i, "input, textarea");
  }

  function setNativeValue(element, value) {
    element.focus();
    const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // リッチエディタ（Lexical等）向け: 全選択→同期待ち→ペーストイベントで置き換える。
  // エディタ内部の選択同期が非同期のため、反映を確認しながら再試行する。
  async function setEditorValue(element, value, fieldLabel) {
    const normalize = (text) => (text || "").replace(/\s+/g, " ").trim();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      element.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      await sleep(150 + attempt * 150);
      const transfer = new DataTransfer();
      transfer.setData("text/plain", value);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
      await sleep(300);
      if (normalize(element.innerText) === normalize(value)) return;
    }
    throw new Error(`${fieldLabel}の貼り付けを確認できませんでした。Sunoの画面を開いた状態でもう一度お試しください。`);
  }

  async function fillField(element, value, fieldLabel) {
    if (element.isContentEditable) {
      await setEditorValue(element, value, fieldLabel);
      return;
    }
    setNativeValue(element, value);
    await sleep(200);
  }

  function findCreateButton() {
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter((element) => isVisible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true");
    return buttons.find((element) => /^(create|生成|作成)$/i.test((element.textContent || "").trim()))
      ?? buttons.find((element) => {
        const text = (element.textContent || "").toLowerCase();
        return text.includes("create") && !text.includes("custom") && !text.includes("model") && !text.includes("workspace");
      })
      ?? null;
  }

  // 空文字のフィールドは触らない＝Suno画面に入力済みの値を温存する
  async function processItem(item) {
    if (item.title) {
      const titleField = findTitleField();
      if (!titleField) throw new Error("タイトル入力欄が見つかりません。「タイトルを入力する」をオフにするか、Advancedモードを確認してください。");
      await fillField(titleField, item.title, "タイトル");
    }

    if (item.style) {
      const styleField = findStyleField();
      if (!styleField) throw new Error("スタイル入力欄が見つかりません。Advanced（旧Custom）モードを開いてください。");
      await fillField(styleField, item.style, "スタイル");
    }

    const lyricsField = findLyricsField();
    if (!lyricsField) throw new Error("Lyrics入力欄が見つかりません。Advanced（旧Custom）モードを開いてください。");
    await fillField(lyricsField, item.lyrics ?? item.prompt ?? "", "Lyrics");
    await sleep(700);

    // 入力直後はCreateが無効なことがあるため、有効化されるまで待って探す
    let createButton = null;
    for (let attempt = 0; attempt < 10 && !createButton; attempt += 1) {
      createButton = findCreateButton();
      if (!createButton) await sleep(500);
    }
    if (!createButton) throw new Error("有効なCreateボタンが見つかりません。リリックとスタイルが入力されているか確認してください。");
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
