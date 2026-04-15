// for full logging, set true
const DEBUG = false;
// deletes the database
const DEBUG_RESET_INDEX = false;
// for testing without KIM-Account, set true
const ADDONTEST = false;
//
//========================================== INCLUDES ==========================================
//
import "./libs/jszip.min.js";
import * as pdfjsLib from "./libs/pdf.mjs";
// PDF.js Worker explizit über Add-on-URL referenzieren.
// Das ist stabiler als nur ein side-effect import.
pdfjsLib.GlobalWorkerOptions.workerSrc = browser.runtime.getURL("libs/pdf.worker.mjs");
//
//========================================== CORE ==========================================
//
//
// ----------------------------------------- DB -----------------------------------------
//
let db = null;
let dbInitPromise = null;
async function initDB() {
    if (db)
        return db;
    if (dbInitPromise)
        return dbInitPromise;
    dbInitPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open("kimAttachmentIndex", 8);
        req.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains("attachments")) {
                const store = db.createObjectStore("attachments", {
                    keyPath: "id"
                });
                store.createIndex("tokens", "tokens", {
                    multiEntry: true
                });
                store.createIndex("messageKey", "messageKey");
//                store.createIndex("hash", "hash");
                store.createIndex("tokenized", "tokenized", {
                    unique: false
                });
                store.createIndex("type", "type", {
                    unique: false
                });
            }
            if (!db.objectStoreNames.contains("messages")) {
                db.createObjectStore("messages", {
                    keyPath: "messageKey"
                });
            }
            if (!db.objectStoreNames.contains("settings")) {
                db.createObjectStore("settings", {
                    keyPath: "key"
                });
            }
            if (!db.objectStoreNames.contains("tokenStats")) {
                db.createObjectStore("tokenStats", {
                    keyPath: "token"
                });
            }
        };
        req.onsuccess = () => {
            db = req.result;
            resolve(db);
        };
        req.onerror = () => reject(req.error);
    });
    return dbInitPromise;
}
async function tx(store, mode = "readonly") {
    const db = await initDB();
    return db.transaction(store, mode).objectStore(store);
}
async function put(storeName, value) {
    const store = await tx(storeName, "readwrite");
    return promisify(store.put(value));
}
async function messageAlreadyIndexed(messageKey) {
    const store = await tx("messages");
    const res = await promisify(store.get(messageKey));
    return !!res;
}
async function getIndexedAttachments(messageKey) {
    const store = await tx("attachments");
    // Dexie / Wrapper: getAll liefert Array
    let all = await store.index("messageKey").getAll(messageKey);
    // Sicherstellen, dass es ein Array ist
    if (!Array.isArray(all)) {
        all = [];
    }
    return all;
}
//
// Metadaten speichern
//
async function saveMessageMeta(messageKey, meta) {
    if (!meta || !messageKey)
        return;
    const hasMeta =
        meta.patient ||
        meta.birth ||
        meta.doctor ||
        meta.practice ||
        meta.docDate;
    if (!hasMeta)
        return;
    await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction("messages", "readwrite");
        const store = tx.objectStore("messages");
        const getReq = store.get(messageKey);
        getReq.onsuccess = () => {
            const existing = getReq.result || { messageKey };
            const entry = {
                ...existing,
                messageKey,
                patient: meta.patient || existing.patient || "",
                birth: meta.birth || existing.birth || "",
                gender: meta.gender || existing.gender || "",
                doctor: meta.doctor || existing.doctor || "",
                practice: meta.practice || existing.practice || "",
                docDate: meta.docDate || existing.docDate || ""
            };
            store.put(entry);
            metaCache.set(messageKey, entry);
        };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}
async function getMessageMeta(messageKey) {
    await initDB();
    return new Promise(resolve => {
        const tx = db.transaction("messages", "readonly");
        const store = tx.objectStore("messages");
        const req = store.get(messageKey);
        req.onsuccess = () => resolve(req.result || {});
        req.onerror = () => resolve({});
    });
}
//
// ----------------------------------------- QUERY -----------------------------------------
//
//
// ================= GOOGLE QUERY PARSER =================
//
function parseQuery(query) {
    const tokens = [];
    const phrases = [];
    const not = [];
    const or = [];
    const isAll = query === "*";
    const phraseRegex = /"([^"]+)"/g;
    if (query) {
        let match;
        while ((match = phraseRegex.exec(query)) !== null) {
            phrases.push(match[1].toLowerCase());
        }
        query = query.replace(phraseRegex, "");
        const parts = query.split(/\s+/).filter(Boolean);
        for (let p of parts) {
            if (p.startsWith("-"))
                not.push(p.substring(1).toLowerCase());
            else if (p.toUpperCase() === "OR")
                continue;
            else if (p.includes("|"))
                or.push(...p.split("|").map(v => v.toLowerCase()));
            else
                tokens.push(p.toLowerCase());
        }
    }
    return {
        tokens,
        phrases,
        not,
        or,
        isAll
    };
}
function matchQuery(text, parsed, wholeWords = true) {
    if (!parsed)
        return false;
    if (parsed.isAll)
        return true;
    text = (text || "").toLowerCase();
    const tokens = parsed.tokens || [];
    const phrases = parsed.phrases || [];
    const not = parsed.not || [];
    const or = parsed.or || [];
    const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const testTerm = (term) => {
        if (!term)
            return false;
        if (!wholeWords) {
            return text.includes(term);
        }
        const hasWildcard = term.includes("*") || term.includes("?");
        let pattern;
        if (hasWildcard) {
            pattern = escapeRegExp(term)
                .replace(/\\\*/g, "[^\\s]*")
                .replace(/\\\?/g, "[^\\s]");
        } else {
            pattern = escapeRegExp(term);
        }
        return new RegExp(`\\b${pattern}\\b`, "u").test(text);
    };
    // Phrasen prüfen
    for (const p of phrases) {
        if (!text.includes(p))
            return false;
    }
    // NOT prüfen
    for (const n of not) {
        if (wholeWords) {
            if (testTerm(n))
                return false;
        } else {
            if (text.includes(n))
                return false;
        }
    }
    // Normale Tokens prüfen
    for (const t of tokens) {
        if (!testTerm(t))
            return false;
    }
    // OR-Bedingungen prüfen
    if (or.length > 0) {
        const found = or.some(testTerm);
        if (!found)
            return false;
    }
    return true;
}
function tokenize(text) {
    return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]/gi, " ")
    .split(/\s+/)
    .filter(Boolean);
}
//
//========================================== INDEXER ==========================================
//
const QUEUE = [];
const ACTIVE = new Set();
let running = false;
const MAX = 2;
let queueIdleResolver = null;
function waitForQueueIdle() {
    if (!running && QUEUE.length === 0 && ACTIVE.size === 0) {
        return Promise.resolve();
    }
    return new Promise(resolve => {
        queueIdleResolver = resolve;
    });
}
function checkQueueIdle() {
    if (QUEUE.length === 0 && ACTIVE.size === 0 && queueIdleResolver) {
        queueIdleResolver();
        queueIdleResolver = null;
    }
}
function enqueue(job) {
    const key = job.messageId + "|" + job.partName;
    if (ACTIVE.has(key))
        return;
    ACTIVE.add(key);
    QUEUE.push(job);
    run();
}
async function run() {
    if (running)
        return;
    running = true;
    const workers = Array.from({
        length: MAX
    }, () => worker());
    await Promise.all(workers);
    running = false;
}
async function worker() {
    while (QUEUE.length) {
        const job = QUEUE.shift();
        if (!job)
            continue;
        try {
            await job.handler(job);
        } catch (e) {
            console.error("DocWorker Error", e);
        }
        ACTIVE.delete(job.messageId + "|" + job.partName);
        checkQueueIdle();
    }
}
async function indexMessage(msg, runQuery = null, wholeWords = true) {
    if (!msg || !msg.id || !msg.folder?.id) {
        return false;
    }
    const full = await browser.messages.getFull(msg.id);
    const parts = [];
    collectAllParts(full, parts);
    const messageKey = makeMessageKey(msg.folder.id, msg.id);
    const existing = await getIndexedAttachments(messageKey);
    const existingIds = new Set(existing.map(a => a.id));
    for (const part of parts) {
        const name = (part.name || part.filename || "").toLowerCase();
        if (!name) {
            continue;
        }
        const id = messageKey + "|" + part.partName;
        if (existingIds.has(id)) {
            continue;
        }
        const isXMLFile = name.endsWith(".xml");
        const isPDFFile = name.endsWith(".pdf");
        const isDOCXFile = name.endsWith(".docx");
        if (isXMLFile) {
            const file = await browser.messages.getAttachmentFile(msg.id, part.partName);
            const buffer = await file.arrayBuffer();
            if (!buffer || buffer.byteLength === 0) {
                continue;
            }
            const xml = extractXML(buffer);
            if (!xml || xml.trim().length < 20) {
                continue;
            }
            let meta = {};
            try {
                meta = parseEArztbriefXML(xml);
            } catch (e) {
                console.warn("eArztbrief Parsing fehlgeschlagen", e);
            }
            const metaText = [
                meta.patient,
                meta.birth,
                meta.gender,
                meta.doctor,
                meta.practice,
                meta.docDate
            ].filter(Boolean).map(normalizeText).join(" ");
            const text = metaText + " " + normalizeText(stripXMLTags(xml));
            const cleanText = text.toLowerCase();
            await put("attachments", {
                id,
                messageKey,
                partName: part.partName,
                attachmentName: name,
                text: cleanText,
                type: "xml",
                tokens: tokenize(text),
                tokenized: true
            });
            await saveMessageMeta(messageKey, meta);
            await streamSearchMatch({
                messageKey,
                date: msg.date ? new Date(msg.date).toISOString() : null,
                subject: msg.subject,
                attachmentName: name,
                text: cleanText
            });
            continue;
        }
        if (isPDFFile || isDOCXFile) {
            enqueue({
                messageId: msg.id,
                partName: part.partName,
                name,
                handler: async(job) => {
                    const file = await browser.messages.getAttachmentFile(job.messageId, job.partName);
                    const buffer = await file.arrayBuffer();
                    if (!buffer || buffer.byteLength === 0) {
                        return;
                    }
                    const text = await processAttachment(buffer, job.name);
                    const cleanText = (text || "").toLowerCase();
                    await put("attachments", {
                        id,
                        messageKey,
                        partName: job.partName,
                        attachmentName: job.name,
                        text: cleanText,
                        type: isPDFFile ? "pdf" : "docx",
                        tokens: tokenize(text),
                        tokenized: true
                    });
                    if (runQuery && matchQuery(cleanText, runQuery, wholeWords)) {
                        sendToSearchWindow({
                            type: "search-stream-result",
                            result: buildResult(msg, job.name, true)
                        });
                    }
                }
            });
        }
    }
    const existingMsg = await getMetaCached(messageKey);
    await put("messages", {
        ...existingMsg,
        messageKey,
        subject: msg.subject || "",
        unread: msg.read === false,
        timestamp: msg.date || null
    });
    return true;
}
async function rebuildIndex(folder, query = null, wholeWords = true) {
    const db = await initDB();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(["attachments", "messages"], "readwrite");
        tx.objectStore("attachments").clear();
        tx.objectStore("messages").clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    metaCache.clear();
    QUEUE.length = 0;
    ACTIVE.clear();
    running = false;
    if (DEBUG) {
        console.log("📬 Lade Nachrichten...");
    }
    const messages = [];
    let page = await browser.messages.list(folder.id);
    if (DEBUG) {
        console.log("ERSTE PAGE:", page);
    }
    while (page) {
        if (DEBUG) {
            console.log("PAGE:", page.messages?.length);
        }
        messages.push(...(page.messages || []));
        if (!page.id) {
            break;
        }
        page = await browser.messages.continueList(page.id);
    }
    if (DEBUG) {
        console.log("📊 TOTAL MESSAGES:", messages.length);
    }
    const total = messages.length;
    let current = 0;
    for (const msg of messages) {
        current++;
        sendToSearchWindow({
            type: "index-progress",
            current,
            total
        });
        try {
            await indexMessage(msg, null, wholeWords);
        } catch (e) {
            console.error("Rebuild Index Fehler:", e);
        }
    }
    await waitForQueueIdle();
    sendToSearchWindow({
        type: "index-progress",
        current: total,
        total
    });
    if (DEBUG) {
        console.log("Index Rebuild abgeschlossen");
    }
}
//
// ----------------------------------------- ATTACHMENTPROCESSOR  -----------------------------------------
//
async function processAttachment(buffer, name) {
    name = name.toLowerCase();
    if (name.endsWith(".pdf")) {
        return await extractPDF(buffer);
    }
    if (name.endsWith(".docx")) {
        return await extractDOCX(buffer);
    }
    return "";
}
//
// DOCQUEUE
//
//
//========================================== SEARCH ==========================================
//
//
// ----------------------------------------- SEARCHINDEX -----------------------------------------
//
// ================= BEST TOKEN =================
async function getBestToken(tokens) {
    await initDB();
    if (!tokens || tokens.length === 0)
        return null;
    const tx = db.transaction("tokenStats", "readonly");
    const store = tx.objectStore("tokenStats");
    let best = tokens[0]; // Default
    let bestCount = Infinity;
    for (const t of tokens) {
        // tokenStat abrufen
        const val = await new Promise(resolve => {
            const req = store.get(t);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
        let count = val?.count ?? 0; // wenn Statistik noch nicht existiert, count=0
        // Wir bevorzugen Tokens, die am seltensten vorkommen (also kleinen count)
        if (count < bestCount) {
            best = t;
            bestCount = count;
        }
    }
    return best;
}
const metaCache = new Map();
async function getMetaCached(key) {
    if (!metaCache.has(key)) {
        metaCache.set(key, await getMessageMeta(key));
    }
    return metaCache.get(key);
}
async function searchIndex(parsed, wholeWords = true) {
    await initDB();
    const tokens = parsed.tokens || [];
    const literalTokens = tokens.filter(t => !t.includes("*") && !t.includes("?"));
    const bestToken = literalTokens.length > 0 ? await getBestToken(literalTokens) : null;
    const tx = db.transaction("attachments", "readonly");
    const store = tx.objectStore("attachments");
    let attachments = [];
    if (parsed.isAll) {
        attachments = await promisify(store.getAll());
    } else if (bestToken) {
        const index = store.index("tokens");
        attachments = await promisify(index.getAll(bestToken));
        if (!attachments || !attachments.length) {
            attachments = await promisify(store.getAll());
        }
    } else {
        attachments = await promisify(store.getAll());
    }
    if (!Array.isArray(attachments))
        attachments = [];
    const grouped = new Map();
    for (const a of attachments) {
        if (!matchQuery(a.text || "", parsed, wholeWords))
            continue;
        if (!grouped.has(a.messageKey)) {
            const meta = await getMetaCached(a.messageKey) || {};
            const { folderId, messageId } = splitMessageKey(a.messageKey);
            grouped.set(a.messageKey, {
                messageKey: a.messageKey,
                messageId,
                folderId,
                subject: meta.subject || "",
                timestamp: meta.timestamp || 0,
                unread: meta.unread || false,
                patient: meta.patient || "",
                birth: meta.birth || "",
                gender: meta.gender || "",
                doctor: meta.doctor || "",
                practice: meta.practice || "",
                docDate: meta.docDate || "",
                attachments: [],
                matched: new Set()
            });
        }
        grouped.get(a.messageKey).matched.add(a.id);
    }
    return {
        grouped,
        attachmentMap: attachments.reduce((m, a) => m.set(a.id, a), new Map())
    };
}
function promisify(req) {
    return new Promise((res, rej) => {
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
    });
}
let activeQuery = null;
let activeWholeWords = true;
async function runSearch(query, tabId, folder, wholeWords = false) {
    const normalizedQuery = (query || "").trim();
    const effectiveQuery = normalizedQuery === "" ? "*" : normalizedQuery;
    const parsed = parseQuery(effectiveQuery);
    activeQuery = parsed;
    activeWholeWords = wholeWords;
    sendToSearchWindow({
        type: "search-results",
        results: [],
        indexing: false
    });
    const { grouped, attachmentMap } = await searchIndex(parsed, wholeWords);
    if (DEBUG) {
        console.log("🔍 Treffer gesamt:", grouped.size);
    }
    const results = [];
    for (const [messageKey, group] of grouped.entries()) {
        const { folderId, messageId } = splitMessageKey(messageKey);
        if (!folderId || !messageId) {
<<<<<<< HEAD
            continue;
        }
        const messageId = Number(messageIdStr);
        if (!messageId) {
=======
>>>>>>> b465c10cb82c0be2dd6a6fc8f52ea17cc9c7f663
            continue;
        }
        let msg = null;
        try {
            msg = await browser.messages.get(messageId);
        } catch (err) {
            console.warn("⚠️ Message konnte nicht geladen werden", messageId, err);
            continue;
        }
        const meta = await getMetaCached(messageKey) || {};
        let parts = [];
        try {
            const full = await browser.messages.getFull(messageId);
            collectAllParts(full, parts);
        } catch (err) {
            console.warn("⚠️ getFull fehlgeschlagen für Message", messageId, err);
        }
        const attachments = parts
            .filter(p => {
                const name = p.name || p.filename;
                return name && (
                    name.toLowerCase().endsWith(".xml") ||
                    name.toLowerCase().endsWith(".pdf") ||
                    name.toLowerCase().endsWith(".docx"));
            })
            .map(p => {
                const name = (p.name || p.filename).toLowerCase();
                const id = messageKey + "|" + p.partName;
                const indexed = attachmentMap.get(id);
                return {
                    attachmentName: name,
                    match: group.matched.has(id),
                    tokenized: indexed ? indexed.tokenized === true : false,
                    type: indexed?.type || ""
                };
            });
        results.push({
            messageKey,
            messageId: msg.id,
            folderId,
            timestamp: msg.date,
            subject: msg.subject,
            unread: msg.read === false,
            tags: msg.tags || [],
            patient: meta.patient || "",
            birth: meta.birth || "",
            gender: meta.gender || "",
            doctor: meta.doctor || "",
            practice: meta.practice || "",
            docDate: meta.docDate || "",
            attachments
        });
    }
    sendToSearchWindow({
        type: "search-results",
        results
    });
}
//
//========================================== UTILS ==========================================
//
function makeMessageKey(folderId, messageId) {
    return folderId + "|" + messageId;
}
function splitMessageKey(messageKey) {
    const sep = String(messageKey).lastIndexOf("|");
    if (sep < 0) {
        return { folderId: null, messageId: null };
    }
    const folderId = messageKey.slice(0, sep);
    const messageIdRaw = messageKey.slice(sep + 1);
    const messageId = Number(messageIdRaw);
    return {
        folderId,
        messageId: Number.isFinite(messageId) ? messageId : null
    };
}
//
// ----------------------------------------- EXTRACTORS -----------------------------------------
//
function normalizeText(str) {
    return (str || "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function extractXML(buffer) {
    return new TextDecoder("utf-8").decode(buffer);
}
function stripXMLTags(str) {
    return str.replace(/<[^>]+>/g, " ");
}
async function extractDOCX(arrayBuffer) {
    try {
        const zip = await JSZip.loadAsync(arrayBuffer);
        let fullText = "";
        for (const name of Object.keys(zip.files)) {
            if (!name.endsWith(".xml"))
                continue;
            const xml = await zip.file(name).async("string");
            const matches = [...xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)];
            if (matches.length)
                fullText += " " + matches.map(m => m[1]).join(" ");
        }
        return fullText.replace(/\s+/g, " ").trim();
    } catch (e) {
        console.error("DOCX Fehler:", e);
        return "";
    }
}
async function extractPDF(arrayBuffer) {
    async function readPdf(disableWorker) {
        const loadingTask = pdfjsLib.getDocument({
            data: arrayBuffer,
            disableWorker,
            useWorkerFetch: !disableWorker,
            isEvalSupported: false
        });
        const pdf = await loadingTask.promise;
        let text = "";
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            const pageText = content.items.map(item => item.str).join(" ");
            text += pageText + "\n";
        }
        return text.replace(/\s+/g, " ").trim();
    }
    try {
        // Primär mit Worker
        return await readPdf(false);
    } catch (workerError) {
        if (DEBUG) {
            console.warn("PDF Worker fehlgeschlagen, Fallback ohne Worker:", workerError);
        }
        try {
            // Fallback ohne Worker
            return await readPdf(true);
        } catch (fallbackError) {
            console.error("PDF Fehler:", fallbackError);
            return "";
        }
    }
}
function collectAllParts(node, parts) {
    if (node.parts)
        node.parts.forEach(p => collectAllParts(p, parts));
    parts.push(node);
}
//
// ================= Meldung an Frontend =================
//
async function streamSearchMatch(e) {
    if (!searchPort || !activeQuery) {
        return;
    }
    if (!matchQuery(e.text, activeQuery, activeWholeWords)) {
        return;
    }
    const messageKey = e.messageKey;
    const meta = await getMessageMeta(messageKey);
    const { folderId, messageId } = splitMessageKey(messageKey);
    if (!folderId || !messageId) {
        return;
    }
    sendToSearchWindow({
        type: "search-stream-result",
        result: {
            timestamp: e.date ? new Date(e.date).toISOString() : null,
            messageKey,
            messageId,
            folderId,
            subject: e.subject,
            attachmentName: e.attachmentName,
            patient: meta.patient || "",
            birth: meta.birth || "",
            gender: meta.gender || "",
            doctor: meta.doctor || "",
            practice: meta.practice || "",
            docDate: meta.docDate || ""
        }
    });
}
//
// ------------------------------ PARSER ---------------------------------
//
//
// eArztbrief XML Parser
//
function sanitizeXML(xml) {
    if (!xml)
        return "";
    // BOM entfernen
    xml = xml.replace(/^\uFEFF/, "");
    // alles vor dem ersten "<" entfernen
    const firstTag = xml.indexOf("<");
    if (firstTag > 0) {
        xml = xml.slice(firstTag);
    }
    return xml.trim();
}
function parseEArztbriefXML(xmlString) {
    xmlString = sanitizeXML(xmlString);
    const ns = "urn:hl7-org:v3";
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlString, "application/xml");
    if (xml.querySelector("parsererror"))
        return {};
    const text = (node) => node?.textContent?.trim() || "";
    const attr = (node, a) => node?.getAttribute?.(a) || "";
    const patientNode =
        xml.getElementsByTagNameNS(ns, "patient")[0];
    const family =
        patientNode?.getElementsByTagNameNS(ns, "family")[0];
    const given =
        patientNode?.getElementsByTagNameNS(ns, "given")[0];
    const birth =
        xml.getElementsByTagNameNS(ns, "birthTime")[0];
    const gender =
        xml.getElementsByTagNameNS(ns, "administrativeGenderCode")[0];
    const docTime =
        xml.getElementsByTagNameNS(ns, "effectiveTime")[0];
    const author =
        xml.getElementsByTagNameNS(ns, "assignedPerson")[0];
    const org =
        xml.getElementsByTagNameNS(ns, "representedOrganization")[0];
    return {
        patient: [text(family), text(given)].filter(Boolean).join(", "),
        birth: attr(birth, "value"),
        gender: attr(gender, "code"),
        doctor: [
            text(author?.getElementsByTagNameNS(ns, "family")[0]),
            text(author?.getElementsByTagNameNS(ns, "given")[0])
        ].filter(Boolean).join(", "),
        practice: text(org?.getElementsByTagNameNS(ns, "name")[0]),
        docDate: attr(docTime, "value")
    };
}
//
// alle (KIM-)Postfächer suchen
//
async function getAccounts(findAll = false) {
    const accounts = await browser.accounts.list();
    const kimAccounts = [];
    const otherAccounts = [];
    for (const acc of accounts) {
        const isKim = acc.identities?.some(i =>
                (i.email || "").toLowerCase().endsWith(".kim.telematik")) === true;
        if (isKim) {
            kimAccounts.push(acc);
        } else if (findAll) {
            otherAccounts.push(acc);
        }
    }
    return findAll ? [...kimAccounts, ...otherAccounts] : kimAccounts;
}
async function getInboxFolderFromAccountId(accountId) {
    if (!accountId)
        return null;
    let account;
    try {
        account = await browser.accounts.get(accountId);
    } catch (e) {
        console.error("Account konnte nicht geladen werden:", e);
        return null;
    }
    const MAX_RETRIES = 10;
    const RETRY_DELAY = 50; // ms
    let folders = null;
    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            folders = await browser.folders.getSubFolders(account.id);
        } catch (e) {
            folders = null;
        }
        if (folders && folders.length > 0)
            break;
        // kurzer Wait → ersetzt den Effekt des console.log
        await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
    if (!folders || folders.length === 0) {
        console.warn("Keine Folder gefunden für Account:", accountId);
        return null;
    }
    function findInboxByPath(folders) {
        for (const f of folders) {
            if ((f.path || "").toLowerCase().endsWith("inbox")) {
                return f;
            }
            if (f.subFolders?.length) {
                const sub = findInboxByPath(f.subFolders);
                if (sub)
                    return sub;
            }
        }
        return null;
    }
    return findInboxByPath(folders);
}
//
// ----------------------------- OPEN ATTACHMENT --------------------------------
//
async function openAttachment(messageId, folderId, attachmentName, tabId) {
    //console.log("Open attachment");
    try {
        const full = await browser.messages.getFull(messageId);
        const parts = [];
        collectAllParts(full, parts);
        for (const part of parts) {
            const name = part.name || part.filename || "";
            attachmentName = String(attachmentName || "");
            if (name === attachmentName ||
                name.toLowerCase() === attachmentName.toLowerCase()) {
                if (DEBUG)
                    console.log("MsgID: " + messageId + ", Name: " + name + ", tabId: " + tabId);
                await browser.messages.openAttachment(
                    messageId,
                    part.partName,
                    tabId);
                return;
            }
        }
        console.warn("Attachment nicht gefunden:", attachmentName);
    } catch (err) {
        console.error("Attachment öffnen fehlgeschlagen:", err);
    }
}
//
// ----------------------------------------- RESULTBUILDER -----------------------------------------
function buildResult(msg, attachmentName, match = false) {
    const messageKey = makeMessageKey(msg.folder.id, msg.id);
    const cached = metaCache.get(messageKey) || {};
    return {
        messageKey,
        messageId: msg.id,
        folderId: msg.folder.id,
        timestamp: msg.date,
        subject: msg.subject,
        unread: msg.read === false,
        tags: msg.tags || [],
        patient: cached.patient || "",
        birth: cached.birth || "",
        gender: cached.gender || "",
        doctor: cached.doctor || "",
        practice: cached.practice || "",
        docDate: cached.docDate || "",
        attachments: [{
                attachmentName,
                match,
                tokenized: true
            }
        ]
    };
}
//
//========================================== BACKGROUND ==========================================
//
//
// ----------------------------------------- MAIN -----------------------------------------
//
let searchWindowId = null;
//
// ----------------------------------------- MESSAGEHANDLER -----------------------------------------
//
let searchPort = null;
// Globales Tracking der angezeigten Nachrichten, um API-Fehler zu umgehen
function sendToSearchWindow(msg) {
    if (DEBUG)
        console.log("sendToSearchWindow", msg.type, "Port:", searchPort);
    if (!searchPort) {
        //        console.warn("Popup Port verloren");
        return;
    }
    try {
        searchPort.postMessage(msg);
    } catch (e) {
        //        console.warn("Popup Port Fehler", e);
        searchPort = null;
    }
}
browser.runtime.onMessage.addListener(async(msg, sender) => {
    if (msg.type === "get-message-meta-data") {
        const messageKey = makeMessageKey(msg.folderId, msg.messageId);
        const meta = await getMetaCached(messageKey);
        const attachments = await getIndexedAttachments(messageKey);
        return {
            meta,
            hasIndexedAttachments: attachments.length > 0,
            attachments: attachments.map(a => ({
                    name: a.attachmentName,
                    type: a.type
                }))
        };
    }
    if (msg.type === "get-current-message-info") {
        // Ermitteln, welche Nachricht in diesem Tab angezeigt wird
        const displayed = await messenger.messageDisplay.getDisplayedMessages(sender.tab.id);
        if (displayed.messages.length > 0) {
            const message = displayed.messages[0];
            if (DEBUG) {
                console.log("Message:", message);
            }
            if (!message || !(message.author || "").toLowerCase().includes("kim.telematik")) {
                if (!ADDONTEST) {
                    return { data: null };
                }
            }
            const meta = await getMeta(message);
            if (meta && meta.patient) {
                const anrede = meta.gender === "M" ? "Herr" : meta.gender === "F" ? "Frau" : "";
                const data = [{
                        text: "eArztbrief",
                        bold: true
                    }, {
                        text: ` vom ${formatXfaDateLocal(meta.docDate)} (über ${anrede} `
                    }, {
                        text: meta.patient,
                        bold: true
                    }, {
                        text: `, geb: ${formatXfaDateLocal(meta.birth)}): `
                    }, {
                        text: "von Arzt:",
                        bold: true
                    }, {
                        text: ` ${meta.doctor || "nicht angegeben"}, `
                    }, {
                        text: "Praxis:",
                        bold: true
                    }, {
                        text: ` ${meta.practice || "nicht angegeben"}`
                    }
                ];
                return {
                    data
                };
            } else {
                return {
                  data: null
                };
            }
        } else {
            return {
                data: null
            };
        }
    }
});
browser.runtime.onConnect.addListener(port => {
    if (port.name !== "search-window")
        return;
    searchPort = port;
    port.onMessage.addListener(async msg => {
        if (msg.type === "close-window") {
            if (DEBUG)
                console.log("Window Close Nachricht erhalten WinId", searchWindowId);
            if (!searchWindowId)
                return;
            browser.windows.remove(searchWindowId);
            searchWindowId = null;
        }
        if (msg.type === "ping") {
            // keep alive
            if (DEBUG) {
                console.log("background.js keep alive");
            }
            return;
        }
        if (msg.type === "index-doc") {
            enqueue({
                ...msg,
                handler: async(job) => {
                    const file = await browser.messages.getAttachmentFile(job.messageId, job.partName);
                    const buffer = await file.arrayBuffer();
                    const text = await processAttachment(buffer, job.name);
                    // hier speichern
                }
            });
        }
        if (msg.type === "set-active-account" && msg.accountId) {
            lastAccountId = msg.accountId;
            if (DEBUG)
                console.log("Background: lastAccountId gesetzt auf", lastAccountId);
            return;
        }
        if (msg.type === "open-attachment") {
            const tabId = msg.tabId;
            openAttachment(msg.messageId, msg.folderId, msg.attachmentName, tabId);
            return;
        }
        if (msg.type === "rebuild-index") {
            if (DEBUG)
                console.log("REBUILD MESSAGE ANGEKOMMEN", msg);
            const folder = await getInboxFolderFromAccountId(msg.accountId);
            if (DEBUG)
                console.log("Folder für Rebuild:", folder);
            if (!folder) {
                console.error("❌ KEIN FOLDER → Rebuild abgebrochen");
                return;
            }
            if (DEBUG)
                console.log("✅ Index Rebuild gestartet");
            await rebuildIndex(folder, msg.query, msg.wholeWords);
            return;
        }
        if (msg.type === "run-attachment-search") {
            if (DEBUG)
                console.log("Suche: accountId", msg.accountId);
            const folder = await getInboxFolderFromAccountId(msg.accountId);
            if (DEBUG)
                console.log("Suche: folder gefunden", folder);
            if (!folder) {
                console.warn("Folder nicht gefunden, Rebuild abgebrochen");
                return;
            }
            if (DEBUG)
                console.log("Folder: " + folder);
            runSearch(
                msg.query,
                msg.tabId,
                folder,
                msg.wholeWords);
            return;
        }
        if (msg.type === "select-message") {
            const tabId = msg.tabId;
            try {
                await browser.mailTabs.setSelectedMessages(tabId, [msg.messageId]);
            } catch (err) {
                console.error("Fehler beim Selektieren:", err);
            }
        }
        if (msg.type === "open-message") {
            const tabId = msg.tabId;
            if (DEBUG)
                console.log("open-message received:", msg);
            try {
                switch (msg.mode) {
                case "window":
                    // sonst öffnet Thunderbird, wie er es für richtig hält.
                    await browser.messageDisplay.open({
                        messageId: msg.messageId,
                        location: "window"
                    });
                    break;
                case "tab":
                    // Nachricht im Hauptfenster / Tab anzeigen
                    await browser.messageDisplay.open({
                        messageId: msg.messageId
                    });
                    break;
                case "select":
                    await browser.mailTabs.setSelectedMessages(tabId, [msg.messageId]);
                    break;
                }
            } catch (e) {
                console.error("Navigation Fehler:", e);
            }
        }
        if (msg.type === "get-accounts") {
            const accounts = await getAccounts(ADDONTEST);
            port.postMessage({
                type: "accounts-list",
                accounts: accounts
            });
        }
    });
    port.onDisconnect.addListener(() => {
        searchPort = null;
    });
});
// --- MV3 Scripting Integration ---
async function onMessageDisplayedInjektor(tab, message) {
    try {
        await messenger.scripting.insertCSS({
            target: {
                tabId: tab.id
            },
            files: ["assets/css/content.css"]
        });
    } catch (e) {
        console.error("KIM: Fehler bei inserCSS:", e);
    }
    try {
        await messenger.scripting.executeScript({
            target: {
                tabId: tab.id
            },
            files: ["content.js"]
        });
        if (DEBUG)
            console.log(`KIM: content.js erfolgreich in Tab ${tab.id} injiziert.`);
    } catch (e) {
        console.error("KIM: Fehler bei executeScript:", e);
    }
}
function registerContentInjektor() {
    messenger.messageDisplay.onMessagesDisplayed.addListener(onMessageDisplayedInjektor);
    if (DEBUG)
        console.log("KIM: Message-Injektor registriert.");
}
// function unregisterContentInjektor() {
    // messenger.messageDisplay.onMessagesDisplayed.removeListener(onMessageDisplayedInjektor);
    // if (DEBUG)
        // console.log("KIM: Message-Injektor unregistriert.");
// }
//
// Suchfenster öffnen oder aktivatieren
//
browser.action.onClicked.addListener(async() => {
    if (searchWindowId) {
        try {
            await browser.windows.update(searchWindowId, {
                focused: true
            });
            return;
        } catch {
            searchWindowId = null;
        }
    }
    const stored = await browser.storage.local.get("windowSize");
    const width = stored.windowSize?.width ?? 750;
    const height = stored.windowSize?.height ?? 600;
    const win = await browser.windows.create({
        url: browser.runtime.getURL("search.html"),
        type: "popup",
        width,
        height
    });
    searchWindowId = win.id;
});
//
// Suchfenster schließen
//
browser.windows.onRemoved.addListener((id) => {
    if (id === searchWindowId)
        searchWindowId = null;
});
//
// keep alive
//
const MAIL_CHECK_INTERVAL = 30 * 1000; // 30 Sekunden
let lastAccountId = null; // Merkt sich zuletzt genutztes Account für gezielte Indexierung
// Polling-Funktion: schaut regelmäßig nach neuen Mails
async function pollNewMails() {
    await initDB();
    try {
        const kimAccounts = await getAccounts(ADDONTEST);
        for (const kimAccount of kimAccounts) {
            const inbox = await getInboxFolderFromAccountId(kimAccount.id);
            if (!inbox) {
                continue;
            }
            let page = await browser.messages.list(inbox.id);
            while (page) {
                for (const msg of page.messages || []) {
                    if (!msg || !msg.id || !msg.folder?.id) {
                        continue;
                    }
                    if (!(await messageAlreadyIndexed(msg.id, msg.folder.id))) {
                        try {
                            await indexMessage(msg, activeQuery, activeWholeWords);
                        } catch (e) {
                            console.error("Index Fehler neue Mail:", e);
                        }
                    }
                }
                if (!page.id) {
                    break;
                }
                page = await browser.messages.continueList(page.id);
            }
        }
    } catch (e) {
        console.error("Fehler beim Polling neuer Mails:", e);
    }
}
setInterval(pollNewMails, MAIL_CHECK_INTERVAL);
if (DEBUG_RESET_INDEX) {
    if (DEBUG) {
      console.log("KIM Index Engine wird gelöscht ...");
    }
    indexedDB.deleteDatabase("kimAttachmentIndex");
}
initDB().then(() => {
    if (DEBUG) {
        console.log("KIM Index Engine bereit");
    }
    // Startet die Überwachung für die E-Mail-Anzeige
    registerContentInjektor();
});
//
// holt die Metadaten aus einer Mail
// und indexiert sie, wenn noch nicht geschehen
// darf nur aus kim.telematik-Mails aufegerufen werden!
async function getMeta(msg) {
    if (!msg || !msg.id || !msg.folder?.id) {
        return {};
    }
    const messageKey = makeMessageKey(msg.folder.id, msg.id);
    if (!(await messageAlreadyIndexed(messageKey))) {
        await indexMessage(msg);
    }
    const meta = await getMetaCached(messageKey);
    if (DEBUG) {
        console.log(meta);
    }
    return meta;
}
function formatXfaDateLocal(s) {
    if (!s || s.length < 8)
        return s || "Unbekannt";
    return `${s.slice(6, 8)}.${s.slice(4, 6)}.${s.slice(0, 4)}`;
}
