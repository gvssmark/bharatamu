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
  originalText: "", selectedEditColumn: null, anyColumnEditEnabled: false,
  lastSavedAt: null,
  pendingWrites: 0,
  writeQueue: Promise.resolve()
};

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  [
    "fileInput", "saveButton", "csvButton", "clearEditsButton", "clearDbButton", "anyColumnSelect", "anyColumnToggle",
    "fileInfo", "saveStatus", "saveText", "pageSize", "searchInput",
    "prevPage", "nextPage", "pageInfo", "message", "dataTable",
    "headerRow", "tableBody"
  ].forEach(id => els[id] = document.getElementById(id));

  els.fileInput.addEventListener("change", onFileSelected);
  els.saveButton.addEventListener("click", exportJs);
  els.csvButton.addEventListener("click", exportCsv);
  els.clearEditsButton.addEventListener("click", clearSavedEdits);
  els.clearDbButton.addEventListener("click", clearEntireIndexedDb);
  els.backupButton.addEventListener("click", downloadBackup);
  els.restoreButton.addEventListener("click", () => els.restoreInput.click());
  els.restoreInput.addEventListener("change", restoreFromBackup);
  els.anyColumnSelect.addEventListener("change", onAnyColumnSelected);
  els.anyColumnToggle.addEventListener("click", toggleAnyColumnEditing);
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

  populateColumnSelector();
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
  els.backupButton.disabled = !enabled;
  els.restoreButton.disabled = !enabled;
}

async function onFileSelected(event) {
  const file = event.target.files[0];
  if (!file) return;

  // Reset the file input so the same file can be selected again later.
  event.target.value = "";

  try {
    setStatus("busy", "Reading JavaScript array...");
    const text = await file.text();

    // Parsing is completely independent of IndexedDB.
    const parsed = parseJsArrayFile(text);

    state.fileName = file.name;
    state.fileKey = await sha256(text);
    state.variableName = parsed.variableName;
    state.rows = parsed.rows.map(row => normalizeRow(row));
    state.originalText = text;
    state.page = 1;
    state.search = "";
    state.selectedEditColumn = null;
    state.anyColumnEditEnabled = false;
    els.searchInput.value = "";

    // IMPORTANT:
    // Show the parsed rows immediately. A browser-storage problem must
    // never make a valid JS file appear to contain zero rows.
    els.fileInfo.textContent =
      `${file.name} • ${state.rows.length.toLocaleString()} rows • array: ${state.variableName}`;

    els.message.textContent =
      "File loaded successfully. Input 1, Input 2 and Input 3 are editable. " +
      "Select an original column and turn editing ON only when required.";

    updateButtons(true);
    populateColumnSelector();
    render();

    // Storage/recovery is a SECOND step. Failure here must not discard the
    // successfully parsed table.
    try {
      const restoredSnapshot = await loadSnapshot(state.fileKey);
      const restored = await loadEdits(state.fileKey);

      if (restoredSnapshot && Array.isArray(restoredSnapshot.rows) &&
          restoredSnapshot.rows.length) {
        state.rows = restoredSnapshot.rows.map(row => normalizeRow(row));
        state.lastSavedAt = restoredSnapshot.updatedAt;

        els.fileInfo.textContent =
          `${file.name} • ${state.rows.length.toLocaleString()} rows • array: ${state.variableName}`;

        setStatus(
          "saved",
          `Recovered complete backup • ${restoredSnapshot.editedCells.toLocaleString()} edited cell(s)`
        );
        render();
      } else if (restored && restored.count > 0) {
        applyStoredEdits(restored);
        setStatus(
          "saved",
          `Recovered cell edits • ${restored.count.toLocaleString()} cell(s)`
        );
        render();
      } else {
        await saveSnapshot();
        setStatus("saved", "SAVED • recovery copy created");
      }
    } catch (storageError) {
      // The data is already displayed. Do NOT call resetState().
      console.error("Storage/recovery error:", storageError);
      setStatus("error", "Rows loaded • browser backup unavailable");
      els.message.textContent =
        "The JS array was loaded successfully, but browser recovery storage " +
        "could not be opened. You can still edit and use Download Backup.";
    }

    if (navigator.storage && navigator.storage.persist) {
      try { await navigator.storage.persist(); } catch (_) {}
    }

  } catch (error) {
    // Only actual parsing/file-reading errors reach this block.
    console.error("JavaScript array parsing error:", error);
    resetState();
    setStatus("error", "Could not read this JavaScript array");
    els.message.textContent =
      "The file could not be parsed. The file must contain a JavaScript " +
      "array such as: var Adi = [[...], [...]];";

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
const DB_VERSION = 2;
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
      if (!db.objectStoreNames.contains("snapshots")) {
        db.createObjectStore("snapshots", { keyPath: "fileKey" });
      }
    };

    req.onblocked = () => {
      reject(new Error(
        "IndexedDB upgrade is blocked by another open tab. Close older copies of this utility and try again."
      ));
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
      };
      resolve(db);
    };

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
    const tx = db.transaction(["cells", "files", "snapshots"], "readwrite");
    const cells = tx.objectStore("cells").index("byFile");
    const req = cells.openKeyCursor(IDBKeyRange.only(state.fileKey));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    tx.objectStore("files").delete(state.fileKey);
    tx.objectStore("snapshots").delete(state.fileKey);
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

function queueCellSave(row, col, value, inputElement) {
  setStatus("busy", "Saving edit...");

  saveEditAndSnapshot(row, col, value)
    .then(() => {
      inputElement.classList.remove("dirty");
    })
    .catch(error => {
      inputElement.classList.add("dirty");
      console.error(error);
    });
}

/* ---------- Table rendering ---------- */

function populateColumnSelector() {
  els.anyColumnSelect.innerHTML = '<option value="">Select column...</option>';
  ORIGINAL_COLUMNS.forEach((name, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = name;
    els.anyColumnSelect.appendChild(option);
  });
  els.anyColumnSelect.disabled = false;
  els.anyColumnToggle.disabled = true;
  els.anyColumnToggle.textContent = "OFF";
  els.anyColumnToggle.className = "edit-toggle off";
  state.selectedEditColumn = null;
  state.anyColumnEditEnabled = false;
}

function onAnyColumnSelected() {
  state.selectedEditColumn = els.anyColumnSelect.value === ""
    ? null : Number(els.anyColumnSelect.value);
  state.anyColumnEditEnabled = false;
  els.anyColumnToggle.disabled = state.selectedEditColumn === null || !state.rows.length;
  els.anyColumnToggle.textContent = "OFF";
  els.anyColumnToggle.className = "edit-toggle off";
  if (state.rows.length) render();
}

function toggleAnyColumnEditing() {
  if (state.selectedEditColumn === null) return;
  if (!state.rows.length) {
    alert("Please open a .js array file first.");
    return;
  }
  state.anyColumnEditEnabled = !state.anyColumnEditEnabled;
  els.anyColumnToggle.textContent = state.anyColumnEditEnabled ? "ON" : "OFF";
  els.anyColumnToggle.className = "edit-toggle " +
    (state.anyColumnEditEnabled ? "on" : "off");
  render();
}

function isColumnEditable(col) {
  // Input 1, Input 2 and Input 3 are always editable.
  if (col >= 6 && col <= 8) return true;
  // Original columns require explicit selection and ON state.
  return state.anyColumnEditEnabled && state.selectedEditColumn === col;
}

const COLUMN_WIDTH_KEY = "jsArrayTableEditor.columnWidths.v3";
let resizeState = null;

function getColumnWidths() {
  try { return JSON.parse(localStorage.getItem(COLUMN_WIDTH_KEY) || "{}"); }
  catch (_) { return {}; }
}

function saveColumnWidth(index, width) {
  const widths = getColumnWidths();
  widths[index] = Math.round(Math.max(60, width));
  localStorage.setItem(COLUMN_WIDTH_KEY, JSON.stringify(widths));
}

function startColumnResize(e) {
  e.preventDefault();
  e.stopPropagation();
  const th = e.currentTarget.parentElement;
  const col = els.dataTable.querySelector(`colgroup col[data-col="${th.dataset.col}"]`);
  resizeState = {
    index: Number(th.dataset.col),
    col,
    handle: e.currentTarget,
    startX: e.clientX,
    startWidth: col.getBoundingClientRect().width
  };
  resizeState.handle.classList.add("dragging");
  document.body.classList.add("resizing");
  document.addEventListener("mousemove", resizeColumn);
  document.addEventListener("mouseup", finishColumnResize);
}

function resizeColumn(e) {
  if (!resizeState) return;
  const width = Math.max(60, resizeState.startWidth + e.clientX - resizeState.startX);
  resizeState.col.style.width = `${width}px`;
}

function finishColumnResize() {
  if (!resizeState) return;
  saveColumnWidth(resizeState.index, resizeState.col.getBoundingClientRect().width);
  resizeState.handle.classList.remove("dragging");
  document.body.classList.remove("resizing");
  document.removeEventListener("mousemove", resizeColumn);
  document.removeEventListener("mouseup", finishColumnResize);
  resizeState = null;
}

function renderHeaders() {
  els.headerRow.innerHTML = "";

  // One <col> controls the width of every cell in that column, giving
  // spreadsheet-style resizing rather than resizing only the heading.
  let colgroup = els.dataTable.querySelector("colgroup");
  if (!colgroup) {
    colgroup = document.createElement("colgroup");
    els.dataTable.insertBefore(colgroup, els.dataTable.firstChild);
  }
  colgroup.innerHTML = "";

  const headings = ["#", ...ORIGINAL_COLUMNS, ...EXTRA_COLUMNS];
  const defaults = [55, 90, 80, 220, 110, 120, 500, 190, 190, 190];
  const widths = getColumnWidths();

  headings.forEach((name, index) => {
    const col = document.createElement("col");
    col.dataset.col = String(index);
    const width = Math.max(60, Number(widths[index] || defaults[index] || 150));
    col.style.width = `${width}px`;
    colgroup.appendChild(col);

    const th = document.createElement("th");
    th.className = "resizable";
    th.dataset.col = String(index);
    th.textContent = name;

    if (index === 0) {
      th.title = "Source row number";
    } else if (isColumnEditable(index - 1)) {
      th.classList.add("protected-edit");
      th.title = index - 1 < 6
        ? "EDIT MODE ON — this original column is editable"
        : "Input column — always editable";
    }

    const handle = document.createElement("span");
    handle.className = "resize-handle";
    handle.title = "Drag column boundary to resize";
    handle.addEventListener("mousedown", startColumnResize);
    th.appendChild(handle);
    els.headerRow.appendChild(th);
  });
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

      if (isColumnEditable(col)) {
        td.className = "editable" + (col < 6 ? " protected-edit" : "");
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
      } else {
        td.className = "original";
        td.textContent = String(row[col] ?? "");
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
    search: "", originalText: "", selectedEditColumn: null, anyColumnEditEnabled: false,
    lastSavedAt: null, pendingWrites: 0, writeQueue: Promise.resolve()
  };
  updateButtons(false);
  els.dataTable.hidden = true;
}

/* ---------- Export ---------- */

function jsString(value) {
  return JSON.stringify(String(value ?? ""));
}

function countEditedCells(rows) {
  let count = 0;
  for (const row of rows) {
    for (let col = 6; col <= 8; col++) {
      if (String(row[col] ?? "") !== "") count++;
    }
    // Count edits in original columns only when they differ from the
    // original source values is not available as a separate baseline here.
    // The snapshot still contains every value and is the recovery source.
  }
  return count;
}

async function storageAvailable() {
  try {
    await openDb();
    return true;
  } catch (error) {
    console.error("IndexedDB unavailable:", error);
    return false;
  }
}

async function saveSnapshot() {
  if (!state.fileKey || !state.rows.length) return;

  const snapshot = {
    fileKey: state.fileKey,
    fileName: state.fileName,
    variableName: state.variableName,
    rows: state.rows.map(row => row.slice()),
    updatedAt: Date.now(),
    editedCells: countEditedCells(state.rows)
  };

  const db = await openDb();

  await new Promise((resolve, reject) => {
    const tx = db.transaction(["files", "snapshots"], "readwrite");

    tx.objectStore("files").put({
      fileKey: state.fileKey,
      fileName: state.fileName,
      variableName: state.variableName,
      updatedAt: snapshot.updatedAt,
      rowCount: state.rows.length
    });

    tx.objectStore("snapshots").put(snapshot);

    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Snapshot transaction aborted"));
  });

  state.lastSavedAt = snapshot.updatedAt;
}

async function loadSnapshot(fileKey) {
  const db = await openDb();

  return await new Promise((resolve, reject) => {
    const tx = db.transaction("snapshots", "readonly");
    const req = tx.objectStore("snapshots").get(fileKey);

    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function saveEditAndSnapshot(row, col, value) {
  // Queue writes so rapid typing cannot cause overlapping transactions
  // to finish out of order.
  state.pendingWrites++;

  state.writeQueue = state.writeQueue
    .then(async () => {
      const db = await openDb();

      // Transaction 1: persist the individual cell and metadata.
      await new Promise((resolve, reject) => {
        const tx = db.transaction(["files", "cells"], "readwrite");
        tx.objectStore("files").put({
          fileKey: state.fileKey,
          fileName: state.fileName,
          variableName: state.variableName,
          updatedAt: Date.now(),
          rowCount: state.rows.length
        });
        tx.objectStore("cells").put({
          fileKey: state.fileKey,
          row,
          col,
          value,
          updatedAt: Date.now()
        });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Cell save aborted"));
      });

      // Transaction 2: save the complete current table.
      await saveSnapshot();

      state.pendingWrites--;
      setStatus("saved", `SAVED • ${state.rows.length.toLocaleString()} rows • ${state.pendingWrites ? state.pendingWrites + " write(s) pending" : "recovery copy current"}`);
    })
    .catch(error => {
      state.pendingWrites = Math.max(0, state.pendingWrites - 1);
      console.error(error);
      setStatus("error", "SAVE FAILED — do not close this page");
      throw error;
    });

  return state.writeQueue;
}

async function flushPendingWrites() {
  try {
    await state.writeQueue;
  } catch (_) {
    // Error is already reflected in the status.
  }
}

function makeJsOutput() {
  const body = state.rows.map(row => {
    const values = row.map(value => {
      if (typeof value === "number") return String(value);
      if (typeof value === "boolean") return String(value);
      if (value === null) return "null";
      return jsString(value);
    });
    return "  [" + values.join(", ") + "]";
  }).join(",\n");

  return `// Exported by JS Array Table Editor
// Original source: ${state.fileName}
var ${state.variableName} = [
${body}
];
`;
}

function downloadBackup() {
  if (!state.rows.length) return;

  const backup = {
    format: "JS Array Table Editor Backup",
    version: 2,
    sourceFile: state.fileName,
    variableName: state.variableName,
    savedAt: new Date().toISOString(),
    rows: state.rows
  };

  downloadText(
    JSON.stringify(backup),
    `${state.fileName.replace(/\.[^.]+$/, "")}_backup.json`,
    "application/json;charset=utf-8"
  );

  setStatus("saved", "Backup downloaded");
}

async function restoreFromBackup(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;

  try {
    const text = await file.text();
    const backup = JSON.parse(text);

    if (!backup || !Array.isArray(backup.rows)) {
      throw new Error("This is not a valid editor backup.");
    }

    if (!confirm(
      `Restore ${backup.rows.length.toLocaleString()} rows from this backup?\\n\\n` +
      "The current table will be replaced. This action can be undone only by restoring another backup."
    )) return;

    state.rows = backup.rows.map(row => normalizeRow(row));
    if (backup.variableName) state.variableName = backup.variableName;

    // Save restored state immediately.
    await saveSnapshot();

    setStatus("saved", "Backup restored and saved");
    render();
  } catch (error) {
    console.error(error);
    setStatus("error", "Backup restore failed");
    alert("Could not restore the backup.\\n\\n" + error.message);
  }
}

async function clearEntireIndexedDb() {
  if (!confirm("Delete ALL saved edits from this utility? Your original JS files will not be affected.")) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["files", "cells"], "readwrite");
      tx.objectStore("files").clear();
      tx.objectStore("cells").clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
    });
    for (const row of state.rows) { row[6] = ""; row[7] = ""; row[8] = ""; }
    setStatus("saved", "IndexedDB cleared");
    render();
  } catch (error) {
    console.error(error);
    setStatus("error", "Could not clear IndexedDB");
    alert("Could not clear IndexedDB.\n\n" + error.message);
  }
}

async function exportJs() {
  if (!state.rows.length) return;

  // Never export until all queued IndexedDB writes have completed.
  await flushPendingWrites();

  if (state.pendingWrites !== 0) {
    alert("Some edits are still being saved. Please wait until the status shows SAVED, then try again.");
    return;
  }

  const output = makeJsOutput();
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


/* Best-effort final flush. The important protection is that every edit is
   already queued immediately; pagehide only waits for any currently running
   IndexedDB transaction when the browser allows it. */
window.addEventListener("pagehide", () => {
  // Do not start a new write here. Existing IndexedDB transactions are already
  // durable; this handler intentionally avoids unreliable unload-time work.
});


/* Periodic recovery checkpoint.
   Every 30 seconds, if a file is loaded and no edit is currently being
   written, save the complete table again. */
setInterval(async () => {
  if (!state.fileKey || !state.rows.length || state.pendingWrites > 0) return;

  try {
    await saveSnapshot();
  } catch (error) {
    console.error("Periodic recovery checkpoint failed:", error);
  }
}, 30000);
