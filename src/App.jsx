import { useEffect, useMemo, useRef, useState } from "react";
import { parsePromptText, summarizeQueue } from "./parser.js";

const STATUS_LABELS = {
  waiting: "待機中",
  processing: "処理中",
  complete: "完了",
  failed: "失敗",
};

const isExtension = typeof chrome !== "undefined" && Boolean(chrome.storage?.local);

function getLocal(keys) {
  if (isExtension) return chrome.storage.local.get(keys);
  const result = {};
  keys.forEach((key) => {
    const value = localStorage.getItem(key);
    result[key] = value ? JSON.parse(value) : undefined;
  });
  return Promise.resolve(result);
}

function setLocal(values) {
  if (isExtension) return chrome.storage.local.set(values);
  Object.entries(values).forEach(([key, value]) => localStorage.setItem(key, JSON.stringify(value)));
  window.dispatchEvent(new Event("storage"));
  return Promise.resolve();
}

async function getActiveTab() {
  if (!isExtension) return { id: 1, url: "https://suno.com/create" };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isSunoUrl(url = "") {
  return /^https:\/\/(www\.)?(suno\.com|app\.suno\.ai)\//.test(url);
}

export function App() {
  const [queue, setQueue] = useState([]);
  const [runner, setRunner] = useState({ running: false, paused: false, currentId: null, message: "" });
  const [text, setText] = useState("");
  const [settings, setSettings] = useState({ intervalSeconds: 20 });
  const [showSettings, setShowSettings] = useState(false);
  const [notice, setNotice] = useState("");
  const fileInputRef = useRef(null);

  useEffect(() => {
    getLocal(["sunoQueue", "sunoRunner", "sunoSettings"]).then((stored) => {
      setQueue(stored.sunoQueue ?? []);
      setRunner(stored.sunoRunner ?? { running: false, paused: false, currentId: null, message: "" });
      setSettings(stored.sunoSettings ?? { intervalSeconds: 20 });
    });

    const update = () => {
      getLocal(["sunoQueue", "sunoRunner"]).then((stored) => {
        if (stored.sunoQueue) setQueue(stored.sunoQueue);
        if (stored.sunoRunner) setRunner(stored.sunoRunner);
      });
    };

    if (isExtension) chrome.storage.onChanged.addListener(update);
    else window.addEventListener("storage", update);
    return () => {
      if (isExtension) chrome.storage.onChanged.removeListener(update);
      else window.removeEventListener("storage", update);
    };
  }, []);

  const summary = useMemo(() => summarizeQueue(queue), [queue]);
  const finished = summary.complete + summary.failed;
  const progress = queue.length ? Math.round((finished / queue.length) * 100) : 0;

  async function persistQueue(nextQueue) {
    setQueue(nextQueue);
    await setLocal({ sunoQueue: nextQueue });
  }

  async function addPrompts(rawText = text) {
    const items = parsePromptText(rawText);
    if (!items.length) {
      setNotice("追加できるプロンプトがありません。");
      return;
    }
    await persistQueue([...queue, ...items]);
    setText("");
    setNotice(`${items.length}件をキューに追加しました。`);
  }

  async function handleFile(file) {
    if (!file) return;
    const content = await file.text();
    const items = parsePromptText(content);
    if (!items.length) {
      setNotice("CSVからプロンプトを読み取れませんでした。");
      return;
    }
    await persistQueue([...queue, ...items]);
    setNotice(`${items.length}件をCSVから追加しました。`);
  }

  async function sendToBackground(type, payload = {}, requireSunoTab = true) {
    if (!isExtension) {
      setNotice("拡張機能として読み込むとSunoへ送信できます。");
      return false;
    }
    let tabId = runner.tabId ?? null;
    if (requireSunoTab) {
      const tab = await getActiveTab();
      if (!tab?.id || !isSunoUrl(tab.url)) {
        setNotice("SunoのCreate画面を開いてから実行してください。");
        return false;
      }
      tabId = tab.id;
    }
    try {
      const response = await chrome.runtime.sendMessage({ type, tabId, ...payload });
      if (!response?.ok) throw new Error(response?.error || "バックグラウンド処理へ接続できません。");
      return true;
    } catch (error) {
      setNotice(error.message || "バックグラウンド処理へ接続できません。拡張機能を更新してください。");
      return false;
    }
  }

  async function start() {
    if (!queue.some((item) => item.status === "waiting" || item.status === "failed")) {
      setNotice("生成待ちの曲がありません。");
      return;
    }
    await setLocal({ sunoSettings: settings });
    const sent = await sendToBackground("START_QUEUE", { settings });
    if (sent) setNotice("バックグラウンド生成を開始しました。ポップアップを閉じても続行します。");
  }

  async function stop() {
    const sent = await sendToBackground("STOP_QUEUE", {}, false);
    if (sent) setNotice("停止しました。再開すると続きから処理します。");
  }

  async function retry(id) {
    const nextQueue = queue.map((item) => (item.id === id ? { ...item, status: "waiting", error: "" } : item));
    await persistQueue(nextQueue);
    setNotice("再試行待ちに戻しました。");
  }

  async function remove(id) {
    await persistQueue(queue.filter((item) => item.id !== id));
  }

  async function clearCompleted() {
    await persistQueue(queue.filter((item) => item.status !== "complete"));
  }

  async function clearQueue() {
    if (runner.running) {
      setNotice("生成を停止してからキューを削除してください。");
      return;
    }
    if (!window.confirm(`キューの${queue.length}件をすべて削除しますか？`)) return;
    await setLocal({
      sunoQueue: [],
      sunoRunner: { ...runner, paused: false, currentId: null, message: "キューをすべて削除しました。" },
    });
    setQueue([]);
    setRunner((current) => ({ ...current, paused: false, currentId: null, message: "キューをすべて削除しました。" }));
    setNotice("キューをすべて削除しました。");
  }

  async function saveSettings(nextSettings) {
    const normalized = {
      intervalSeconds: Math.min(300, Math.max(10, Number(nextSettings.intervalSeconds) || 20)),
    };
    setSettings(normalized);
    await setLocal({ sunoSettings: normalized });
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>Sunoプロンプト生成</h1>
          <p className="connection-label">Customモード・Lyrics用</p>
        </div>
        <button className="icon-button" type="button" aria-label="設定" onClick={() => setShowSettings(!showSettings)}>
          設定
        </button>
      </header>

      {showSettings && (
        <section className="settings-panel" aria-label="設定">
          <div>
            <strong>生成間隔</strong>
            <span>次のCreateを押すまでの待ち時間</span>
          </div>
          <label>
            <input
              type="number"
              min="10"
              max="300"
              value={settings.intervalSeconds}
              onChange={(event) => saveSettings({ intervalSeconds: event.target.value })}
            />
            秒
          </label>
          <button className="icon-button small" type="button" aria-label="設定を閉じる" onClick={() => setShowSettings(false)}>
            閉じる
          </button>
        </section>
      )}

      <section className="input-section">
        <div className="section-heading">
          <h2>Lyricsを貼り付け</h2>
          <p>1行に1件、または「曲名,Lyrics」のCSV</p>
        </div>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={'Neon Morning,"80s city pop, warm bass, instrumental"'}
          aria-label="Lyrics入力"
        />
        <div className="input-actions">
          <input ref={fileInputRef} type="file" accept=".csv,text/csv,text/plain" hidden onChange={(event) => handleFile(event.target.files?.[0])} />
          <button className="secondary-button" type="button" onClick={() => fileInputRef.current?.click()}>
            CSVを読み込む
          </button>
          <button className="primary-button compact" type="button" onClick={() => addPrompts()}>
            キューに追加
          </button>
        </div>
      </section>

      <section className="queue-section">
        <div className="queue-heading">
          <div>
            <h2>キュー（{queue.length}件）</h2>
            <span>{finished} / {queue.length}</span>
          </div>
          <div className="progress-track" aria-label={`進捗 ${progress}%`}>
            <div className="progress-value" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="queue-list">
          {queue.length === 0 ? (
            <div className="empty-state">
              <strong>生成キューは空です</strong>
              <span>プロンプトを追加してください。</span>
            </div>
          ) : queue.map((item, index) => (
            <article className={`queue-item status-${item.status}`} key={item.id}>
              <span className="item-number">{index + 1}</span>
              <div className="item-content">
                <strong>{item.title}</strong>
                <span title={item.prompt}>{item.prompt}</span>
                {item.error && <small>{item.error}</small>}
              </div>
              <div className={`status-chip ${item.status}`}>
                {STATUS_LABELS[item.status]}
              </div>
              <div className="item-actions">
                {item.status === "failed" && (
                  <button className="retry-button" type="button" onClick={() => retry(item.id)} aria-label={`${item.title}を再試行`}>
                    再試行
                  </button>
                )}
                <button className="icon-button small" type="button" onClick={() => remove(item.id)} aria-label={`${item.title}を削除`}>
                  削除
                </button>
              </div>
            </article>
          ))}
        </div>

        {queue.length > 0 && (
          <div className="queue-tools">
            {summary.complete > 0 && (
              <button className="clear-button" type="button" onClick={clearCompleted}>完了分を削除</button>
            )}
            <button className="clear-button danger" type="button" onClick={clearQueue}>キューをすべて削除</button>
          </div>
        )}
      </section>

      <div className="status-bar" role="status">
        <span className={runner.running ? "status-dot active" : "status-dot"} />
        <span>{notice || runner.message || (runner.running ? "バックグラウンドで生成中です。" : "SunoのCreate画面で開始してください。")}</span>
      </div>

      <footer className="action-footer">
        <button className="primary-button" type="button" onClick={start} disabled={runner.running && !runner.paused}>
          {runner.paused ? "再開" : "開始"}
        </button>
        <button className="stop-button" type="button" onClick={stop} disabled={!runner.running}>
          停止
        </button>
      </footer>
    </main>
  );
}
