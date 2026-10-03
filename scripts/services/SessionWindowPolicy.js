/**
 * What closing a Quiz Night window is allowed to do.
 * Once a quiz has started, the window minimizes. Only the quizmaster
 * can end it for every client, by abandoning or by running to the result.
 */

import { PrizeCeremony } from "./PrizeCeremony.js";

export function isQuizFormallyStarted(state) {
    return !!state && state !== "idle" && state !== "quiz-end";
}

/**
 * A persisted snapshot should reopen after a refresh while the sitting is live,
 * or while the prize ceremony still has placings to reveal.
 * @param {object|null} snapshot
 */
export function shouldRecoverSession(snapshot) {
    return isQuizFormallyStarted(snapshot?.state) || PrizeCeremony.isPendingInSnapshot(snapshot);
}

/**
 * @param {{ role: "gm"|"player", state: string, intent?: "window"|"abandon", ceremonyPending?: boolean }} input
 */
export function planWindowClose({ role, state, intent = "window", ceremonyPending = false }) {
    const started = isQuizFormallyStarted(state);

    if (intent === "abandon") {
        if (role !== "gm" || (!started && state !== "quiz-end")) {
            return { action: "dismiss", broadcast: null, clearSession: false, showDock: false };
        }
        return {
            action: "end-for-all",
            broadcast: { active: false, state: "idle", aborted: true },
            clearSession: true,
            showDock: false
        };
    }

    // Prizes are handed out as placings are revealed; closing mid-reveal must not drop them.
    const revealUnfinished = role === "gm" && state === "quiz-end" && ceremonyPending;
    if (started || revealUnfinished) {
        return { action: "minimize", broadcast: null, clearSession: false, showDock: true };
    }

    if (role === "gm" && state === "quiz-end") {
        return {
            action: "close-players",
            broadcast: { active: false, state: "idle", concluded: true },
            clearSession: true,
            showDock: false
        };
    }

    return {
        action: "dismiss",
        broadcast: null,
        clearSession: role === "gm",
        showDock: false
    };
}

/**
 * What a player client does with a sync or end broadcast from the quizmaster.
 * @param {object} data
 */
export function planPlayerSync(data = {}) {
    if (data.aborted || (data.active === false && data.state !== "quiz-end")) {
        return {
            action: "end-local",
            hideDock: true,
            reopen: false,
            notifyEnded: !!data.aborted,
            sessionLive: false,
            openIfMissing: false
        };
    }

    if (data.type === "quiz:end" || data.state === "quiz-end") {
        return {
            action: "show-conclusion",
            hideDock: true,
            reopen: true,
            notifyEnded: false,
            sessionLive: false,
            openIfMissing: data.type === "quiz:end" || !!data.ceremonyLive
        };
    }

    if (data.type === "quiz:start" || data.active === true) {
        return {
            action: "keep",
            hideDock: false,
            reopen: false,
            notifyEnded: false,
            sessionLive: true,
            openIfMissing: true
        };
    }

    return {
        action: "idle",
        hideDock: false,
        reopen: false,
        notifyEnded: false,
        sessionLive: false,
        openIfMissing: false
    };
}
