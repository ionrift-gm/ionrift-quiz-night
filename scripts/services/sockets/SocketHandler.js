import { Logger } from "../../lib/Logger.js";
import { MODULE_ID } from "../../data/constants.js";

/** @type {import("../../../../ionrift-library/scripts/services/sockets/ModuleSocket.js").ModuleSocket|null} */
let _socket = null;

/**
 * Minimal fallback transport if ionrift-library has not initialized or is absent.
 */
function createFallbackSocket() {
    let bound = null;
    const listeners = new Set();
    const typeHandlers = new Map();
    const channel = `module.${MODULE_ID}`;

    const dispatch = (data) => {
        if (!data?.type) return;
        if (data.targetGM && !globalThis.game?.user?.isGM) return;
        if (data.targetUserId && data.targetUserId !== globalThis.game?.user?.id) return;
        for (const l of listeners) {
            try { l(data); } catch (e) { Logger.error("Fallback socket listener error:", e); }
        }
        if (typeHandlers.has(data.type)) {
            for (const h of typeHandlers.get(data.type)) {
                try { h(data); } catch (e) { Logger.error("Fallback socket handler error:", e); }
            }
        }
    };

    return {
        init() {
            if (!globalThis.game?.socket) return false;
            if (bound) globalThis.game.socket.off(channel, bound);
            bound = dispatch;
            globalThis.game.socket.on(channel, bound);
            return true;
        },
        destroy() {
            if (bound && globalThis.game?.socket) {
                globalThis.game.socket.off(channel, bound);
                bound = null;
            }
            listeners.clear();
            typeHandlers.clear();
        },
        listen(handler) {
            if (typeof handler !== "function") return () => {};
            listeners.add(handler);
            return () => listeners.delete(handler);
        },
        register(handler) { return this.listen(handler); },
        on(type, handler) {
            if (!type || typeof handler !== "function") return () => {};
            if (!typeHandlers.has(type)) typeHandlers.set(type, new Set());
            typeHandlers.get(type).add(handler);
            return () => typeHandlers.get(type)?.delete(handler);
        },
        onGM(type, handler) {
            return this.on(type, (data) => {
                if (globalThis.game?.user?.isGM) handler(data);
            });
        },
        off(typeOrHandler, handler) {
            if (typeof typeOrHandler === "function") {
                listeners.delete(typeOrHandler);
                for (const set of typeHandlers.values()) set.delete(typeOrHandler);
            } else if (typeof typeOrHandler === "string" && typeof handler === "function") {
                typeHandlers.get(typeOrHandler)?.delete(handler);
            }
        },
        emit(type, payload = {}, options = {}) {
            if (!globalThis.game?.socket) return null;
            const envelope = {
                type,
                senderId: globalThis.game?.user?.id,
                timestamp: Date.now(),
                ...options,
                ...payload
            };
            globalThis.game.socket.emit(channel, envelope);
            return envelope;
        },
        emitToGM(type, payload = {}) {
            return this.emit(type, payload, { targetGM: true });
        },
        emitToUser(userId, type, payload = {}) {
            return this.emit(type, payload, { targetUserId: userId });
        },
        _onReceive(data) {
            dispatch(data);
        }
    };
}

/**
 * Lazy socket accessor, adopting ionrift-library's ModuleSocket when available.
 */
function getSocket() {
    if (!_socket) {
        if (globalThis.game?.ionrift?.library?.createSocket) {
            _socket = globalThis.game.ionrift.library.createSocket(MODULE_ID, { logger: Logger });
        } else {
            _socket = createFallbackSocket();
        }
    }
    return _socket;
}

/**
 * Domain-specific socket facade for Ionrift Quiz Night.
 *
 * Delegates low-level transport and multi-GM leader election to `ModuleSocket`
 * while exposing all Quiz Night domain event contracts.
 */
export class SocketHandler {

    /**
     * Expose the underlying transport instance.
     */
    static get socket() {
        return getSocket();
    }

    static init() {
        getSocket().init();
        Logger.log("Socket handler initialized.");
    }

    static destroy() {
        getSocket().destroy();
    }

    /**
     * Wildcard message listener. Retained for 100% backwards compatibility.
     * @param {(data: object) => void} handler
     * @returns {() => void} Unsubscribe callback
     */
    static register(handler) {
        return getSocket().listen(handler);
    }

    /**
     * Unregister a handler.
     * @param {Function} handler
     */
    static unregister(handler) {
        getSocket().off(handler);
    }

    /**
     * Modern typed event listener.
     * @param {string} type
     * @param {(data: object) => void} handler
     * @returns {() => void} Unsubscribe callback
     */
    static on(type, handler) {
        return getSocket().on(type, handler);
    }

    /**
     * Modern responsible-GM typed listener. Only executes on the single active leader GM.
     * @param {string} type
     * @param {(data: object) => (void|Promise<void>)} handler
     * @returns {() => void} Unsubscribe callback
     */
    static onGM(type, handler) {
        return getSocket().onGM(type, handler);
    }

    /**
     * Generic broadcast.
     * @param {string} type
     * @param {object} [payload={}]
     */
    static emit(type, payload = {}) {
        return getSocket().emit(type, payload);
    }

    /**
     * Targeted GM emission.
     * @param {string} type
     * @param {object} [payload={}]
     */
    static emitToGM(type, payload = {}) {
        return getSocket().emitToGM(type, payload);
    }

    /**
     * Targeted user emission.
     * @param {string} userId
     * @param {string} type
     * @param {object} [payload={}]
     */
    static emitToUser(userId, type, payload = {}) {
        return getSocket().emitToUser(userId, type, payload);
    }

    // --- Domain Broadcasts (GM -> All) ---

    static broadcastQuizStart(quizName, prizes) {
        this.emit("quiz:start", { quizName, prizes });
    }

    static broadcastRoundStart(roundData) {
        this.emit("round:start", {
            roundName: roundData.name,
            roundType: roundData.type,
            roundTag: roundData.tag,
            roundNumber: roundData.roundNumber,
            totalRounds: roundData.totalRounds,
            questionCount: roundData.questionCount
        });
    }

    static broadcastQuestion(questionData) {
        this.emit("question:show", { question: questionData });
    }

    static broadcastTimer(timerData) {
        this.emit("timer:tick", timerData);
    }

    static broadcastPause(paused) {
        this.emit("timer:pause", { paused });
    }

    static broadcastTeaser(teaserText, roundNumber) {
        this.emit("teaser", { text: teaserText, roundNumber });
    }

    static broadcastRoundEnd(roundNumber) {
        this.emit("round:end", { roundNumber });
    }

    static broadcastQuizEnd(revealData, extra = {}) {
        this.emit("quiz:end", { reveal: revealData, ...extra });
    }

    static broadcastPrizeReveal(payload) {
        this.emit("prize:reveal", payload);
    }

    static broadcastLock() {
        this.emit("round:locked", {});
    }

    static broadcastLockWarning(seconds) {
        this.emit("lock:warning", { seconds });
    }

    static broadcastTimerExtend(timerData) {
        this.emit("timer:extend", timerData);
    }

    static broadcastMarkingStep(currentStep, revealLog, markingIndex, totalQuestions) {
        this.emit("marking:step", { currentStep, revealLog, markingIndex, totalQuestions });
    }

    static broadcastSkip() {
        this.emit("question:skip", {});
    }

    static broadcastStateSync(payload) {
        this.emit("state:sync", payload);
    }

    // --- Domain Requests (Player -> GM) ---

    static requestState() {
        this.emitToGM("state:request", { userId: globalThis.game.user.id });
    }

    static submitAnswer(answer, questionIndex, extra = {}) {
        this.emitToGM("answer:submit", {
            userId: globalThis.game.user.id,
            answer,
            questionIndex,
            timestamp: Date.now(),
            ...extra
        });
    }

    static submitAppeal(questionIndex, note = "") {
        this.emitToGM("answer:appeal", {
            userId: globalThis.game.user.id,
            questionIndex,
            note,
            timestamp: Date.now()
        });
    }

    /**
     * Manual injection for testing or debug callers.
     * @param {object} data
     */
    static _receive(data) {
        getSocket()._onReceive?.(data);
    }
}
