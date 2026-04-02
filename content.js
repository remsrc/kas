async function init() {
    // console.log("KIM Content Script geladen, fordere Metadaten an...");
    try {
        const response = await browser.runtime.sendMessage({ type: "get-current-message-info" });
        if (response && response.data) {
            showInfoBar(response.data);
        // } else {
        //     const info = "KIM Content: Keine Infos vorhanden" 
        //     console.log(info);
        //     showInfoBar(info);
 
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

    bar.innerHTML = data;
}

init();