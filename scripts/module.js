import { Logger } from "./lib/Logger.js";
import { MODULE_ID } from "./data/constants.js";
import {
    registerSettings,
    registerHelpers,
    registerAPI,
    registerSettingsLayout,
    initSocketsForPlayer,
    openQuizLauncher
} from "./composition/createQuizNightContext.js";
import { getActivePlayerApp } from "./composition/sessionState.js";
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
    if (!game.user?.isGM) return;
    try {
        if (game.settings.get(MODULE_ID, "showSceneButton") === false) return;
    } catch {
        return;
    }

    if (game.ionrift?.hud?.registerSceneControl) {
        game.ionrift.hud.registerSceneControl(controls, {
            group: "tokens",
            name: "quiz-night",
            title: "Quiz Night",
            icon: "fas fa-question-circle",
            order: 13,
            gmOnly: true,
            onClick: () => openQuizLauncher()
        });
        return;
    }

    const tokenGroup = Array.isArray(controls)
        ? controls.find(c => c.name === "token" || c.name === "tokens")
        : (controls.tokens || controls.token);
    if (!tokenGroup) return;

    const toolDef = {
        name: "quiz-night",
        title: "Quiz Night",
        icon: "fas fa-question-circle",
        button: true,
        order: 13
    };

    const handler = () => openQuizLauncher();
    if (Array.isArray(tokenGroup.tools)) {
        toolDef.onClick = handler;
        tokenGroup.tools.push(toolDef);
    } else {
        toolDef.onChange = handler;
        if (!tokenGroup.tools) tokenGroup.tools = {};
        tokenGroup.tools[toolDef.name] = toolDef;
    }
});

Hooks.on("chatMessage", (log, message, chatData) => {
    const cmd = message.trim().toLowerCase();
    if (cmd === "/quiz" || cmd === "/quiznight") {
        if (game.user.isGM) {
            openQuizLauncher();
        } else {
            getActivePlayerApp()?.resumeFromDock?.();
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
