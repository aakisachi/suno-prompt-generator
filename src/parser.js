const TITLE_KEYS = ["タイトル", "title", "曲名", "name"];
const STYLE_KEYS = ["スタイル", "style", "styles"];
const LYRICS_KEYS = ["リリック", "lyrics", "歌詞", "prompt", "プロンプト", "description"];

const DEFAULT_OPTIONS = { styleMode: "common", useTitle: false };
const LABEL_PATTERN = /^(タイトル|title|曲名|スタイル|style|リリック|lyrics|歌詞)\s*[:：]\s*(.*)$/i;
const SEPARATOR_PATTERN = /^\s*(-{3,}|\*{3,})\s*$/;

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function createItem({ title = "", style = "", lyrics = "" }, index) {
  return {
    id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    title: title.trim(),
    style: style.trim(),
    lyrics: lyrics.trim(),
    status: "waiting",
    error: "",
  };
}

function labelField(label) {
  const lower = label.toLowerCase();
  if (TITLE_KEYS.includes(lower)) return "title";
  if (STYLE_KEYS.includes(lower)) return "style";
  return "lyrics";
}

function parseBlocks(text) {
  const blocks = [];
  let current = [];
  text.split(/\r?\n/).forEach((line) => {
    if (SEPARATOR_PATTERN.test(line)) {
      if (current.length) blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  });
  if (current.length) blocks.push(current);

  return blocks.map((lines) => {
    const song = { title: "", style: "", lyricsLines: [] };
    let inLyrics = false;
    lines.forEach((line) => {
      const match = inLyrics ? null : line.match(LABEL_PATTERN);
      if (match) {
        const field = labelField(match[1]);
        if (field === "lyrics") {
          inLyrics = true;
          if (match[2]) song.lyricsLines.push(match[2]);
        } else {
          song[field] = match[2];
        }
      } else if (line.trim() || song.lyricsLines.length) {
        song.lyricsLines.push(line);
      }
    });
    return { title: song.title, style: song.style, lyrics: song.lyricsLines.join("\n") };
  });
}

function detectHeader(row) {
  const cells = row.map((value) => value.toLowerCase());
  const hasLyrics = cells.some((value) => LYRICS_KEYS.includes(value));
  const hasOther = cells.some((value) => TITLE_KEYS.includes(value) || STYLE_KEYS.includes(value));
  if (!hasLyrics || !hasOther) return null;
  return cells.map((value) => {
    if (TITLE_KEYS.includes(value)) return "title";
    if (STYLE_KEYS.includes(value)) return "style";
    if (LYRICS_KEYS.includes(value)) return "lyrics";
    return null;
  });
}

function parseRows(rows, options) {
  const header = detectHeader(rows[0] ?? []);
  const dataRows = header ? rows.slice(1) : rows;

  return dataRows.map((row) => {
    if (header) {
      const song = { title: "", style: "", lyrics: "" };
      header.forEach((field, index) => {
        if (field && row[index]) song[field] = row[index];
      });
      return song;
    }

    const columns = [];
    if (options.useTitle) columns.push("title");
    if (options.styleMode === "perSong") columns.push("style");

    if (row.length === 1) return { lyrics: row[0] };
    const song = { title: "", style: "", lyrics: "" };
    const used = columns.slice(0, row.length - 1);
    used.forEach((field, index) => {
      song[field] = row[index];
    });
    song.lyrics = row.slice(used.length).join(", ");
    return song;
  });
}

export function parsePromptText(text, options = {}) {
  const merged = { ...DEFAULT_OPTIONS, ...options };
  const trimmed = text.trim();
  if (!trimmed) return [];

  const isBlockFormat = trimmed.split(/\r?\n/).some(
    (line) => SEPARATOR_PATTERN.test(line) || LABEL_PATTERN.test(line),
  );
  const songs = isBlockFormat ? parseBlocks(trimmed) : parseRows(parseCsvRows(trimmed), merged);

  return songs
    .map((song, index) => createItem(song, index))
    .filter((item) => item.lyrics);
}

export function migrateItem(item) {
  if (!item) return item;
  const { prompt, ...rest } = item;
  return {
    ...rest,
    title: item.title ?? "",
    style: item.style ?? "",
    lyrics: item.lyrics ?? prompt ?? "",
  };
}

export function summarizeQueue(queue) {
  return queue.reduce(
    (summary, item) => {
      summary[item.status] = (summary[item.status] || 0) + 1;
      return summary;
    },
    { waiting: 0, processing: 0, complete: 0, failed: 0 },
  );
}
