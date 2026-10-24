/**
 * Modal confirmation overlay for Quiz Night actions (Abandon Quiz, End Quiz, etc.).
 * Mirrors the Respite `confirmAbandonRest` pattern (.ionrift-armor-modal-overlay)
 * and enforces a singleton lock so rapid clicks cannot spawn duplicate modals.
 */

let _activeModalPromise = null;

/**
 * Returns true if a confirmation modal is currently open.
 * @returns {boolean}
 */
export function isQuizModalOpen() {
    return _activeModalPromise !== null;
}

/**
 * Open a non-duplicating confirmation modal.
 * If a modal is already open, subsequent calls resolve to `false` immediately
 * without stacking a second dialog.
 *
 * @param {object} [options]
 * @param {string} [options.title="Abandon Quiz?"]
 * @param {string} [options.message="This will cancel the quiz for all players. Prizes will not be awarded."]
 * @param {string} [options.confirmLabel="Abandon"]
 * @param {string} [options.cancelLabel="Continue Quiz"]
 * @param {string} [options.confirmIcon="fa-ban"]
 * @param {Document} [options.doc]
 * @returns {Promise<boolean>}
 */
export function confirmQuizModal({
    title = "Abandon Quiz?",
    message = "This will cancel the quiz for all players. Prizes will not be awarded.",
    confirmLabel = "Abandon",
    cancelLabel = "Continue Quiz",
    confirmIcon = "fa-ban",
    doc = globalThis.document
} = {}) {
    if (_activeModalPromise) {
        return Promise.resolve(false);
    }

    // Headless / Node test fallback when no DOM document is available
    if (!doc?.body?.appendChild || !doc?.createElement) {
        if (typeof Dialog !== "undefined" && typeof Dialog.confirm === "function") {
            _activeModalPromise = Promise.resolve(
                Dialog.confirm({
                    title,
                    content: `<p>${message}</p>`,
                    options: { classes: ["ionrift-window", "glass-ui"] }
                })
            ).then(Boolean).finally(() => {
                _activeModalPromise = null;
            });
            return _activeModalPromise;
        }
        return Promise.resolve(false);
    }

    // Clean up any stale overlay if one somehow lingered in the DOM
    const existing = doc.querySelector?.(".ionrift-armor-modal-overlay");
    if (existing) existing.remove();

    _activeModalPromise = new Promise((resolve) => {
        const overlay = doc.createElement("div");
        overlay.className = "ionrift-armor-modal-overlay";
        overlay.innerHTML = `
            <div class="ionrift-armor-modal">
                <h3><i class="fas fa-exclamation-triangle"></i> ${title}</h3>
                <p>${message}</p>
                <div class="ionrift-armor-modal-buttons">
                    <button type="button" class="btn-armor-confirm">
                        <i class="fas ${confirmIcon}"></i> ${confirmLabel}
                    </button>
                    <button type="button" class="btn-armor-cancel">
                        <i class="fas fa-arrow-left"></i> ${cancelLabel}
                    </button>
                </div>
            </div>
        `;

        let settled = false;
        const cleanup = (result) => {
            if (settled) return;
            settled = true;
            doc.removeEventListener?.("keydown", onKeyDown);
            overlay.remove();
            _activeModalPromise = null;
            resolve(result);
        };

        const onKeyDown = (e) => {
            if (e.key === "Escape") cleanup(false);
        };

        overlay.querySelector(".btn-armor-confirm")?.addEventListener("click", () => cleanup(true));
        overlay.querySelector(".btn-armor-cancel")?.addEventListener("click", () => cleanup(false));
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) cleanup(false);
        });
        doc.addEventListener?.("keydown", onKeyDown);

        doc.body.appendChild(overlay);
    });

    return _activeModalPromise;
}
