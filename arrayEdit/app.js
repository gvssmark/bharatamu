/*
  JS Array Table Editor
  ---------------------
  Expected source form:
      const padyamData = [
        ["...", "...", ...],
        ...
      ];

  The parser accepts normal JS array literals containing strings, numbers,
  booleans and null. It does NOT execute the uploaded JavaScript file.
*/

const ORIGINAL_COLUMNS = [
  "Parva", "Asvasa", "Header", "Padyam Number", "Padyam Type", "Padyam Text"
];

const EXTRA_COLUMNS = ["Input 1", "Input 2", "Input 3"];

let state = {
  fileName: "",
  fileKey: "",
  variableName: "padyamData",
  rows: [],
  filteredIndexes: [],
  page: 1,
  pageSize: 50,
  search: "",
  originalText: ""
};

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  [
    "fileInput", "saveButton", "csvButton", "clearEditsButton", "clearDbButton",
    "fileInfo", "saveStatus", "saveText", "pageSize", "searchInput",
    "prevPage", "nextPage", "pageInfo", "message", "dataTable",
    "headerRow", "tableBody"
  ].forEach(id => els[id] = document.getElementById(id));

  els.fileInput.addEventListener("change", onFileSelected);
  els.saveButton.addEventListener("click", exportJs);
  els.csvButton.addEventListener("click", exportCsv);
  els.clearEditsButton.addEventListener("click", clearSavedEdits);
  els.clearDbButton.addEventListener("click", clearEntireIndexedDb);
  els.pageSize.addEventListener("change", () => {
    state.pageSize = Number(els.pageSize.value);
    state.page = 1;
    render();
  });
  els.searchInput.addEventListener("input", () => {
    state.search = els.searchInput.value;
    state.page = 1;
    render();
  });
  els.prevPage.addEventListener("click", () => {
    if (state.page > 1) { state.page--; render(); }
  });
  els.nextPage.addEventListener("click", () => {
    const pages = totalPages();
    if (state.page < pages) { state.page++; render(); }
  });

  updateButtons(false);
});

function setStatus(kind, text) {
  els.saveStatus.className = "status-dot " + (kind || "");
  els.saveText.textContent = text;
}

function updateButtons(enabled) {
  els.saveButton.disabled = !enabled;
  els.csvButton.disabled = !enabled;
  els.clearEditsButton.disabled = !enabled;
}

async function onFileSelected(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    setStatus("busy", "Reading file...");
    const text = await file.text();
    const parsed = parseJsArrayFile(text);

    state.fileName = file.name;
    state.fileKey = await sha256(text);
    state.variableName = parsed.variableName;
    state.rows = parsed.rows.map(row => normalizeRow(row));
    state.originalText = text;
    state.page = 1;
    state.search = "";
    els.searchInput.value = "";

    const restored = await loadEdits(state.fileKey);
    if (restored) {
      applyStoredEdits(restored);
      setStatus("saved", `Recovered saved edits • ${restored.count} cell(s)`);
    } else {
      setStatus("saved", "File loaded • changes will be saved automatically");
    }

    els.fileInfo.textContent =
      `${file.name} • ${state.rows.length.toLocaleString()} rows • array: ${state.variableName}`;

    els.message.textContent =
      "Edit the three yellow columns. Every edit is written to IndexedDB immediately. " +
      "If the computer loses power, reopening the same source file restores the saved edits.";

    updateButtons(true);
    render();

    // Ask the browser for persistent storage where supported.
    if (navigator.storage && navigator.storage.persist) {
      try { await navigator.storage.persist(); } catch (_) {}
    }
  } catch (error) {
    console.error(error);
    resetState();
    setStatus("error", "Could not read this JS array");
    els.message.textContent =
      "The file could not be parsed. This editor expects a JavaScript array literal, " +
      "for example: const padyamData = [[...], [...]];";
    alert("Could not parse the uploaded JavaScript array.\n\n" + error.message);
  }
}

function normalizeRow(row) {
  const result = Array.isArray(row) ? row.slice(0, 6) : [];
  while (result.length < 6) result.push("");
  // Three application-owned fields.
  result.push("", "", "");
  return result;
}

/*
  Safe array-literal parser:
  The uploaded file is treated as text; no Function()/eval() is used.
*/
function parseJsArrayFile(text) {
  const constMatch = text.match(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/
  );
  if (!constMatch) throw new Error("No const/let/var array assignment was found.");

  const variableName = constMatch[1];
  const start = text.indexOf("[", constMatch.index + constMatch[0].length);
  if (start < 0) throw new Error("Array opening bracket [ was not found.");

  const parser = new ArrayLiteralParser(text, start);
  const rows = parser.parseValue();

  if (!Array.isArray(rows)) throw new Error("The assigned value is not an array.");
  if (!rows.every(Array.isArray)) {
    throw new Error("The top-level array must contain rows that are arrays.");
  }

  return { variableName, rows };
}

class ArrayLiteralParser {
  constructor(text, start) {
    this.s = text;
    this.i = start;
  }

  skipSpaceAndComments() {
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (/\s/.test(c)) { this.i++; continue; }

      if (c === "/" && this.s[this.i + 1] === "/") {
        this.i += 2;
        while (this.i < this.s.length && this.s[this.i] !== "\n") this.i++;
        continue;
      }

      if (c === "/" && this.s[this.i + 1] === "*") {
        const end = this.s.indexOf("*/", this.i + 2);
        if (end < 0) throw new Error("Unterminated block comment.");
        this.i = end + 2;
        continue;
      }
      break;
    }
  }

  parseValue() {
    this.skipSpaceAndComments();
    const c = this.s[this.i];

    if (c === "[") return this.parseArray();
    if (c === '"' || c === "'") return this.parseString();

    const rest = this.s.slice(this.i);
    const numberMatch = rest.match(/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (numberMatch) {
      this.i += numberMatch[0].length;
      return Number(numberMatch[0]);
    }

    for (const [word, value] of [
      ["true", true], ["false", false], ["null", null]
    ]) {
      if (this.s.startsWith(word, this.i)) {
        this.i += word.length;
        return value;
      }
    }

    throw new Error(`Unexpected token near character ${this.i}.`);
  }

  parseArray() {
    this.i++; // [
    const arr = [];
    this.skipSpaceAndComments();

    if (this.s[this.i] === "]") {
      this.i++;
      return arr;
    }

    while (this.i < this.s.length) {
      arr.push(this.parseValue());
      this.skipSpaceAndComments();

      if (this.s[this.i] === ",") {
        this.i++;
        this.skipSpaceAndComments();
        if (this.s[this.i] === "]") { this.i++; return arr; } // trailing comma
        continue;
      }

      if (this.s[this.i] === "]") {
        this.i++;
        return arr;
      }

      throw new Error(`Expected comma or ] near character ${this.i}.`);
    }

    throw new Error("Unterminated array.");
  }

  parseString() {
    const quote = this.s[this.i++];
    let out = "";

    while (this.i < this.s.length) {
      const c = this.s[this.i++];

      if (c === quote) return out;

      if (c !== "\\") {
        out += c;
        continue;
      }

      if (this.i >= this.s.length) throw new Error("Unterminated string.");

      const e = this.s[this.i++];
      const simple = {
        "n": "\n", "r": "\r", "t": "\t", "b": "\b",
        "f": "\f", "v": "\v", "0": "\0"
      };

      if (Object.prototype.hasOwnProperty.call(simple, e)) {
        out += simple[e];
      } else if (e === "x") {
        const hex = this.s.slice(this.i, this.i + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error("Invalid \\x escape.");
        out += String.fromCharCode(parseInt(hex, 16));
        this.i += 2;
      } else if (e === "u") {
        if (this.s[this.i] === "{") {
          const end = this.s.indexOf("}", this.i + 1);
          if (end < 0) throw new Error("Invalid Unicode escape.");
          const hex = this.s.slice(this.i + 1, end);
          out += String.fromCodePoint(parseInt(hex, 16));
          this.i = end + 1;
        } else {
          const hex = this.s.slice(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("Invalid \\u escape.");
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 4;
        }
      } else if (e === "\n") {
        // JS line continuation
      } else {
        out += e;
      }
    }

    throw new Error("Unterminated string.");
  }
}

/* ---------- IndexedDB persistence ---------- */

const DB_NAME = "JsArrayTableEditorDB";
const DB_VERSION = 1;
let dbPromise;

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("files")) {
        db.createObjectStore("files", { keyPath: "fileKey" });
      }
      if (!db.objectStoreNames.contains("cells")) {
        const store = db.createObjectStore("cells", { keyPath: ["fileKey", "row", "col"] });
        store.createIndex("byFile", "fileKey", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

async function saveCell(fileKey, row, col, value) {
  const db = await openDb();

  await new Promise((resolve, reject) => {
    const tx = db.transaction(["files", "cells"], "readwrite");
    const files = tx.objectStore("files");
    const cells = tx.objectStore("cells");

    files.put({
      fileKey,
      fileName: state.fileName,
      variableName: state.variableName,
      updatedAt: Date.now(),
      rowCount: state.rows.length
    });

    cells.put({ fileKey, row, col, value, updatedAt: Date.now() });

    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

async function loadEdits(fileKey) {
  const db = await openDb();

  return await new Promise((resolve, reject) => {
    const tx = db.transaction("cells", "readonly");
    const store = tx.objectStore("cells").index("byFile");
    const req = store.getAll(IDBKeyRange.only(fileKey));

    req.onsuccess = () => resolve({
      count: req.result.length,
      cells: req.result
    });
    req.onerror = () => reject(req.error);
  });
}

function applyStoredEdits(saved) {
  for (const cell of saved.cells) {
    if (state.rows[cell.row]) state.rows[cell.row][cell.col] = cell.value;
  }
}

async function clearSavedEdits() {
  if (!state.fileKey) return;
  if (!confirm(
    "Clear all locally saved edits for this source file?\n\n" +
    "This does not change the original file. You can then reload it from disk."
  )) return;

  const db = await openDb();

  await new Promise((resolve, reject) => {
    const tx = db.transaction(["cells", "files"], "readwrite");
    const cells = tx.objectStore("cells").index("byFile");
    const req = cells.openKeyCursor(IDBKeyRange.only(state.fileKey));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    tx.objectStore("files").delete(state.fileKey);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });

  // Reset only the three application columns.
  for (const row of state.rows) {
    row[6] = row[7] = row[8] = "";
  }

  setStatus("saved", "Saved edits cleared");
  render();
}

async function clearEntireIndexedDb() {
  if (!confirm(
    "This will permanently delete ALL saved edits from this editor, for every JS file.\n\n"+
    "Your original JS files are not affected.\n\nContinue?"
  )) return;

  try {
    const db=await openDb();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(["files","cells"],"readwrite");
      tx.objectStore("files").clear();
      tx.objectStore("cells").clear();
      tx.oncomplete=resolve;
      tx.onerror=()=>reject(tx.error);
      tx.onabort=()=>reject(tx.error || new Error("Clear transaction aborted"));
    });
    for (const row of state.rows) { row[6]=row[7]=row[8]=""; }
    setStatus("saved","IndexedDB cleared");
    render();
  } catch(error) {
    console.error(error);
    setStatus("error","Could not clear IndexedDB");
    alert("Could not clear IndexedDB.\n\n"+error.message);
  }
}

function queueCellSave(row, col, value, inputElement) {
  setStatus("busy", "Saving...");

  // One IndexedDB transaction per edit. No debounce: this is deliberate,
  // so the edit is committed as soon as possible for power-loss protection.
  saveCell(state.fileKey, row, col, value)
    .then(() => {
      inputElement.classList.remove("dirty");
      setStatus("saved", "All changes saved locally");
    })
    .catch(error => {
      console.error(error);
      inputElement.classList.add("dirty");
      setStatus("error", "Could not save this edit");
    });
}

/* ---------- Table rendering ---------- */

function renderHeaders() {
  els.headerRow.innerHTML = "";

  // A <colgroup> makes the width belong to the entire column, like Excel
  // and Google Sheets, rather than changing only the header cell.
  let colgroup = els.dataTable.querySelector("colgroup");
  if (!colgroup) {
    colgroup = document.createElement("colgroup");
    els.dataTable.insertBefore(colgroup, els.dataTable.firstChild);
  }
  colgroup.innerHTML = "";

  const headings = ["#", ...ORIGINAL_COLUMNS, ...EXTRA_COLUMNS];
  headings.forEach((name, index) => {
    const col = document.createElement("col");
    col.dataset.col = index;
    colgroup.appendChild(col);

    const th = document.createElement("th");
    th.className = "resizable";
    th.dataset.col = index;
    th.textContent = name;
    if (index === 0) th.title = "Source row number";

    const handle = document.createElement("span");
    handle.className = "resize-handle";
    handle.title = "Drag column boundary to resize";
    handle.addEventListener("mousedown", startColumnResize);
    th.appendChild(handle);
    els.headerRow.appendChild(th);
  });

  restoreColumnWidths();
}

/* ---------- Excel / Google Sheets style column resizing ---------- */

const COLUMN_WIDTH_KEY = "jsArrayTableEditor.columnWidths.v2";
let resizeState = null;

function getColumnWidths() {
  try { return JSON.parse(localStorage.getItem(COLUMN_WIDTH_KEY) || "{}"); }
  catch (_) { return {}; }
}

function getColumnElement(index) {
  return els.dataTable.querySelector(`colgroup col[data-col="${index}"]`);
}

function restoreColumnWidths() {
  const widths = getColumnWidths();
  const defaults = [55, 90, 80, 220, 110, 120, 500, 190, 190, 190];
  for (let i=0; i<10; i++) {
    const col=getColumnElement(i);
    if (!col) continue;
    const width=Math.max(60, Number(widths[i] || defaults[i]));
    col.style.width=`${width}px`;
  }
}

function saveColumnWidth(index,width) {
  const widths=getColumnWidths();
  widths[index]=Math.max(60,Math.round(width));
  localStorage.setItem(COLUMN_WIDTH_KEY,JSON.stringify(widths));
}

function startColumnResize(event) {
  event.preventDefault();
  event.stopPropagation();
  const handle=event.currentTarget;
  const th=handle.parentElement;
  const col=getColumnElement(Number(th.dataset.col));
  if (!col) return;

  resizeState={
    index:Number(th.dataset.col),
    col,
    handle,
    startX:event.clientX,
    startWidth:th.getBoundingClientRect().width
  };
  handle.classList.add("dragging");
  document.body.classList.add("resizing");
  document.addEventListener("mousemove",onColumnResize);
  document.addEventListener("mouseup",stopColumnResize);
}

function onColumnResize(event) {
  if (!resizeState) return;
  const width=Math.max(60,resizeState.startWidth + event.clientX-resizeState.startX);
  resizeState.col.style.width=`${width}px`;
}

function stopColumnResize() {
  if (!resizeState) return;
  saveColumnWidth(resizeState.index,resizeState.col.getBoundingClientRect().width);
  resizeState.handle.classList.remove("dragging");
  document.body.classList.remove("resizing");
  document.removeEventListener("mousemove",onColumnResize);
  document.removeEventListener("mouseup",stopColumnResize);
  resizeState=null;
}

function matches(row, query) {
  if (!query) return true;
  return row.some(value =>
    String(value ?? "").toLocaleLowerCase().includes(query)
  );
}

function updateFilter() {
  const q = state.search.trim().toLocaleLowerCase();
  state.filteredIndexes = [];
  for (let i = 0; i < state.rows.length; i++) {
    if (matches(state.rows[i], q)) state.filteredIndexes.push(i);
  }
}

function totalPages() {
  return Math.max(1, Math.ceil(state.filteredIndexes.length / state.pageSize));
}

function render() {
  if (!state.rows.length) {
    els.dataTable.hidden = true;
    els.pageInfo.textContent = "Page 0 / 0";
    return;
  }

  updateFilter();
  const pages = totalPages();
  state.page = Math.min(Math.max(1, state.page), pages);

  renderHeaders();
  els.tableBody.innerHTML = "";

  const start = (state.page - 1) * state.pageSize;
  const visible = state.filteredIndexes.slice(start, start + state.pageSize);

  for (const rowIndex of visible) {
    const row = state.rows[rowIndex];
    const tr = document.createElement("tr");

    const numberCell = document.createElement("td");
    numberCell.className = "number-cell";
    numberCell.textContent = String(rowIndex + 1);
    tr.appendChild(numberCell);

    for (let col = 0; col < 9; col++) {
      const td = document.createElement("td");

      if (col < 6) {
        td.className = "original";
        td.textContent = String(row[col] ?? "");
      } else {
        td.className = "editable";
        const input = document.createElement("textarea");
        input.rows = 2;
        input.value = String(row[col] ?? "");
        input.dataset.row = rowIndex;
        input.dataset.col = col;

        input.addEventListener("input", () => {
          state.rows[rowIndex][col] = input.value;
          input.classList.add("dirty");
          queueCellSave(rowIndex, col, input.value, input);
        });

        td.appendChild(input);
      }

      tr.appendChild(td);
    }

    els.tableBody.appendChild(tr);
  }

  els.pageInfo.textContent =
    `Page ${state.page.toLocaleString()} / ${pages.toLocaleString()} • ` +
    `${state.filteredIndexes.length.toLocaleString()} matching rows`;

  els.dataTable.hidden = false;
}

function resetState() {
  state = {
    fileName: "", fileKey: "", variableName: "padyamData", rows: [],
    filteredIndexes: [], page: 1, pageSize: Number(els.pageSize.value),
    search: "", originalText: ""
  };
  updateButtons(false);
  els.dataTable.hidden = true;
}

/* ---------- Export ---------- */

function jsString(value) {
  return JSON.stringify(String(value ?? ""));
}

function exportJs() {
  if (!state.rows.length) return;

  const body = state.rows.map(row => {
    const values = row.map(value => {
      if (typeof value === "number") return String(value);
      if (typeof value === "boolean") return String(value);
      if (value === null) return "null";
      return jsString(value);
    });

    return "  [" + values.join(", ") + "]";
  }).join(",\n");

  const output =
`// Exported by JS Array Table Editor
// Original source: ${state.fileName}
// Original fields: 6
// Added fields: ${EXTRA_COLUMNS.join(", ")}
const ${state.variableName} = [
${body}
];

if (typeof module !== "undefined" && module.exports) {
  module.exports = ${state.variableName};
}
`;

  const base = state.fileName.replace(/\.[^.]+$/, "") || "array";
  downloadText(output, `${base}_edited.js`, "text/javascript;charset=utf-8");
  setStatus("saved", "New JS file exported");
}

function exportCsv() {
  if (!state.rows.length) return;

  const headings = ["Source Row", ...ORIGINAL_COLUMNS, ...EXTRA_COLUMNS];
  const lines = [headings.map(csvCell).join(",")];

  state.rows.forEach((row, index) => {
    lines.push([index + 1, ...row].map(csvCell).join(","));
  });

  const base = state.fileName.replace(/\.[^.]+$/, "") || "array";
  downloadText("\uFEFF" + lines.join("\r\n"), `${base}_edited.csv`, "text/csv;charset=utf-8");
}

function csvCell(value) {
  const s = String(value ?? "");
  return '"' + s.replace(/"/g, '""') + '"';
}

function downloadText(text, filename, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}
