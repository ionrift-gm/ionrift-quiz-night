import { Logger } from "../lib/Logger.js";
import { MODULE_ID } from "../data/constants.js";
import { SocketHandler } from "../services/sockets/SocketHandler.js";
import { SessionPersistence } from "../services/SessionPersistence.js";
import { planPlayerSync } from "../services/SessionWindowPolicy.js";
import { QuizEditorApp } from "../apps/QuizEditorApp.js";
import { QuizLauncherApp } from "../apps/QuizLauncherApp.js";
import { QuizMasterApp } from "../apps/QuizMasterApp.js";
import { QuizPlayerApp } from "../apps/QuizPlayerApp.js";
import {
    getActiveMasterApp,
    setActiveMasterApp,
    getActivePlayerApp,
    setActivePlayerApp,
    clearActivePlayerApp
} from "./sessionState.js";

export function registerSettings() {
    game.settings.register(MODULE_ID, "quizzes", {
        scope: "world",
        config: false,
        type: Object,
        default: {}
    });

    SessionPersistence.register();

    game.settings.register(MODULE_ID, "showSceneButton", {
        name: "Left toolbar button",
        hint: "Show Quiz Night on the left token controls.",
        scope: "world",
        config: true,
        type: Boolean,
        default: false,
        onChange: () => {
            ui.controls?.render?.({ force: true });
            ui.controls?.render?.(true);
        }
    });

    game.settings.register(MODULE_ID, "debug", {
        name: "Debug Mode",
        hint: "Enable verbose logging for Quiz Night.",
        scope: "client",
        config: false,
        type: Boolean,
        default: false
    });

    class QuizNightOpenMenu extends FormApplication {
        render() {
            if (game.user.isGM) openQuizLauncher();
            else openOrFocusPlayerApp();
            return this;
        }
        async _updateObject() {}
    }

    game.settings.registerMenu(MODULE_ID, "openQuizNight", {
        name: "Quiz Night",
        label: "Open",
        hint: "Open Quiz Night.",
        icon: "fas fa-question-circle",
        type: QuizNightOpenMenu,
        restricted: true
    });
}

export function registerHelpers() {
    Handlebars.registerHelper("eq", (a, b) => a === b);
    Handlebars.registerHelper("gte", (a, b) => a >= b);
    Handlebars.registerHelper("gt", (a, b) => a > b);
    Handlebars.registerHelper("join", (arr, sep) => Array.isArray(arr) ? arr.join(sep) : "");
    Handlebars.registerHelper("math", (a, op, b) => {
        a = Number(a); b = Number(b);
        switch (op) {
            case "+": return a + b;
            case "-": return a - b;
            case "*": return a * b;
            case "/": return b !== 0 ? a / b : 0;
            default: return a;
        }
    });
    Handlebars.registerHelper("array", function () {
        return Array.from(arguments).slice(0, -1);
    });
}

export function registerAPI() {
    game.ionrift = game.ionrift || {};
    game.ionrift.quizNight = {
        openLauncher() {
            openQuizLauncher();
        },
        openEditor(quizId) {
            if (!game.user.isGM) return;
            new QuizEditorApp(quizId).render({ force: true });
        },
        async startQuiz(quizId, { autoStart = false } = {}) {
            if (!game.user.isGM) return null;
            const quizzes = game.settings.get(MODULE_ID, "quizzes") || {};
            const quiz = quizzes[quizId];
            if (!quiz) {
                ui.notifications.error("Quiz not found.");
                return null;
            }
            let app = getActiveMasterApp();
            if (app) {
                if (autoStart) {
                    try { await app.close({ force: true }); } catch {}
                    app = new QuizMasterApp(quiz);
                    setActiveMasterApp(app);
                    app.render({ force: true });
                } else {
                    ui.notifications.warn("A quiz is already in progress.");
                }
            } else {
                app = new QuizMasterApp(quiz);
                setActiveMasterApp(app);
                app.render({ force: true });
            }
            if (autoStart) {
                await app.start();
            }
            return app;
        },
        getMasterApp() {
            return getActiveMasterApp();
        },
        getPlayerApp() {
            return getActivePlayerApp();
        },
        listQuizzes() {
            const quizzes = game.settings.get(MODULE_ID, "quizzes") || {};
            return Object.values(quizzes).map(q => ({
                id: q.id,
                name: q.name,
                rounds: q.rounds?.length || 0,
                questions: q.rounds?.reduce((sum, r) => sum + (r.questions?.length || 0), 0) || 0
            }));
        },
        openPlayerApp() {
            openOrFocusPlayerApp();
        },
        duplicateQuiz(quizId) {
            if (!game.user.isGM) return null;
            const quizzes = foundry.utils.deepClone(game.settings.get(MODULE_ID, "quizzes") || {});
            const source = quizzes[quizId];
            if (!source) return null;
            const copy = foundry.utils.deepClone(source);
            copy.id = foundry.utils.randomID();
            copy.name = `${source.name || "Quiz"} (Copy)`;
            copy.createdAt = Date.now();
            copy.updatedAt = Date.now();
            quizzes[copy.id] = copy;
            return game.settings.set(MODULE_ID, "quizzes", quizzes).then(() => copy);
        },
        recoverSession() {
            if (!game.user.isGM) return null;
            if (getActiveMasterApp()) return null;
            const snapshot = SessionPersistence.load();
            if (!snapshot) return null;
            const app = QuizMasterApp.recover(snapshot);
            if (app) {
                setActiveMasterApp(app);
                app.render({ force: true });
                app.syncPlayers();
                Logger.log("Recovered active quiz session after reload.");
            }
            return app;
        }
    };
}

export async function registerSettingsLayout() {
    try {
        const { SettingsLayout } = await import("../../../ionrift-library/scripts/utils/SettingsLayout.js");
        const { QuizPackRegistryApp } = await import("../apps/QuizPackRegistryApp.js");
        SettingsLayout.registerPackButton(MODULE_ID, QuizPackRegistryApp);
        SettingsLayout.registerFooter(MODULE_ID);
    } catch (e) {
        Logger.warn("SettingsLayout registration failed:", e.message);
    }
}

export function openQuizLauncher() {
    if (!game.user.isGM) {
        openOrFocusPlayerApp();
        return;
    }
    const existing = QuizLauncherApp.getInstance();
    if (existing) {
        existing.render({ force: true });
        existing.bringToFront?.();
        return existing;
    }
    const app = new QuizLauncherApp();
    app.render({ force: true });
    return app;
}

export function openOrFocusPlayerApp() {
    let app = getActivePlayerApp();
    if (app) {
        if (app._docked) app.resumeFromDock();
        else app.render({ force: true });
        SocketHandler.requestState();
        return app;
    }
    app = new QuizPlayerApp();
    setActivePlayerApp(app);
    app.render({ force: true });
    SocketHandler.requestState();
    return app;
}

export function initSocketsForPlayer() {
    SocketHandler.init();

    SocketHandler.register((data) => {
        if (data.type === "quiz:start") {
            if (!game.user.isGM) {
                openOrFocusPlayerApp();
            }
        }
    });

    if (!game.user.isGM) {
        SocketHandler.register((data) => {
            if (data.type !== "state:sync" && data.type !== "quiz:end") return;
            if (getActivePlayerApp()) return;
            if (planPlayerSync(data).openIfMissing) openOrFocusPlayerApp();
        });
        setTimeout(() => SocketHandler.requestState(), 2000);
    }
}

export { clearActivePlayerApp, getActivePlayerApp };
