(() => {
  if (window.__sunoPromptRunnerLoaded) return;
  window.__sunoPromptRunnerLoaded = true;

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  let inputChain = Promise.resolve();
  function checkDeadline(item) {
    if (!item.attemptId || !Number.isFinite(item.deadline) || Date.now() >= item.deadline) {
      throw new Error("入力の期限が切れました。生成ボタンは押しません。");
    }
  }

  const FIELD_SELECTOR = 'textarea, [contenteditable="true"], input[type="text"], input:not([type])';

  // Sunoは表示言語で要素名が変わる（例: Lyrics editor / 歌詞エディタ、Song Title / 曲名）ため
  // 英語・日本語の両方のキーワードを持つ
  const FIELDS = {
    lyrics: {
      include: ["lyrics", "lyric", "歌詞", "リリック"],
      exclude: ["style", "スタイル", "description", "describe", "title", "タイトル", "曲名", "exclude", "除外", "cowriter"],
      preferLarge: true,
    },
    style: {
      include: ["style", "styles", "スタイル"],
      exclude: ["exclude", "除外", "lyrics", "lyric", "歌詞", "リリック", "title", "タイトル", "曲名", "cowriter", "プロンプト"],
      preferLarge: false,
    },
    title: {
      include: ["title", "タイトル", "曲名"],
      exclude: ["style", "スタイル", "lyrics", "歌詞", "リリック", "playlist", "exclude", "除外", "cowriter"],
      preferLarge: false,
    },
  };

  const HEADINGS = {
    lyrics: /^(lyrics|歌詞|リリック)$/i,
    style: /^(styles?|スタイル)$/i,
    title: /^((song )?title|曲名|タイトル)$/i,
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

  function firstVisible(selectors) {
    for (const selector of selectors) {
      const field = [...document.querySelectorAll(selector)]
        .find((element) => isVisible(element) && !element.disabled);
      if (field) return field;
    }
    return null;
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

  // セクション見出し（歌詞 / スタイル など）から親を辿って入力欄を探す。
  // 同じ親に別の欄が同居することがあるため、除外語に当たる欄は候補から外す。
  function findByHeading(headingPattern, selector, exclude = []) {
    const headers = [...document.querySelectorAll("div, span, button, h1, h2, h3")]
      .filter((element) => {
        const text = (element.textContent || "").trim();
        return text.length < 20 && headingPattern.test(text);
      });
    for (const header of headers) {
      let node = header;
      for (let depth = 0; depth < 6 && node; depth += 1) {
        node = node.parentElement;
        if (!node) break;
        const field = [...node.querySelectorAll(selector)].find(
          (element) => isVisible(element)
            && !element.disabled
            && !exclude.some((keyword) => attrText(element).includes(keyword)),
        );
        if (field) return field;
      }
    }
    return null;
  }

  // シンプルモードで誤ってSong Description欄へ入力しないよう、確実に特定できた場合だけ返す
  function findLyricsField() {
    // Suno v6では歌詞欄に専用のaria-labelが付いた。似た編集パネルより最優先する。
    return firstVisible([
      '[contenteditable="true"][aria-label="歌詞エディタ"]',
      '[contenteditable="true"][aria-label="Lyrics editor" i]',
      '[role="textbox"][aria-label*="歌詞"]',
      '[role="textbox"][aria-label*="lyrics" i]',
    ])
      ?? findByKeywords(FIELDS.lyrics)
      ?? findByHeading(HEADINGS.lyrics, '[contenteditable="true"], textarea', FIELDS.lyrics.exclude);
  }

  // Suno v6では作成フォーム専用wrapperが付いた。同名タブを持つ別の編集パネルを除外する。
  function findStyleField() {
    return firstVisible([
      '[data-testid="create-form-styles-wrapper"] textarea',
      '[data-testid="create-form-styles-wrapper"] [contenteditable="true"]',
    ])
      ?? findByHeading(HEADINGS.style, 'textarea, [contenteditable="true"]', FIELDS.style.exclude)
      ?? findByKeywords(FIELDS.style);
  }

  function findTitleField() {
    return findByKeywords(FIELDS.title)
      ?? findByHeading(HEADINGS.title, "input, textarea", FIELDS.title.exclude);
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

  // 「新しいworkspaceを作成 / Create new workspace」など別用途のボタンを掴まないよう除外する
  const CREATE_EXACT = /^(create|生成|作成)$/i;
  const CREATE_PARTIAL = /(create|作成|生成)/i;
  const CREATE_EXCLUDE = /(workspace|ワークスペース|custom|カスタム|model|モデル|playlist|プレイリスト|persona|ペルソナ)/i;

  function findCreateButton() {
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter((element) => isVisible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true");
    return buttons.find((element) => /^(create song|曲を作成|曲を生成)$/i.test((element.getAttribute("aria-label") || "").trim()))
      ?? buttons.find((element) => CREATE_EXACT.test((element.textContent || "").trim()))
      ?? buttons.find((element) => {
        const text = (element.textContent || "").trim();
        return text.length < 24 && CREATE_PARTIAL.test(text) && !CREATE_EXCLUDE.test(text);
      })
      ?? null;
  }

  // 空文字のフィールドは触らない＝Suno画面に入力済みの値を温存する
  async function processItem(item) {
    checkDeadline(item);
    if (item.title) {
      const titleField = findTitleField();
      if (!titleField) throw new Error("曲名の入力欄が見つかりません。「タイトルを入力する」をオフにするか、アドバンスド（Advanced）モードを確認してください。");
      await fillField(titleField, item.title, "タイトル");
      checkDeadline(item);
    }

    if (item.style) {
      const styleField = findStyleField();
      if (!styleField) throw new Error("スタイル入力欄が見つかりません。アドバンスド（Advanced）モードを開いてください。");
      await fillField(styleField, item.style, "スタイル");
      checkDeadline(item);
    }

    const lyricsField = findLyricsField();
    if (!lyricsField) throw new Error("歌詞の入力欄が見つかりません。アドバンスド（Advanced）モードを開いてください。");
    await fillField(lyricsField, item.lyrics ?? item.prompt ?? "", "Lyrics");
    checkDeadline(item);
    await sleep(700);

    // 入力直後はCreateが無効なことがあるため、有効化されるまで待って探す
    let createButton = null;
    for (let attempt = 0; attempt < 60 && !createButton; attempt += 1) {
      checkDeadline(item);
      createButton = findCreateButton();
      if (!createButton) await sleep(500);
    }
    if (!createButton) throw new Error("有効なCreateボタンが見つかりません。リリックとスタイルが入力されているか確認してください。");
    checkDeadline(item);
    const permission = await chrome.runtime.sendMessage({ type: "AUTHORIZE_CLICK", attemptId: item.attemptId });
    if (!permission?.ok) throw new Error(permission?.error || "生成が取り消されました。");
    checkDeadline(item);
    // Nothing asynchronous between the final deadline check and this one click.
    createButton.click();
    try {
      await chrome.runtime.sendMessage({ type: "CONFIRM_CLICK", attemptId: item.attemptId });
    } catch { /* Return the click receipt as a second acknowledgement channel. */ }
    return { ok: true, clicked: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "PROCESS_ITEM_V2") return false;

    // A revoked old request must finish before a retry edits the same form.
    const task = inputChain.then(() => processItem(message.item));
    inputChain = task.catch(() => {});
    task
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();
