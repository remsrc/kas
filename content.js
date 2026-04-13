const DEBUG = false;

async function init() {
    // console.log("KIM Content Script geladen, fordere Metadaten an...");
    try {
        const response = await browser.runtime.sendMessage({ type: "get-current-message-info" });
        if (response && response.data) {
            showInfoBar(response.data);
        } else {
            if (DEBUG) {
               const info = "KIM Content: Keine Infos vorhanden" 
               console.log(info);
               showInfoBar([{ text:info, bold: true}]);
            }
        }
    } catch (e) {
        console.error("Fehler beim Abrufen der KIM-Metadaten:", e);
    }
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