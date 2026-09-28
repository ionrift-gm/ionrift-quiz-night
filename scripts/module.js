import { Logger } from "./lib/Logger.js";
import { MODULE_ID } from "./data/constants.js";
import {
    registerSettings,
    registerHelpers,
    registerAPI,
    registerSettingsLayout,
    initSocketsForPlayer,
    openOrFocusPlayerApp,
    openQuizLauncher
} from "./composition/createQuizNightContext.js";
import { SessionPersistence } from "./services/SessionPersistence.js";
import { PrizeDelivery } from "./services/PrizeDelivery.js";

Hooks.once("init", async () => {
    Logger.log("Initializing...");

    registerHelpers();
    registerAPI();
    registerSettings();
    await registerSettingsLayout();
});

Hooks.on("getSceneControlButtons", (controls) => {
    try {
        if (game.settings.get(MODULE_ID, "showSceneButton") === false) return;
    } catch {
        return;
    }
    const tokenGroup = Array.isArray(controls)
        ? controls.find(c => c.name === "token")
        : controls.tokens;
    if (!tokenGroup) return;

    if (game.user.isGM) {
        const toolDef = {
            name: "quiz-night",
            title: "Quiz Night",
            icon: "fas fa-question-circle",
            button: true,
            onClick: () => openQuizLauncher()
        };
        if (Array.isArray(tokenGroup.tools)) {
            tokenGroup.tools.push(toolDef);
        } else {
            tokenGroup.tools[toolDef.name] = toolDef;
        }
    } else {
        const toolDef = {
            name: "quiz-night-player",
            title: "Quiz Night",
            icon: "fas fa-question-circle",
            button: true,
            onClick: () => openOrFocusPlayerApp()
        };
        if (Array.isArray(tokenGroup.tools)) {
            tokenGroup.tools.push(toolDef);
        } else {
            tokenGroup.tools[toolDef.name] = toolDef;
        }
    }
});

Hooks.on("chatMessage", (log, message, chatData) => {
    const cmd = message.trim().toLowerCase();
    if (cmd === "/quiz" || cmd === "/quiznight") {
        if (game.user.isGM) {
            openQuizLauncher();
        } else {
            openOrFocusPlayerApp();
        }
        return false;
    }
});

function bindChatPrizeInspect(_message, html) {
    const root = html?.[0] || html;
    PrizeDelivery.bindPrizeInspect(root);
}

Hooks.on("renderChatMessage", bindChatPrizeInspect);
Hooks.on("renderChatMessageHTML", bindChatPrizeInspect);

Hooks.once("ready", () => {
    Logger.log("Ready.");
    initSocketsForPlayer();

    if (game.user.isGM && SessionPersistence.hasActiveSession()) {
        Logger.log("Detected persisted quiz session, recovering...");
        game.ionrift.quizNight.recoverSession();
    }
});
