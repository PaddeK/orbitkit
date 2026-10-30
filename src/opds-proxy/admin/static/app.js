// Copy buttons: data-copy holds the id of the input whose value to copy
document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy]");
    if (!button) return;
    const input = document.getElementById(button.dataset.copy);
    input.select();
    // The Clipboard API only exists on HTTPS and localhost. On plain http (typical in a LAN) the URL stays
    // selected, ready to copy by hand
    let copied = false;
    try {
        await navigator.clipboard.writeText(input.value);
        copied = true;
    } catch {
        // no clipboard access
    }
    button.textContent = copied ? "Copied" : `Press ${/Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘C" : "Ctrl+C"}`;
    setTimeout(() => { button.textContent = "Copy"; }, copied ? 1500 : 3000);
});

// Forms with data-confirm ask before submitting (used for removing servers, accounts and reader URLs)
document.addEventListener("submit", (event) => {
    const message = event.target.dataset.confirm;
    if (message && !confirm(message)) event.preventDefault();
});
