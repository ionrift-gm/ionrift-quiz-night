const DOCK_ID = "ionrift-quiz-dock";

/**
 * Bottom bar shown when a live quiz window is closed.
 * Local to Quiz Night. Respite's rejoin bar is not a shared helper.
 *
 * @param {{ label?: string, onResume?: Function, doc?: Document }} [options]
 */
export function showQuizDock({ label = "Quiz in progress", onResume, doc } = {}) {
    const root = doc ?? globalThis.document;
    if (!root?.body || typeof root.createElement !== "function") return null;

    hideQuizDock(root);

    const el = root.createElement("div");
    el.id = DOCK_ID;
    el.innerHTML = `
        <i class="fas fa-question-circle"></i>
        <span class="quiz-dock-label"></span>
        <button type="button">Resume</button>
    `;
    const labelEl = el.querySelector(".quiz-dock-label");
    if (labelEl) labelEl.textContent = label;

    el.querySelector("button")?.addEventListener("click", () => {
        hideQuizDock(root);
        onResume?.();
    });

    root.body.appendChild(el);
    return el;
}

/**
 * @param {Document} [doc]
 */
export function hideQuizDock(doc) {
    const root = doc ?? globalThis.document;
    root?.getElementById?.(DOCK_ID)?.remove();
}

/**
 * @param {Document} [doc]
 */
export function isQuizDockVisible(doc) {
    const root = doc ?? globalThis.document;
    return !!root?.getElementById?.(DOCK_ID);
}
