import { MODULE_LABEL } from "../data/constants.js";

function verbose() {
    try {
        const bag = globalThis.game?.settings?.settings;
        if (!bag?.has("ionrift-library.debug")) return false;
        return !!globalThis.game.settings.get("ionrift-library", "debug");
    } catch { /* setting not registered yet */ }
    return false;
}

export const Logger = globalThis.game?.ionrift?.library?.createLogger?.(MODULE_LABEL) ?? {
    log(...args) {
        if (!verbose()) return;
        console.log(`Ionrift ${MODULE_LABEL} |`, ...args);
    },
    info(...args) {
        if (!verbose()) return;
        console.log(`Ionrift ${MODULE_LABEL} |`, ...args);
    },
    warn(...args) { console.warn(`Ionrift ${MODULE_LABEL} |`, ...args); },
    error(...args) { console.error(`Ionrift ${MODULE_LABEL} |`, ...args); }
};
