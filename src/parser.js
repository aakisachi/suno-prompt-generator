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

function createItem(title, prompt, index) {
  return {
    id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    title: title || `曲 ${index + 1}`,
    prompt,
    status: "waiting",
    error: "",
  };
}

export function parsePromptText(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const rows = parseCsvRows(trimmed);
  const first = rows[0]?.map((value) => value.toLowerCase()) ?? [];
  const hasHeader = first.some((value) => ["title", "曲名", "name"].includes(value))
    && first.some((value) => ["prompt", "プロンプト", "description"].includes(value));
  const dataRows = hasHeader ? rows.slice(1) : rows;

  return dataRows
    .map((row, index) => {
      if (row.length >= 2) return createItem(row[0], row.slice(1).join(", "), index);
      return createItem("", row[0], index);
    })
    .filter((item) => item.prompt);
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
