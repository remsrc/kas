const DEBUG = false;

async function wakeBackground() {
    try {
        const port = browser.runtime.connect({ name: "kim-message-content" });
        return port;
    } catch (e) {
        if (DEBUG) {
            console.warn("KIM Content: Background-Port konnte nicht geöffnet werden:", e);
        }
        return null;
    }
}

async function requestMessageInfoWithRetry(retries = 5, delayMs = 150) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await browser.runtime.sendMessage({
                type: "get-current-message-info"
            });

            if (response) {
                return response;
            }
        } catch (e) {
            if (DEBUG) {
                console.warn(`KIM Content: sendMessage Versuch ${i + 1} fehlgeschlagen:`, e);
            }
        }

        await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    return null;
}

async function init() {
    const port = await wakeBackground();

    try {
        const response = await requestMessageInfoWithRetry();

        if (response && response.data) {
            showInfoBar(response.data);
        } else if (DEBUG) {
            const info = "KIM Content: Keine Infos vorhanden";
            console.log(info);
            showInfoBar([{ text: info, bold: true }]);
        }
    } catch (e) {
        console.error("Fehler beim Abrufen der KIM-Metadaten:", e);
    }

    // Port bewusst nicht sofort trennen.
    // Beim Schließen der Message-Ansicht wird er automatisch beendet.
}

function showInfoBar(data) {

    let bar = document.getElementById("kas2-addon-bar");
    if (!bar) {
        bar = document.createElement("div");
        bar.id = "kas2-addon-bar";
        bar.classList.add("kas2-bar"); // statt inline styles
        document.body.prepend(bar);
    }

    bar.textContent = "";
    if (Array.isArray(data)) {
        for (const part of data) {
            if (part.bold) {
                const strong = document.createElement("strong");
                strong.textContent = part.text;
                bar.appendChild(strong);
            } else {
                bar.appendChild(document.createTextNode(part.text));
            }
        }
    }
}

init();