import { Logger } from "../lib/Logger.js";
import { MODULE_ID, QUIZ_EMOTES } from "../data/constants.js";
import { SocketHandler } from "../services/sockets/SocketHandler.js";
import { PrizeDelivery } from "../services/PrizeDelivery.js";
import { TimerEngine } from "../services/TimerEngine.js";
import { clearActivePlayerApp } from "../composition/sessionState.js";
import { planWindowClose, planPlayerSync } from "../services/SessionWindowPolicy.js";
import { showQuizDock, hideQuizDock } from "../ui/QuizDock.js";
import { renderEmoteWisp } from "../ui/emoteWisp.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class QuizPlayerApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "ionrift-quiz-player",
        classes: ["ionrift-window", "glass-ui", "ionrift-quiz-player"],
        window: {
            title: "Quiz Night",
            resizable: true
        },
        position: { width: 680, height: 480 },
        actions: {
            "submit-text": QuizPlayerApp.#onSubmitText,
            "select-choice": QuizPlayerApp.#onSelectChoice,
            "confirm-choice": QuizPlayerApp.#onConfirmChoice,
            "select-tf": QuizPlayerApp.#onSelectTF,
            "confirm-tf": QuizPlayerApp.#onConfirmTF,
            "submit-number": QuizPlayerApp.#onSubmitNumber,
            "appeal": QuizPlayerApp.#onAppeal,
            "navigate-question": QuizPlayerApp.#onNavigateQuestion,
            "send-emote": QuizPlayerApp.#onSendEmote
        }
    };

    static PARTS = {
        body: { template: `modules/${MODULE_ID}/templates/quiz-player.hbs` }
    };

    _state = "idle";
    _question = null;
    _answeredQuestionIndex = null;
    _roundInfo = null;
    _timer = { remaining: 0, total: 0, progress: 1 };
    _paused = false;
    _teaser = "";
    _quizName = "";
    _prizes = {};
    _finalReveal = null;
    _ceremonyCards = [];
    _currentMarkingStep = null;
    _pastMarkingLog = [];
    _revealLog = [];
    _unregisterSocket = null;
    _myLastAnswer = null;
    _lockWarning = false;
    _lockWarningRemaining = 0;
    _lockWarningInterval = null;
    _myRoundCorrect = 0;
    _myRoundTotal = 0;
    _myNudge = "";
    _answeredByUser = {};
    _lastEmoteLine = "";

    /** Answer sheet: maps questionIndex to { answer, questionText } for the current round */
    _roundAnswerMap = new Map();
    /** All question objects shown this round (from question:show broadcasts) */
    _askedQuestions = [];
    /** When navigating to a past question, holds that question's index; null = live */
    _navigatedQuestionIndex = null;
    /** Pending MC/TF selection before confirm */
    _pendingChoice = null;
    /** True after the quizmaster has started this sitting, until it ends. */
    _sessionLive = false;
    _docked = false;
    _userConnectedHook = null;

    constructor(options = {}) {
        super(options);
        this._unregisterSocket = SocketHandler.register((data) => this._handleSocket(data));
        if (typeof Hooks !== "undefined" && Hooks.on) {
            this._userConnectedHook = Hooks.on("userConnected", () => {
                if (!this.rendered) return;
                const focused = this.element?.querySelector?.("input:focus, textarea:focus");
                if (!focused) this.render();
            });
        }
    }

    render(options) {
        if (this._docked) return this;
        return super.render(options);
    }

    resumeFromDock() {
        this._docked = false;
        hideQuizDock();
        return this.render({ force: true });
    }

    _closeState() {
        if (!this._sessionLive) return "idle";
        if (this._state === "quiz-end") return "quiz-end";
        return "running";
    }

    get title() {
        const base = "Quiz Night";
        switch (this._state) {
            case "question":
            case "answered":
                return `${base} \u00b7 Q${this._question?.questionNumber || "?"}/${this._question?.totalQuestions || "?"}`;
            case "marking":
                return `${base} \u00b7 Marking`;
            case "locked":
                return `${base} \u00b7 Pens Down`;
            case "round-end":
                return `${base} \u00b7 Round Complete`;
            case "quiz-end":
                return `${base} \u00b7 Finished`;
            default:
                return base;
        }
    }

    async _prepareContext(options) {
        const myResult = this._currentMarkingStep
            ? this._currentMarkingStep.playerResults?.find(r => r.userId === game.user.id) || null
            : null;

        const isNavigating = this._navigatedQuestionIndex !== null;
        const displayQuestion = isNavigating
            ? this._askedQuestions.find(q => q.questionIndex === this._navigatedQuestionIndex) || this._question
            : this._question;

        const navAnswer = isNavigating
            ? this._roundAnswerMap.get(this._navigatedQuestionIndex)
            : null;

        const questionStrip = this._buildQuestionStrip();
        const answerSheet = this._buildAnswerSheet();
        const revealedCount = answerSheet.filter(q => q.revealed).length;

        const myMarkingTally = { correct: 0, total: 0, points: 0 };
        const myId = game.user.id;
        const allRevealedSteps = (this._revealLog && this._revealLog.length)
            ? this._revealLog
            : [...this._pastMarkingLog, ...(this._currentMarkingStep ? [this._currentMarkingStep] : [])];
        for (const step of allRevealedSteps) {
            const mine = step.playerResults?.find(r => r.userId === myId);
            if (mine) {
                myMarkingTally.total++;
                if (mine.correct) {
                    myMarkingTally.correct++;
                    myMarkingTally.points += mine.points || 0;
                }
            }
        }

        const isQuestionPhase = this._state === "question" || this._state === "answered" || this._state === "locked";
        const askedCount = isQuestionPhase ? (this._askedQuestions.length || (this._question ? 1 : 0)) : 0;
        const activePlayers = (game.users || []).filter(u => !u.isGM && u.active);
        const tableRoster = activePlayers.map(u => {
            const userAnsweredList = Array.isArray(this._answeredByUser?.[u.id]) ? this._answeredByUser[u.id] : [];
            const myRoundCount = u.id === myId ? Math.max(this._roundAnswerMap.size, userAnsweredList.length) : userAnsweredList.length;
            const hasCurrent = this._question?.questionIndex !== undefined && (
                userAnsweredList.includes(this._question.questionIndex) ||
                (u.id === myId && (this._answeredQuestionIndex === this._question.questionIndex || this._roundAnswerMap.has(this._question.questionIndex)))
            );
            const answered = askedCount > 0
                ? (myRoundCount >= askedCount || (askedCount <= 1 && hasCurrent))
                : false;
            return {
                id: u.id,
                name: u.name,
                color: u.color || "#9ca3af",
                isMe: u.id === myId,
                answered
            };
        });
        const tableAnsweredCount = tableRoster.filter(p => p.answered).length;
        const viewedQI = isNavigating ? this._navigatedQuestionIndex : this._question?.questionIndex;
        const hasAnswerForViewed = viewedQI !== undefined && viewedQI !== null && (
            this._roundAnswerMap.has(viewedQI) ||
            (!isNavigating && this._answeredQuestionIndex === viewedQI)
        );
        const effectiveState = (this._state === "question" || this._state === "answered")
            ? (hasAnswerForViewed ? "answered" : "question")
            : this._state;

        const currentRoundNumber = this._roundInfo?.roundNumber || this._question?.roundNumber || 0;
        const totalRounds = this._roundInfo?.totalRounds || 0;
        const roundsMeta = Array.isArray(this._roundInfo?.roundsMeta) ? this._roundInfo.roundsMeta : [];
        const roundTrail = [];
        if (totalRounds > 0 && currentRoundNumber > 0) {
            for (let r = 1; r <= totalRounds; r++) {
                let status = "upcoming";
                if (r < currentRoundNumber) status = "done";
                else if (r === currentRoundNumber) {
                    status = (this._state === "round-end") ? "just-done" : "current";
                }
                const meta = roundsMeta.find(m => m.number === r);
                const knownName = (r <= currentRoundNumber)
                    ? (meta?.name || (r === currentRoundNumber ? (this._roundInfo?.roundName || "") : ""))
                    : "";
                roundTrail.push({
                    number: r,
                    status,
                    isCompleted: status === "done" || status === "just-done",
                    name: knownName,
                    tooltip: knownName ? `Round ${r}: ${knownName}` : `Round ${r}`
                });
            }
        }
        const isLastRound = totalRounds > 0 && currentRoundNumber >= totalRounds;
        const nextRoundNumber = (!isLastRound && currentRoundNumber > 0) ? currentRoundNumber + 1 : null;

        return {
            state: effectiveState,
            quizName: this._quizName,
            prizes: this._prizes,
            prizeTiers: PrizeDelivery.toPrizeTierList(this._prizes),
            ceremonyCards: [...(this._ceremonyCards || [])].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999)),
            roundInfo: this._roundInfo,
            roundTrail,
            isLastRound,
            nextRoundNumber,
            question: displayQuestion,
            answeredThisQuestion: this._answeredQuestionIndex === this._question?.questionIndex,
            timer: this._timer,
            timerActive: (this._timer?.total || 0) > 0 && (this._timer?.remaining || 0) > 0,
            timerClock: TimerEngine.formatClock(this._timer?.remaining),
            paused: this._paused,
            teaser: this._teaser,
            myNudge: this._myNudge,
            tableRoster,
            tableAnsweredCount,
            emotes: QUIZ_EMOTES,
            lastEmoteLine: this._lastEmoteLine,
            finalReveal: this._finalReveal,
            userId: game.user.id,
            currentMarkingStep: this._currentMarkingStep,
            pastMarkingLog: this._pastMarkingLog,
            myCurrentResult: myResult,
            canAppeal: myResult && !myResult.correct && !myResult.timedOut && !myResult.appealed,
            myAnswer: isNavigating
                ? (navAnswer ? String(navAnswer.answer) : "")
                : (this._myLastAnswer !== null ? String(this._myLastAnswer) : ""),
            myAnswerIndex: isNavigating
                ? (navAnswer && typeof navAnswer.answer === "number" ? navAnswer.answer : null)
                : (typeof this._myLastAnswer === "number" ? this._myLastAnswer : null),
            pointsPerQuestion: this._question?.pointsPerQuestion || 10,
            questionStrip,
            isNavigating,
            navigatedQuestionIndex: this._navigatedQuestionIndex,
            lockWarning: this._lockWarning,
            lockWarningRemaining: this._lockWarningRemaining || 10,
            myRoundSummary: (this._state === "round-end" && this._myRoundTotal > 0)
                ? { correct: this._myRoundCorrect, total: this._myRoundTotal, message: `You answered ${this._myRoundCorrect} of ${this._myRoundTotal} correctly this round.` }
                : null,
            pendingChoice: this._pendingChoice,
            hasPendingChoice: this._pendingChoice !== null,
            answerSheet,
            revealedCount,
            myMarkingTally: myMarkingTally.total > 0 ? myMarkingTally : null
        };
    }

    _onRender(context, options) {
        const textInput = this.element.querySelector('[name="text-answer"]');
        if (textInput && !textInput.dataset.bound) {
            textInput.dataset.bound = "1";
            textInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    const answer = textInput.value?.trim();
                    if (answer) this._submitAnswer(answer);
                }
            });
        }

        const currentRevealCard = this.element.querySelector(".answer-sheet-card.is-current-reveal");
        if (currentRevealCard && typeof currentRevealCard.scrollIntoView === "function") {
            currentRevealCard.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }

        if (this._lockWarning) {
            this._updateLockWarningDom();
        }

        PrizeDelivery.bindPrizeInspect(this.element);
    }

    static #onSubmitText(event, target) {
        const input = this.element.querySelector('[name="text-answer"]');
        const answer = input?.value?.trim();
        if (!answer) return;
        this._submitAnswer(answer);
    }

    static #onSelectChoice(event, target) {
        this._pendingChoice = Number(target.dataset.index);
        this.render();
    }

    static #onConfirmChoice(event, target) {
        if (this._pendingChoice === null) return;
        const choice = this._pendingChoice;
        this._pendingChoice = null;
        this._submitAnswer(choice);
    }

    static #onSelectTF(event, target) {
        this._pendingChoice = target.dataset.value;
        this.render();
    }

    static #onConfirmTF(event, target) {
        if (this._pendingChoice === null) return;
        const choice = this._pendingChoice === "true";
        this._pendingChoice = null;
        this._submitAnswer(choice);
    }

    static #onSubmitNumber(event, target) {
        const input = this.element.querySelector('[name="number-answer"]');
        const answer = Number(input?.value);
        if (!Number.isFinite(answer)) return;
        this._submitAnswer(answer);
    }

    static #onAppeal(event, target) {
        const questionIndex = Number(target.dataset.questionIndex);
        SocketHandler.submitAppeal(questionIndex);
        const step = (this._revealLog || []).find(s => s.questionIndex === questionIndex)
            || (this._currentMarkingStep?.questionIndex === questionIndex ? this._currentMarkingStep : null);
        if (step) {
            const mine = step.playerResults?.find(r => r.userId === game.user.id);
            if (mine) mine.appealed = true;
        }
        this.render();
    }

    static #onNavigateQuestion(event, target) {
        const idx = Number(target.dataset.questionIndex);
        if (!Number.isFinite(idx)) return;

        this._pendingChoice = null;
        const liveIndex = this._question?.questionIndex;
        if (idx === liveIndex) {
            this._navigatedQuestionIndex = null;
        } else {
            const asked = this._askedQuestions.find(q => q.questionIndex === idx);
            if (!asked) return;
            this._navigatedQuestionIndex = idx;
        }
        this.render();
    }

    static #onSendEmote(event, target) {
        const emoteId = target.dataset.emoteId;
        const emote = QUIZ_EMOTES.find(e => e.id === emoteId);
        if (!emote) return;
        const userName = game.user?.name || "Player";
        const color = game.user?.color || "#ffdc82";
        if (!this._handleEmote(emote, userName, color)) return;
        SocketHandler.sendEmote(emote.id, userName, color);
    }

    _handleEmote(emote, userName, color = "#ffdc82") {
        const line = renderEmoteWisp(this.element, emote, userName, color);
        if (line) this._lastEmoteLine = line;
        return Boolean(line);
    }

    _submitAnswer(answer, extra = {}) {
        if (this._state !== "question" && this._state !== "answered") return;

        const qIndex = (this._navigatedQuestionIndex !== null)
            ? this._navigatedQuestionIndex
            : this._question?.questionIndex;
        if (qIndex === undefined || qIndex === null) return;

        this._pendingChoice = null;
        SocketHandler.submitAnswer(answer, qIndex, extra);

        const questionText = this._askedQuestions.find(q => q.questionIndex === qIndex)?.text
            || this._question?.text || "";
        this._roundAnswerMap.set(qIndex, { answer, questionText });

        if (qIndex === this._question?.questionIndex) {
            this._answeredQuestionIndex = qIndex;
            this._myLastAnswer = answer;
            this._state = "answered";
        } else {
            const liveQI = this._question?.questionIndex;
            this._state = (liveQI !== undefined && (this._roundAnswerMap.has(liveQI) || this._answeredQuestionIndex === liveQI))
                ? "answered"
                : "question";
        }

        this._navigatedQuestionIndex = null;
        this.render();
    }

    _handleSocket(data) {
        switch (data.type) {
            case "quiz:start":
                this._sessionLive = true;
                this._quizName = data.quizName;
                this._prizes = data.prizes || {};
                this._state = "waiting";
                this._finalReveal = null;
                this._ceremonyCards = [];
                this._teaser = "";
                this._myNudge = "";
                this._answeredByUser = {};
                this._resetMarkingState();
                this.render({ force: true });
                break;

            case "round:start":
                this._roundInfo = data;
                this._state = "waiting";
                this._question = null;
                this._answeredQuestionIndex = null;
                this._roundAnswerMap.clear();
                this._askedQuestions = [];
                this._navigatedQuestionIndex = null;
                this._pendingChoice = null;
                this._clearLockWarning();
                this._myRoundCorrect = 0;
                this._myRoundTotal = 0;
                this._myNudge = "";
                this._answeredByUser = {};
                this._resetMarkingState();
                this.render();
                break;

            case "answer:pulse":
                this._answeredByUser = data.answeredByUser || {};
                if (this.element?.contains?.(document.activeElement) && document.activeElement?.tagName === "INPUT") {
                    break;
                }
                this.render();
                break;

            case "table:emote": {
                if (data.userId && data.userId === game.user?.id) break;
                const emote = QUIZ_EMOTES.find(e => e.id === data.emoteId);
                if (emote) {
                    this._handleEmote(emote, data.userName || "Player", data.color || "#ffdc82");
                }
                break;
            }

            case "question:show":
                this._question = data.question;
                this._navigatedQuestionIndex = null;
                this._pendingChoice = null;
                if (data.question && !this._askedQuestions.find(q => q.questionIndex === data.question.questionIndex)) {
                    this._askedQuestions.push(data.question);
                }
                this._state = this._answeredQuestionIndex === data.question?.questionIndex
                    ? "answered"
                    : "question";
                if (this._state === "question") this._myLastAnswer = null;
                this.render();
                break;

            case "question:skip":
                this._question = null;
                this._state = "waiting";
                this.render();
                break;

            case "lock:warning": {
                const secs = Number(data.seconds) || 10;
                const wasWarning = this._lockWarning;
                this._lockWarning = true;
                this._lockWarningRemaining = secs;
                this._startLockWarningCountdown(secs);
                if (!wasWarning) {
                    this.render();
                } else {
                    this._updateLockWarningDom();
                }
                break;
            }

            case "round:locked":
                this._state = "locked";
                this._clearLockWarning();
                this._resetMarkingState();
                this.render();
                break;

            case "marking:step": {
                this._state = "marking";
                this._clearLockWarning();
                this._currentMarkingStep = data.currentStep;
                this._revealLog = Array.isArray(data.revealLog) && data.revealLog.length
                    ? data.revealLog
                    : (data.currentStep ? [data.currentStep] : []);
                this._pastMarkingLog = this._revealLog
                    .filter(s => s.questionIndex !== data.currentStep?.questionIndex)
                    .reverse();
                const myId = game.user.id;
                let roundTotal = 0;
                let roundCorrect = 0;
                for (const step of this._revealLog) {
                    const mine = step.playerResults?.find(r => r.userId === myId);
                    if (mine) {
                        roundTotal++;
                        if (mine.correct) roundCorrect++;
                    }
                }
                this._myRoundTotal = roundTotal;
                this._myRoundCorrect = roundCorrect;
                if (data.currentStep?.playerResults) {
                    const mine = data.currentStep.playerResults.find(r => r.userId === myId);
                    if (mine) {
                        Hooks.callAll("ionrift.quizNight.answerResult", {
                            userId: myId,
                            correct: !!mine.correct,
                            points: mine.points || 0,
                            questionIndex: data.currentStep.questionIndex
                        });
                    }
                }
                this.render();
                break;
            }

            case "timer:tick": {
                const wasActive = (this._timer?.total || 0) > 0;
                this._timer = data;
                if (!wasActive && data.total > 0) this.render();
                else this._updateTimerBar();
                break;
            }

            case "timer:extend":
                this._timer = data;
                this.render();
                break;

            case "timer:pause":
                this._paused = data.paused;
                this.render();
                break;

            case "round:end":
                this._state = "round-end";
                if (data.roundInfo) {
                    this._roundInfo = data.roundInfo;
                } else if (data.roundNumber) {
                    this._roundInfo = { ...(this._roundInfo || {}), roundNumber: data.roundNumber };
                }
                if (data.nudges && game.user?.id && data.nudges[game.user.id] !== undefined) {
                    this._myNudge = data.nudges[game.user.id];
                }
                this.render();
                break;

            case "teaser":
                this._teaser = data.text;
                if (data.nudges && game.user?.id && data.nudges[game.user.id] !== undefined) {
                    this._myNudge = data.nudges[game.user.id];
                }
                this._state = "round-end";
                this.render();
                break;

            case "quiz:end":
                this._sessionLive = false;
                this._docked = false;
                hideQuizDock();
                this._finalReveal = data.reveal;
                this._ceremonyCards = [];
                this._state = "quiz-end";
                this.render();
                break;

            case "prize:reveal":
                this._sessionLive = false;
                this._docked = false;
                hideQuizDock();
                this._ceremonyCards = data.cards || [];
                this._state = "quiz-end";
                this.render();
                break;

            case "state:sync":
                this._applySync(data);
                break;
        }
    }

    _applySync(data) {
        const remote = planPlayerSync(data);
        if (remote.action === "end-local") {
            this._sessionLive = false;
            this._docked = false;
            hideQuizDock();
            this._state = "idle";
            this._quizName = "";
            this._question = null;
            this._roundInfo = null;
            this._finalReveal = null;
            this._ceremonyCards = [];
            this._answeredQuestionIndex = null;
            this._roundAnswerMap.clear();
            this._askedQuestions = [];
            this._navigatedQuestionIndex = null;
            this._pendingChoice = null;
            this._resetMarkingState();
            if (remote.notifyEnded) {
                ui.notifications.info("The quiz has been ended by the GM.");
            }
            return this.close();
        }

        if (remote.action === "show-conclusion") {
            this._sessionLive = false;
            this._docked = false;
            hideQuizDock();
        } else if (remote.sessionLive) {
            this._sessionLive = true;
        }

        this._quizName = data.quizName || this._quizName;
        this._prizes = data.prizes || this._prizes;
        this._roundInfo = data.roundInfo || this._roundInfo;
        this._paused = !!data.paused;
        this._timer = data.timer || this._timer;

        if (data.answeredByUser) {
            this._answeredByUser = data.answeredByUser;
            const mine = data.answeredByUser[game.user.id];
            if (Array.isArray(mine) && mine.length) {
                this._answeredQuestionIndex = mine[mine.length - 1];
            }
        }
        if (data.nudges && game.user?.id && data.nudges[game.user.id] !== undefined) {
            this._myNudge = data.nudges[game.user.id];
        }

        if (Array.isArray(data.askedQuestions) && data.askedQuestions.length) {
            this._askedQuestions = data.askedQuestions;
        }
        if (data.playerAnswersByUser && game.user?.id && data.playerAnswersByUser[game.user.id]) {
            for (const [qiStr, ans] of Object.entries(data.playerAnswersByUser[game.user.id])) {
                const qi = Number(qiStr);
                if (!this._roundAnswerMap.has(qi)) {
                    const asked = this._askedQuestions.find(q => q.questionIndex === qi);
                    this._roundAnswerMap.set(qi, { answer: ans, questionText: asked?.text || "" });
                }
            }
        }

        if (Array.isArray(data.revealLog) && data.revealLog.length) {
            this._revealLog = data.revealLog;
            const myId = game.user?.id;
            let roundTotal = 0;
            let roundCorrect = 0;
            for (const step of this._revealLog) {
                const mine = step.playerResults?.find(r => r.userId === myId);
                if (mine) {
                    roundTotal++;
                    if (mine.correct) roundCorrect++;
                }
            }
            this._myRoundTotal = roundTotal;
            this._myRoundCorrect = roundCorrect;
        }

        if (data.state === "question" && data.question) {
            this._question = data.question;
            this._state = this._answeredQuestionIndex === data.question.questionIndex
                ? "answered"
                : "question";
        } else if (data.state === "marking") {
            this._state = "marking";
            this._currentMarkingStep = data.currentMarkingStep;
            this._revealLog = Array.isArray(data.revealLog) && data.revealLog.length
                ? data.revealLog
                : (data.currentMarkingStep ? [data.currentMarkingStep] : []);
            this._pastMarkingLog = this._revealLog
                .filter(s => s.questionIndex !== data.currentMarkingStep?.questionIndex)
                .reverse();
        } else if (data.state === "round-end") {
            this._state = "round-end";
        } else if (data.state === "quiz-end") {
            this._finalReveal = data.finalReveal || data.reveal || this._finalReveal;
            if (Array.isArray(data.ceremonyCards) && Number.isFinite(data.ceremonyShown)) {
                this._ceremonyCards = data.ceremonyCards.slice(0, data.ceremonyShown);
            }
            this._state = "quiz-end";
        } else if (data.state === "round-intro" || data.state === "running") {
            this._state = "waiting";
        } else if (data.state === "locked" || data.roundInfo) {
            this._state = data.state === "marking" ? "marking" : "waiting";
        }

        this.render({ force: true });
    }

    _resetMarkingState() {
        this._currentMarkingStep = null;
        this._pastMarkingLog = [];
        this._revealLog = [];
    }

    _startLockWarningCountdown(seconds = 10) {
        if (this._lockWarningInterval) {
            clearInterval(this._lockWarningInterval);
            this._lockWarningInterval = null;
        }
        this._lockWarningRemaining = seconds;
        this._updateLockWarningDom();
        this._lockWarningInterval = setInterval(() => {
            this._lockWarningRemaining = Math.max(1, this._lockWarningRemaining - 1);
            this._updateLockWarningDom();
        }, 1000);
    }

    _updateLockWarningDom() {
        const secs = this._lockWarningRemaining || 10;
        const spans = this.element?.querySelectorAll?.(".lock-warning-seconds");
        if (spans?.length) {
            spans.forEach(el => {
                el.textContent = String(secs);
            });
            return;
        }
        this.element?.querySelectorAll?.(".lock-warning-banner")?.forEach(banner => {
            banner.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Pens Down in <span class="lock-warning-seconds">${secs}</span>s!`;
        });
    }

    _clearLockWarning() {
        if (this._lockWarningInterval) {
            clearInterval(this._lockWarningInterval);
            this._lockWarningInterval = null;
        }
        this._lockWarning = false;
        this._lockWarningRemaining = 0;
    }

    _buildQuestionStrip() {
        if (!this._askedQuestions.length && this._question?.questionIndex === undefined) return [];
        const currentQI = this._question?.questionIndex ?? -1;
        const activeViewedIndex = this._navigatedQuestionIndex !== null ? this._navigatedQuestionIndex : currentQI;
        const totalQ = this._question?.totalQuestions || this._roundInfo?.questionCount || 0;

        const strip = [];
        for (let i = 0; i < totalQ; i++) {
            const answered = this._roundAnswerMap.has(i);
            const isCurrent = i === currentQI;
            const isAsked = this._askedQuestions.some(q => q.questionIndex === i) || isCurrent;
            const isNavigated = this._navigatedQuestionIndex === i;

            let status = "upcoming";
            if (isCurrent) status = "current";
            else if (isAsked) status = answered ? "answered" : "asked";

            strip.push({
                index: i,
                number: i + 1,
                status,
                answered,
                isCurrent,
                isNavigated,
                canNavigate: isAsked && i !== activeViewedIndex
            });
        }
        return strip;
    }

    _buildAnswerSheet() {
        const totalQ = Math.max(
            this._roundInfo?.questionCount || 0,
            this._askedQuestions.length,
            (this._revealLog || []).length
        );
        if (!totalQ) return [];

        let shareAllAnswers = false;
        try {
            shareAllAnswers = Boolean(game.settings?.get?.(MODULE_ID, "sharePlayerAnswersOnReveal"));
        } catch {
            shareAllAnswers = false;
        }

        const myId = game.user?.id;
        const sheet = [];
        for (let i = 0; i < totalQ; i++) {
            const asked = this._askedQuestions.find(q => q.questionIndex === i) || null;
            const revealedStep = (this._revealLog || []).find(s => s.questionIndex === i)
                || (this._currentMarkingStep?.questionIndex === i ? this._currentMarkingStep : null);
            const entry = this._roundAnswerMap.get(i);
            const myResult = revealedStep?.playerResults?.find(r => r.userId === myId) || null;
            const roundType = asked?.roundType || revealedStep?.roundType || this._roundInfo?.roundType || this._roundInfo?.type;

            const formatAnswer = (raw) => {
                if (raw === null || raw === undefined || raw === "") return null;
                if (roundType === "multiple-choice" && typeof raw === "number" && Array.isArray(asked?.options)) {
                    return asked.options[raw] || String(raw);
                }
                if (roundType === "true-false" && typeof raw === "boolean") {
                    return raw ? "True" : "False";
                }
                return String(raw);
            };

            let displayAnswer = null;
            if (myResult) {
                displayAnswer = myResult.timedOut ? null : formatAnswer(myResult.answer);
            } else if (entry) {
                displayAnswer = formatAnswer(entry.answer);
            }

            const otherResults = (shareAllAnswers && revealedStep?.playerResults)
                ? revealedStep.playerResults
                    .filter(r => r.userId !== myId)
                    .map(r => ({
                        ...r,
                        answer: r.timedOut ? null : formatAnswer(r.answer)
                    }))
                : [];

            sheet.push({
                questionIndex: i,
                questionNumber: i + 1,
                questionText: asked?.text || revealedStep?.questionText || entry?.questionText || `Question ${i + 1}`,
                media: asked?.media || revealedStep?.media || "",
                answer: displayAnswer,
                revealed: Boolean(revealedStep),
                isCurrentReveal: Boolean(revealedStep && this._currentMarkingStep?.questionIndex === i),
                correctAnswer: revealedStep?.correctAnswer || "",
                correct: Boolean(myResult?.correct),
                points: myResult?.points || 0,
                fuzzy: Boolean(myResult?.fuzzy),
                timedOut: Boolean(myResult ? myResult.timedOut : !displayAnswer),
                appealed: Boolean(myResult?.appealed),
                canAppeal: Boolean(revealedStep && myResult && !myResult.correct && !myResult.timedOut && !myResult.appealed),
                otherResults
            });
        }
        return sheet;
    }

    _updateTimerBar() {
        const bar = this.element?.querySelector?.(".timer-bar-fill");
        if (bar) {
            const pct = this._timer.total > 0 ? (this._timer.remaining / this._timer.total) * 100 : 100;
            bar.style.width = `${pct}%`;
            if (pct > 50) bar.style.background = "var(--ionrift-success, #2ecc71)";
            else if (pct > 25) bar.style.background = "#f0a848";
            else bar.style.background = "#ef4444";

            if (pct <= 25 && pct > 0) bar.classList.add("low");
            else bar.classList.remove("low");
        }
        const label = this.element?.querySelector?.(".timer-label");
        if (label) {
            label.textContent = this._timer.remaining > 0 ? TimerEngine.formatClock(this._timer.remaining) : "";
        }
    }

    async close(options = {}) {
        const plan = planWindowClose({
            role: "player",
            state: this._closeState(),
            intent: options.abandon ? "abandon" : "window"
        });

        if (plan.action === "minimize") {
            this._docked = true;
            showQuizDock({
                label: "Quiz in progress",
                onResume: () => this.resumeFromDock()
            });
            return super.close(options);
        }

        hideQuizDock();
        this._clearLockWarning();
        this._docked = false;
        this._sessionLive = false;
        if (this._unregisterSocket) {
            this._unregisterSocket();
            this._unregisterSocket = null;
        }
        if (this._userConnectedHook && typeof Hooks !== "undefined" && Hooks.off) {
            Hooks.off("userConnected", this._userConnectedHook);
            this._userConnectedHook = null;
        }
        clearActivePlayerApp();
        return super.close(options);
    }
}
