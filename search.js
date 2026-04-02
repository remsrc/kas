let container = null;
let table = null;
let tbody = null;
let scrollTop = 0;
let scrollPending = false;
let lastStartRow = -1;
let lastEndRow = -1;
let progressTimer = null;
let startTime = null;
let totalMails = 0;
let mailIndex = new Map();
let currentMail = 0;
let indexingActive = false;
let searchPort = null;
let streamedResults = 0;
// Darstellung Ergebnisse
const renderedResults = new Set();
// Tabellendarstellung
let currentSort = {
    column: "date",
    dir: "desc"
};
let resultRows = [];
let currentSortColumn = "date";
let currentSortDir = -1;
let visibleColumns = ["date", "subject", "attachment"];
const COLUMN_DEFS = {
    date: {
        label: "Datum",
        value: r => formatDate(r.timestamp),
        sort: r => toSortableTimestamp(r.timestamp)
    },
    subject: {
        label: "Betreff",
        value: r => r.subject || "",
        sort: r => (r.subject || "").toLowerCase()
    },
    attachment: {
        label: "Anhang",
        value: r => r.attachmentName || "",
        sort: r => (r.attachmentName || "").toLowerCase()
    },
    patient: {
        label: "Patient",
        value: r => r.patient || "",
        sort: r => (r.patient || "").toLowerCase()
    },
    birth: {
        label: "Geburtsdatum",
        value: r => formatShortDate(r.birth),
        sort: r => toSortableTimestamp(r.birth)
    },
    gender: {
        label: "Geschlecht",
        value: r => r.gender || "",
        sort: r => (r.gender || "").toLowerCase()
    },
    doctor: {
        label: "Arzt",
        value: r => r.doctor || "",
        sort: r => (r.doctor || "").toLowerCase()
    },
    practice: {
        label: "Praxis",
        value: r => r.practice || "",
        sort: r => (r.practice || "").toLowerCase()
    },
    docDate: {
        label: "vom",
        value: r => formatShortDate(r.docDate),
        sort: r => toSortableTimestamp(r.docDate)
    }
};
const COLUMN_DEFS_ORDER = [
    "date",
    "docDate",
    "patient",
    "subject",
    "attachment",
    "birth",
    "gender",
    "doctor",
    "practice"
];
// columnChooser erstellen
let columnChooser = COLUMN_DEFS_ORDER.map(key => ({
            key,
            label: COLUMN_DEFS[key].label,
            visible: true,
            width: null
        }));
const ROW_HEIGHT = 24;
const BUFFER_ROWS = 20;
const PROTECT_AT_LEAST_ONE_COLUMN = true;
function toSortableTimestamp(value) {
    if (value == null || value === "")
        return 0;
    if (typeof value === "number")
        return Number.isFinite(value) ? value : 0;
    if (value instanceof Date) {
        const t = value.getTime();
        return Number.isFinite(t) ? t : 0;
    }
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : 0;
}
function formatShortDate(dateStr) {
    if (!dateStr)
        return "";
    const s = String(dateStr).trim();
    // HL7 Format: YYYYMMDD
    if (/^\d{8}$/.test(s)) {
        return `${s.slice(6, 8)}.${s.slice(4, 6)}.${s.slice(0, 4)}`;
    }
    // HL7 Format: YYYYMMDDHHMM
    if (/^\d{12}$/.test(s)) {
        return `${s.slice(6, 8)}.${s.slice(4, 6)}.${s.slice(0, 4)}`;
    }
    // HL7 Format: YYYYMMDDHHMMSS
    if (/^\d{14}$/.test(s)) {
        return `${s.slice(6, 8)}.${s.slice(4, 6)}.${s.slice(0, 4)}`;
    }
    // Fallback: ISO oder JS-kompatibles Datum
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
        return d.toLocaleDateString("de-DE");
    }
    return s; // letzter fallback
}
async function loadColumnSettings() {
    const s = await browser.storage.local.get(["visibleColumns", "sortSettings"]);
    if (Array.isArray(s.visibleColumns) && s.visibleColumns.length) {
        visibleColumns = s.visibleColumns;
    }
    if (s.sortSettings && COLUMN_DEFS[s.sortSettings.column]) {
        currentSortColumn = s.sortSettings.column;
        currentSortDir = s.sortSettings.dir === -1 ? -1 : 1;
    }
    const res = await browser.storage.local.get("columnSettings");
    if (Array.isArray(res.columnSettings) && res.columnSettings.length) {
        const byKey = new Map(res.columnSettings.map(c => [c.key, c]));
        columnChooser = COLUMN_DEFS_ORDER.map(key => {
            const stored = byKey.get(key);
            return {
                key,
                label: COLUMN_DEFS[key].label,
                visible: stored?.visible ?? visibleColumns.includes(key),
                width: Number.isFinite(stored?.width) ? stored.width : null
            };
        });
    } else {
        columnChooser = COLUMN_DEFS_ORDER.map(key => ({
            key,
            label: COLUMN_DEFS[key].label,
            visible: visibleColumns.includes(key),
            width: null
        }));
    }
    // Sichtbarkeit konsistent halten
    visibleColumns = columnChooser.filter(c => c.visible).map(c => c.key);
    if (!visibleColumns.length && columnChooser.length) {
        columnChooser[0].visible = true;
        visibleColumns = [columnChooser[0].key];
    }
}
async function saveColumnSettings() {
    await browser.storage.local.set({
        visibleColumns,
        columnSettings: columnChooser,
        sortSettings: {
            column: currentSortColumn,
            dir: currentSortDir
        }
    });
}
async function loadSettings() {
    const s = await browser.storage.local.get([
                "wholeWords"
            ]);
    document.getElementById("whole-words").checked = s.wholeWords ?? true;
}
function ensurePort() {
    if (searchPort) return;

    searchPort = browser.runtime.connect({
        name: "search-window"
    });

    searchPort.onMessage.addListener(handleMessage);

    searchPort.onDisconnect.addListener(() => {
        console.warn("Port disconnected");
        searchPort = null;
    });
}
async function getMailTabId() {
    const wins = await browser.windows.getAll({
        populate: true
    });
    // Hauptfenster finden
    const mainWin = wins.find(w => w.type === "normal");
    if (!mainWin) {
        console.error("Kein Hauptfenster gefunden");
        return null;
    }
    // MailTab finden
    const mailTab = mainWin.tabs.find(t => t.mailTab || t.type === "mail");
    if (!mailTab) {
        console.error("Kein MailTab im Hauptfenster gefunden");
        return null;
    }
    //	console.log("TabId erneuert: " + mailTab.id);
    return mailTab.id;
}
async function saveSettings(wholeWords) {
    try {
        await browser.storage.local.set({
            wholeWords: wholeWords
        });
    } catch (e) {
        console.warn("Settings konnten nicht gespeichert werden:", e);
    }
}
// Suche / Indexierung starten
async function startSearch() {
    const query = document.getElementById("query").value.trim();
    const wholeWords = document.getElementById("whole-words").checked;
    const tabId = await getMailTabId();
    const accountId = accountSelect.value; // -ID aus Dropdown/Selection
    //	console.log("startSearch: accountId: " + accountId);
    saveSettings(wholeWords);
    // Anzeige löschen
    renderedResults.clear();
    resultRows = [];
    mailIndex = new Map();
    lastStartRow = -1;
    lastEndRow = -1;
    renderPending = false;
    scrollPending = false;
    document.getElementById("results").innerHTML = "";
    table = null;
    tbody = null;
    container = null;
    startTime = Date.now();
    currentMail = 0;
    totalMails = 0;
    indexingActive = false;
    streamedResults = 0;
    document.getElementById("results").innerHTML = "";
    document.getElementById("indexStatus").textContent = "⚙️ Indexierung läuft…";
    if (progressTimer)
        clearInterval(progressTimer);
    progressTimer = setInterval(updateProgress, 1000);
    // 🔹 Immer Indexierung starten, auch bei leerem Query
    safePost({
        type: "run-attachment-search",
        tabId,
        accountId,
        query, // kann leer sein
        wholeWords
    });
}
// Fortschritt aktualisieren (ETA)
// Neue Funktionen
function updateIndexStatus(text) {
    const el = document.getElementById("indexStatus");
    if (el)
        el.textContent = text;
}
function updateResultStatus(text) {
    const el = document.getElementById("resultStatus");
    if (el)
        el.textContent = text;
}
function updateResultStatusFromRows() {
    const mailCount = resultRows.filter(r => r.isMailHeader).length;
    const attachmentCount = resultRows.length - mailCount;
    if (mailCount === 0 && attachmentCount === 0) {
        updateResultStatus("Keine Treffer.");
        return;
    }
    updateResultStatus(`${mailCount} Mail(s), ${attachmentCount} Anhang/Anhänge.`);
}
// updateProgress anpassen
function updateProgress(done) {
    if (!indexingActive && done) {
        updateIndexStatus("");
        return;
    }
    if (totalMails === 0) {
        updateIndexStatus("");
        return;
    }
    const elapsed = (Date.now() - startTime) / 1000;
    const perMail = currentMail > 0 ? elapsed / currentMail : 0;
    const remaining = (totalMails - currentMail) * perMail;
    const min = Math.floor(remaining / 60);
    const sec = Math.floor(remaining % 60);
    const percent = Math.floor((currentMail / totalMails) * 100);
    if (!done)
        updateIndexStatus(`⚙️ Indexiere Mail ${currentMail} von ${totalMails} (${percent}%) – ca. ${min}m ${sec}s verbleibend`);
    else
        updateIndexStatus("");
}
//
// displayResults
//
// mit Mailgruppierung
async function displayResults(msg) {
    if (!msg?.results) return;

    ensurePort(); // 🔥 wichtig bei Streams

    // 🔴 Reset bei neuer Suche
	if (msg.type === "search-results") {
		renderedResults.clear();
		resultRows = [];
		mailIndex = new Map();

		// 🔥 DAS FEHLT:
		lastStartRow = -1;
		lastEndRow = -1;
	}
	if (!table) renderTableStructure();
    // =========================================================
    // 🔥 NEU: Message → Attachment Expansion (Adapter)
    // =========================================================
    let expandedResults = [];

    for (const m of msg.results) {
        // Falls schon altes Format → direkt übernehmen
        if (!m.attachments) {
            expandedResults.push(m);
            continue;
        }

        // Neues Format → auf Attachment-Level expandieren
        for (const att of m.attachments) {
            expandedResults.push({
                messageId: m.messageId,
                folderId: m.folderId,
                timestamp: m.timestamp,
                subject: m.subject,
                unread: m.unread,
                tags: m.tags,

                patient: m.patient,
                birth: m.birth,
                gender: m.gender,
                doctor: m.doctor,
                practice: m.practice,
                docDate: m.docDate,

                attachmentName: att.attachmentName,
                type: att.type,
                tokenized: att.tokenized,
                match: att.match
            });
        }
    }

    // =========================================================
    // 🔍 Filter (UI)
    // =========================================================
    const filtered = expandedResults;

    // =========================================================
    // 📬 Gruppierung + Rendering
    // =========================================================
    for (const r of filtered) {
        const docKey = r.messageId + "|" + r.attachmentName;
        if (renderedResults.has(docKey)) continue;
        renderedResults.add(docKey);

        let mailRowIndex = mailIndex.get(r.messageId);

        // ===== 📧 Mail-Header =====
        if (mailRowIndex === undefined) {
            const headerRow = {
                isMailHeader: true,
                timestamp: r.timestamp,
                messageId: r.messageId,
                folderId: r.folderId,
                subject: r.subject,
                unread: r.unread,
                tags: r.tags,

                attachmentName: "📧 Mail",

                patient: r.patient,
                birth: r.birth,
                gender: r.gender,
                doctor: r.doctor,
                practice: r.practice,
                docDate: r.docDate
            };

            mailRowIndex = resultRows.length;
            mailIndex.set(r.messageId, mailRowIndex);
            resultRows.push(headerRow);
        }

        // ===== 📎 Dokument =====
        const docRow = {
            isMailHeader: false,
            timestamp: r.timestamp,
            messageId: r.messageId,
            folderId: r.folderId,
            subject: "",
            unread: false,

            attachmentName: r.attachmentName,
            attachmentExt: r.attachmentName.split('.').pop().toUpperCase(),
            patient: "",
            birth: "",
            gender: "",
            doctor: "",
            practice: "",
            docDate: "",

            // 🔥 NEU (optional nutzbar im UI)
            type: r.type,
            tokenized: r.tokenized,
            match: r.match
        };

        resultRows.splice(mailRowIndex + 1, 0, docRow);

        // 👉 Indizes nachziehen
        for (const [id, idx] of mailIndex) {
            if (idx > mailRowIndex) {
                mailIndex.set(id, idx + 1);
            }
        }
    }

	applyCurrentSort();
	requestRender();
	updateResultStatusFromRows();
}
let renderPending = false;

function requestRender() {
    if (renderPending) return;
    renderPending = true;

    requestAnimationFrame(() => {
        updateViewport();
        renderPending = false;
    });
}
function safePost(msg) {
    try {
        ensurePort();
        searchPort.postMessage(msg);
    } catch (e) {
        console.warn("Port geschlossen, Nachricht verworfen:", e);
    }
}
// Nachrichten vom Background empfangen
async function handleMessage(msg) {
    if (!msg)
        return;
	if (msg.type === "doc-progress") {
    updateIndexStatus(
        `📄 Dokumente: ${msg.current} / ${msg.total} verarbeitet`
    );
}
    if (msg.type === "index-progress") {
        indexingActive = true;
        currentMail = msg.current;
        totalMails = msg.total;
        startTime ||= Date.now();
        if (!msg.total || msg.total <= 0) {
            indexingActive = false;
            updateIndexStatus("");
            return;
        }
        const done = msg.current >= msg.total; // Fertig, wenn alle Mails abgearbeitet
        if (done)
            indexingActive = false;
        updateProgress(done);
        return;
    }
    if (msg.type === "accounts-list") {
        // console.log("accounts-list empfangen:", msg.accounts);
        const select = document.getElementById("accountSelect");
        let firstKim = null;
        msg.accounts.forEach(acc => {
            const option = document.createElement("option");
            option.value = acc.id;
            option.textContent = acc.name;
            const isKim = acc.identities?.some(i =>
                    i.email?.toLowerCase().endsWith(".kim.telematik"));
            if (isKim) {
                option.classList.add("kim");
                firstKim ??= acc.id;
            } else {
                option.classList.add("normal");
            }
            select.appendChild(option);
        });
        if (firstKim)
            select.value = firstKim;
        else
            alert("Kein KIM-Postfach gefunden. Die Suche funktioniert nur eingeschränkt.");
        return;
    }
    if (msg.type === "search-results") {
        if (!msg.results)
            return;
		updateIndexStatus("");
        displayResults(msg);
        return;
    }
	if (msg.type === "search-stream-result") {
		if (!msg.result) return;

		streamedResults++;

		msg.results = [msg.result];
		displayResults(msg);
		return;
	}
}
//
// ============== Darstellung ==================
//
function sortResults() {
    const def = COLUMN_DEFS[currentSort.column];
    if (!def)
        return;
    resultRows.sort((a, b) => {
        const v1 = def.sort(a);
        const v2 = def.sort(b);
        if (v1 < v2)
            return currentSort.dir === "asc" ? -1 : 1;
        if (v1 > v2)
            return currentSort.dir === "asc" ? 1 : -1;
        return 0;
    });
}
function openColumnMenu(x, y) {
    const old = document.getElementById("columnMenu");
    if (old)
        old.remove();
    const menu = document.createElement("div");
    menu.id = "columnMenu";
    menu.style.position = "fixed";
    menu.style.left = x + "px";
    menu.style.top = y + "px";
    menu.style.background = "#fff";
    menu.style.border = "1px solid #aaa";
    menu.style.padding = "4px";
    menu.style.zIndex = 10000;
    menu.style.boxShadow = "0 2px 6px rgba(0,0,0,0.2)";
    columnChooser.forEach(col => {
        const item = document.createElement("div");
        item.textContent = (col.visible ? "✔ " : "   ") + col.label;
        item.style.cursor = "pointer";
        item.style.padding = "2px 6px";
        item.onclick = () => {
            const visibleCount = columnChooser.filter(c => c.visible).length;
            if (PROTECT_AT_LEAST_ONE_COLUMN && col.visible && visibleCount <= 1) {
                alert("Mindestens eine Spalte muss sichtbar bleiben.");
                menu.remove();
                return;
            }
            col.visible = !col.visible;
            if (col.visible) {
                if (!visibleColumns.includes(col.key))
                    visibleColumns.push(col.key);
            } else {
                visibleColumns = visibleColumns.filter(c => c !== col.key);
            }
            saveColumnSettings();
			renderTableStructure();
			requestRender();
            menu.remove();
        };
        menu.appendChild(item);
    });
    document.body.appendChild(menu);
    setTimeout(() => {
        document.addEventListener("click", () => menu.remove(), {
            once: true
        });
    }, 10);
}
function saveScrollState() {
    const scrollTop = container.scrollTop;
    const firstVisibleRow =
        Math.floor(scrollTop / ROW_HEIGHT);
    return {
        scrollTop,
        firstVisibleRow
    };
}
function restoreScrollState(state) {
    if (!state)
        return;
    const newScrollTop =
        state.firstVisibleRow * ROW_HEIGHT;
    container.scrollTop = newScrollTop;
}
function renderTableStructure() {
    container = document.getElementById("results");
    container.innerHTML = "";
    lastStartRow = -1;
    lastEndRow = -1;
    table = document.createElement("table");
    table.id = "resultsTable";
    container.appendChild(table);
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    columnChooser.forEach((col) => {
        if (!col.visible)
            return;
        const th = document.createElement("th");
        if (col.width)
            th.style.width = col.width + "px";
        th.style.minWidth = "40px";
        let label = col.label;
        if (currentSortColumn === col.key) {
            label += currentSortDir === 1 ? " ▲" : " ▼";
        }
        th.textContent = label;
        // Sortierung
        th.addEventListener("click", () => handleSort(col));
        // Kontextmenü
        th.addEventListener("contextmenu", e => {
            e.preventDefault();
            openColumnMenu(e.pageX, e.pageY);
        });
        // Manuelle Spaltenbreite per Drag
        const resizer = document.createElement("div");
        resizer.className = "col-resizer";
        th.appendChild(resizer);
        resizer.addEventListener("mousedown", e => {
            e.stopPropagation();
            e.preventDefault();
            const startX = e.pageX;
            const startWidth = th.offsetWidth;
            function resize(e2) {
                const newWidth = Math.max(40, startWidth + (e2.pageX - startX));
                th.style.width = newWidth + "px";
                const colObj = columnChooser.find(c => c.key === col.key);
                if (colObj)
                    colObj.width = newWidth;
            }
            function stop() {
                document.removeEventListener("mousemove", resize);
                document.removeEventListener("mouseup", stop);
                saveColumnSettings();
            }
            document.addEventListener("mousemove", resize);
            document.addEventListener("mouseup", stop);
        });
        hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    tbody = document.createElement("tbody");
    table.appendChild(tbody);
    initScrollHandler();
}
function initScrollHandler() {
    container.addEventListener("scroll", () => {
        if (scrollPending)
            return;
        scrollPending = true;
        requestAnimationFrame(() => {
            requestRender();
            scrollPending = false;
        });
    });
}
function updateViewport() {
    const viewportHeight = container.clientHeight;
    const scrollTop = container.scrollTop;
    const startRow =
        Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
    const endRow =
        Math.min(
            resultRows.length,
            startRow +
            Math.ceil(viewportHeight / ROW_HEIGHT) +
            BUFFER_ROWS);
    if (startRow === lastStartRow && endRow === lastEndRow)
        return;
    lastStartRow = startRow;
    lastEndRow = endRow;
    renderVisibleRows(startRow, endRow);
}

// hole die Tags einer Mail

async function getTagDetails(message) {
    if (!message.tags || message.tags.length === 0) {
        // console.log("Kein Tag gefunden");
        return null;
    }

    // Standard-Tag-Key finden ($label1 ... $label5)
    const standardTagKey = message.tags.find(tag =>
        /^\$label[1-5]$/.test(tag)
    );

    if (!standardTagKey) {
        // console.log("Kein Standard-Tag gefunden");
        return null;
    }

    const allTags = await browser.messages.tags.list();
    const tag = allTags.find(t => t.key === standardTagKey);

    if (!tag) {
        return null;
    } 

    return {
        label: tag.tag,
        color: tag.color
    };
}
async function renderVisibleRows(startRow, endRow) {
    const tabId = await getMailTabId();
    

    tbody.innerHTML = "";
    const spacerTop = document.createElement("tr");
    spacerTop.style.height = (startRow * ROW_HEIGHT) + "px";
    tbody.appendChild(spacerTop);
    for (let i = startRow; i < endRow; i++) {
        const r = resultRows[i];
        const tr = document.createElement("tr");
        let tagDetails = await getTagDetails(r);
        if (tagDetails) tr.style.color = tagDetails.color;
    
        if (!r.isMailHeader)
            tr.classList.add("docRow");
        if (r.unread)
            tr.style.fontWeight = "bold";
		if (!r.isMailHeader && r.match) {
			tr.classList.add("match-hit");
		}
		if (!r.isMailHeader && r.tokenized === false) {
			tr.classList.add("not-indexed");
		}
        if (r.isMailHeader) {
            // Mail-Header Aktionen
            tr.title =
                "Klick: Nachricht auswählen\n" +
                "Strg-Klick: In neuem Tab öffnen\n" +
                "Doppelklick: In neuem Fenster öffnen";
            tr.addEventListener("click", e => {
                const mode = e.ctrlKey ? "tab" : "select";
                safePost({
                    type: "open-message",
                    messageId: r.messageId,
                    folderId: r.folderId,
                    mode,
                    tabId
                });
            });
            tr.addEventListener("dblclick", () => {
                safePost({
                    type: "open-message",
                    messageId: r.messageId,
                    folderId: r.folderId,
                    mode: "window",
                    tabId
                });
            });
         } else {
           // kein Mail-Header
                   tr.title = `${r.attachmentExt}\nKlick oder Doppelklick: Anhang öffnen`;            // Nachricht / Attachment Aktionen
            tr.addEventListener("dblclick", e => {
                e.preventDefault();
                safePost({
                    type: "open-attachment",
                    messageId: r.messageId,
                    folderId: r.folderId,
                    attachmentName: r.attachmentName,
                    tabId
                });
            });
            tr.addEventListener("click", e => {
                e.preventDefault();
                safePost({
                    type: "open-attachment",
                    messageId: r.messageId,
                    folderId: r.folderId,
                    attachmentName: r.attachmentName,
                    tabId
                });
            });
         }
        columnChooser.forEach(col => {
            if (!col.visible)
                return;
            const td = document.createElement("td");
            const valueFn = COLUMN_DEFS[col.key]?.value;
            td.textContent = valueFn ? valueFn(r) : "";
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    }
    const spacerBottom = document.createElement("tr");
    spacerBottom.style.height =
        ((resultRows.length - endRow) * ROW_HEIGHT) + "px";
    tbody.appendChild(spacerBottom);
}
function applyCurrentSort() {
    const sortFn = COLUMN_DEFS[currentSortColumn]?.sort;
    if (!sortFn)
        return;
    const groups = [];
    for (let i = 0; i < resultRows.length; i++) {
        const row = resultRows[i];
        if (!row?.isMailHeader)
            continue;
        const group = [row];
        let j = i + 1;
        while (j < resultRows.length && !resultRows[j].isMailHeader) {
            group.push(resultRows[j]);
            j++;
        }
        groups.push(group);
        i = j - 1;
    }
    groups.sort((ga, gb) => {
        const av = sortFn(ga[0]);
        const bv = sortFn(gb[0]);
        if (typeof av === "number" && typeof bv === "number")
            return (av - bv) * currentSortDir;
        return String(av ?? "").localeCompare(String(bv ?? "")) * currentSortDir;
    });
    resultRows = groups.flat();
    mailIndex = new Map();
    for (let i = 0; i < resultRows.length; i++) {
        if (resultRows[i].isMailHeader)
            mailIndex.set(resultRows[i].messageId, i);
    }
    lastStartRow = -1;
    lastEndRow = -1;
}
function handleSort(col) {
    if (currentSortColumn === col.key)
        currentSortDir *= -1;
    else {
        currentSortColumn = col.key;
        currentSortDir = 1;
    }
    applyCurrentSort();
    saveColumnSettings();
    renderTableStructure();
    requestRender();
}
function formatDate(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, "0");
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ` +
`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function initColumnContextMenu() {
    const table = document.getElementById("results");
    if (!table)
        return;
    table.addEventListener("contextmenu", (e) => {
        if (e.target.tagName !== "TH")
            return; // Nur Header
        e.preventDefault();
        // Entferne altes Menü
        const oldMenu = document.getElementById("columnMenu");
        if (oldMenu)
            oldMenu.remove();
        const menu = document.createElement("div");
        menu.id = "columnMenu";
        menu.style.position = "fixed";
        menu.style.left = e.pageX + "px";
        menu.style.top = e.pageY + "px";
        menu.style.background = "#fff";
        menu.style.border = "1px solid #ccc";
        menu.style.padding = "4px";
        menu.style.zIndex = 1000;
        menu.style.boxShadow = "2px 2px 6px rgba(0,0,0,0.2)";
        columnChooser.forEach(col => {
            const item = document.createElement("div");
            item.style.cursor = "pointer";
            item.style.userSelect = "none";
            item.style.padding = "2px 6px";
            item.textContent = (col.visible ? "✔ " : "   ") + col.label;
            item.addEventListener("click", () => {
                const visibleCount = columnChooser.filter(c => c.visible).length;
                if (PROTECT_AT_LEAST_ONE_COLUMN && col.visible && visibleCount <= 1) {
                    alert("Mindestens eine Spalte muss sichtbar bleiben.");
                    menu.remove();
                    return;
                }
                col.visible = !col.visible;
                if (col.visible) {
                    if (!visibleColumns.includes(col.key))
                        visibleColumns.push(col.key);
                } else {
                    visibleColumns = visibleColumns.filter(c => c !== col.key);
                }
                saveColumnSettings();
				renderTableStructure();
				requestRender();
                menu.remove();
            });
            menu.appendChild(item);
        });
        document.body.appendChild(menu);
        // Klick außerhalb schließt das Menü
        const closeMenu = () => {
            menu.remove();
            document.removeEventListener("click", closeMenu);
        };
        setTimeout(() => document.addEventListener("click", closeMenu), 0);
    });
}
// popup geöffnet → aktuelle AccountId an background senden
async function initSearchWindow() {
    // Warte auf aktives Tab
    let attempts = 0;
    let folder = null;
    while (attempts < 10 && !folder) { // max 10 Versuche
        const tabs = await browser.mailTabs.query({
            active: true
        });
        const tab = tabs[0];
        folder = tab?.displayedFolder;
        if (!folder) {
            attempts++;
            await new Promise(r => setTimeout(r, 200)); // 200ms warten
        }
    }
    if (!folder) {
        console.warn("Kein aktiver Folder gefunden, AccountId kann nicht gesetzt werden.");
        return;
    }
    const accountId = folder.accountId;
    //    console.log("startSearch: accountId:", accountId);
    // Verbindung zum Background
    if (!searchPort) {
        searchPort = browser.runtime.connect({
            name: "search-window"
        });
        searchPort.onMessage.addListener(handleMessage);
    }
    safePost({
        type: "set-active-account",
        accountId
    });
}
document.querySelectorAll("input[type=checkbox]").forEach(cb => cb.addEventListener("change", () => {
        browser.storage.local.set({
            wholeWords: document.getElementById("whole-words").checked
        });
    }));
// Verbindung zum Background herstellen
window.addEventListener("DOMContentLoaded", async() => {
    searchPort = browser.runtime.connect({
        name: "search-window"
    });
    searchPort.onMessage.addListener(handleMessage);
    await loadSettings();
    document.getElementById("query")?.focus();
    document.getElementById("run").addEventListener("click", startSearch);
    document.getElementById("query").addEventListener("keydown", (ev) => {
        if (ev.key === "Enter")
            startSearch();
    });
    document.getElementById("rebuildIndex").addEventListener("click", () => {
        if (!confirm("Der komplette Suchindex wird neu aufgebaut.\nDies kann einige Minuten dauern."))
            return;
        // Alte Ergebnisse löschen
        renderedResults.clear();
        resultRows = [];
        const container = document.getElementById("results");
        if (container)
            container.innerHTML = "";
        document.getElementById("indexStatus").textContent = "⚙️ Indexierung läuft…";
        const accountId = accountSelect.value; // -ID aus Dropdown/Selection
        safePost({
            type: "rebuild-index",
            accountId
        });
    });
    safePost({
        type: "get-accounts"
    });
    safePost({
        type: "window-ready"
    });
    await loadColumnSettings();
    await restoreWindowSize();
    initSearchWindow();
});
window.addEventListener("resize", debounce(() => {
        browser.storage.local.set({
            windowSize: {
                width: window.outerWidth,
                height: window.outerHeight
            }
        });
    }, 500));
function debounce(fn, delay) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), delay);
    };
}
async function restoreWindowSize() {
    const res = await browser.storage.local.get("windowSize");
    if (!res.windowSize)
        return;
    window.resizeTo(
        res.windowSize.width,
        res.windowSize.height);
}

// Fenster bei Inaktivität schließen
let inactivityTimer;
let countdownInterval;
const INACTIVITY_LIMIT = 1 * 60 * 1000; // 1 Minute

let remainingTime = INACTIVITY_LIMIT;

let timerEl;

function formatTime(ms) {
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
}

function updateDisplay() {
    const timerEl = document.getElementById("inactivityTimer");
    
    if (!timerEl) {
        console.error("Element mit der ID 'inactivityTimer' nicht gefunden.");
        return;
    }
    timerEl.textContent = `Fenster schließt in ${formatTime(remainingTime)}`;
    if (remainingTime < 10000) {
        timerEl.style.color = "#dc2626"; // rot
    } else {
        timerEl.style.color = "";
    }
}

function startCountdown() {
    clearInterval(countdownInterval);

    countdownInterval = setInterval(() => {
        remainingTime -= 1000;

        if (remainingTime <= 0) {
            clearInterval(countdownInterval);
            updateDisplay();
            return;
        }

        updateDisplay();
    }, 1000);
}

function resetInactivityTimer() {
    // Timer fürs Schließen
    clearTimeout(inactivityTimer);

    inactivityTimer = setTimeout(() => {
        console.log("Timeout ausgelöst");
        safePost({ type: "close-window" });
    }, INACTIVITY_LIMIT);

    // Countdown zurücksetzen
    remainingTime = INACTIVITY_LIMIT;
    safePost({ type: "ping" });

    updateDisplay();
    startCountdown();
}

// Events
const activityEvents = [
    "click",
    "dblclick",
    "contextmenu",
    "keydown",
    "input"
];

activityEvents.forEach(event => {
    window.addEventListener(event, resetInactivityTimer);
});

// Initial
resetInactivityTimer();