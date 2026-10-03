import { Logger } from "../lib/Logger.js";
import { MODULE_ID } from "../data/constants.js";
import { shouldRecoverSession } from "./SessionWindowPolicy.js";

const SETTING_KEY = "activeSession";

export class SessionPersistence {

    static register() {
        game.settings.register(MODULE_ID, SETTING_KEY, {
            scope: "world",
            config: false,
            type: Object,
            default: null
        });
    }

    static save(engine, quizData, timerState = {}, extra = {}) {
        if (!game.user.isGM) return Promise.resolve();
        if (!engine || engine.state === "idle") {
            return this.clear();
        }
        const snapshot = engine.serialize();
        snapshot.quizData = quizData;
        snapshot.timerState = timerState;
        snapshot.savedAt = Date.now();
        Object.assign(snapshot, extra);
        try {
            return Promise.resolve(game.settings.set(MODULE_ID, SETTING_KEY, snapshot)).catch(err => {
                Logger.warn("Session save failed:", err?.message);
            });
        } catch (err) {
            Logger.warn("Session save failed:", err.message);
            return Promise.resolve();
        }
    }

    static async clear() {
        if (!game.user.isGM) return;
        try {
            await game.settings.set(MODULE_ID, SETTING_KEY, null);
        } catch (err) {
            Logger.warn("Session clear failed:", err.message);
        }
    }

    static load() {
        try {
            return game.settings.get(MODULE_ID, SETTING_KEY) || null;
        } catch {
            return null;
        }
    }

    static hasActiveSession() {
        return shouldRecoverSession(this.load());
    }
}
