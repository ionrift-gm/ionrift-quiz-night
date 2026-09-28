import { Logger } from "../lib/Logger.js";
import { MODULE_ID } from "../data/constants.js";
import { SocketHandler } from "../services/sockets/SocketHandler.js";
import { PrizeDelivery } from "../services/PrizeDelivery.js";
import { TimerEngine } from "../services/TimerEngine.js";
import { clearActivePlayerApp } from "../composition/sessionState.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class QuizPlayerApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "ionrift-quiz-player",
        classes: ["ionrift-window", "glass-ui", "ionrift-quiz-player"],
        window: {
            title: "Quiz Night",
            resizable: true
        },
        position: { width: 440, height: 640 },
        actions: {
            "submit-text": QuizPlayerApp.#onSubmitText,
            "select-choice": QuizPlayerApp.#onSelectChoice,
            "confirm-choice": QuizPlayerApp.#onConfirmChoice,
            "select-tf": QuizPlayerApp.#onSelectTF,
            "confirm-tf": QuizPlayerApp.#onConfirmTF,
            "submit-number": QuizPlayerApp.#onSubmitNumber,
            "appeal": QuizPlayerApp.#onAppeal,
            "navigate-question": QuizPlayerApp.#onNavigateQuestion
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
    _unregisterSocket = null;
    _myLastAnswer = null;
    _lockWarning = false;
    _myRoundCorrect = 0;
    _myRoundTotal = 0;

    /** Answer sheet: stores questionIndex -> { answer, questionText } for the current round */
    _roundAnswerMap = new Map();
    /** All question objects shown this round (from question:show broadcasts) */
    _askedQuestions = [];
    /** When navigating to a past question, holds that question's index; null = live */
    _navigatedQuestionIndex = null;
    /** Pending MC/TF selection before confirm */
    _pendingChoice = null;

    constructor(options = {}) {
        super(options);
        this._unregisterSocket = SocketHandler.register((data) => this._handleSocket(data));
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

        const myMarkingTally = { correct: 0, total: 0, points: 0 };
        const myId = game.user.id;
        for (const step of this._pastMarkingLog) {
            const mine = step.playerResults?.find(r => r.userId === myId);
            if (mine) {
                myMarkingTally.total++;
                if (mine.correct) {
                    myMarkingTally.correct++;
                    myMarkingTally.points += mine.points || 0;
                }
            }
        }
        if (this._currentMarkingStep) {
            const mine = this._currentMarkingStep.playerResults?.find(r => r.userId === myId);
            if (mine) {
                myMarkingTally.total++;
                if (mine.correct) {
                    myMarkingTally.correct++;
                    myMarkingTally.points += mine.points || 0;
                }
            }
        }

        return {
            state: this._state,
            quizName: this._quizName,
            prizes: this._prizes,
            prizeTiers: PrizeDelivery.toPrizeTierList(this._prizes),
            ceremonyCards: this._ceremonyCards,
            roundInfo: this._roundInfo,
            question: displayQuestion,
            answeredThisQuestion: this._answeredQuestionIndex === this._question?.questionIndex,
            timer: this._timer,
            timerActive: (this._timer?.total || 0) > 0 && (this._timer?.remaining || 0) > 0,
            timerClock: TimerEngine.formatClock(this._timer?.remaining),
            paused: this._paused,
            teaser: this._teaser,
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
            myRoundSummary: (this._state === "round-end" && this._myRoundTotal > 0)
                ? { correct: this._myRoundCorrect, total: this._myRoundTotal, message: `You answered ${this._myRoundCorrect} of ${this._myRoundTotal} correctly this round.` }
                : null,
            pendingChoice: this._pendingChoice,
            hasPendingChoice: this._pendingChoice !== null,
            answerSheet,
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
        if (this._currentMarkingStep) {
            const mine = this._currentMarkingStep.playerResults?.find(r => r.userId === game.user.id);
            if (mine) mine.appealed = true;
        }
        this.render();
    }

    static #onNavigateQuestion(event, target) {
        const idx = Number(target.dataset.questionIndex);
        if (!Number.isFinite(idx)) return;

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
        }

        this._navigatedQuestionIndex = null;
        this._state = "answered";
        this.render();
    }

    _handleSocket(data) {
        switch (data.type) {
            case "quiz:start":
                this._quizName = data.quizName;
                this._prizes = data.prizes || {};
                this._state = "waiting";
                this._finalReveal = null;
                this._ceremonyCards = [];
                this._teaser = "";
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
                this._lockWarning = false;
                this._myRoundCorrect = 0;
                this._myRoundTotal = 0;
                this._resetMarkingState();
                this.render();
                break;

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

            case "lock:warning":
                this._lockWarning = true;
                this.render();
                break;

            case "round:locked":
                this._state = "locked";
                this._lockWarning = false;
                this._resetMarkingState();
                this.render();
                break;

            case "marking:step": {
                this._state = "marking";
                this._currentMarkingStep = data.currentStep;
                this._pastMarkingLog = (data.revealLog || [])
                    .filter(s => s.questionIndex !== data.currentStep?.questionIndex)
                    .reverse();
                const myId = game.user.id;
                if (data.currentStep?.playerResults) {
                    const mine = data.currentStep.playerResults.find(r => r.userId === myId);
                    if (mine) {
                        this._myRoundTotal++;
                        if (mine.correct) this._myRoundCorrect++;
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
                this.render();
                break;

            case "teaser":
                this._teaser = data.text;
                this._state = "round-end";
                this.render();
                break;

            case "quiz:end":
                this._finalReveal = data.reveal;
                this._ceremonyCards = [];
                this._state = "quiz-end";
                this.render();
                break;

            case "prize:reveal":
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
        if ((!data.active && data.state !== "quiz-end") || data.aborted) {
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
            if (data.aborted) {
                ui.notifications.info("The quiz has been ended by the GM.");
            }
            this.render({ force: true });
            return;
        }

        this._quizName = data.quizName || this._quizName;
        this._prizes = data.prizes || this._prizes;
        this._roundInfo = data.roundInfo || this._roundInfo;
        this._paused = !!data.paused;
        this._timer = data.timer || this._timer;

        if (data.answeredByUser) {
            const mine = data.answeredByUser[game.user.id];
            if (Array.isArray(mine) && mine.length) {
                this._answeredQuestionIndex = mine[mine.length - 1];
            }
        }

        if (Array.isArray(data.askedQuestions) && data.askedQuestions.length) {
            this._askedQuestions = data.askedQuestions;
        }

        if (data.state === "question" && data.question) {
            this._question = data.question;
            this._state = this._answeredQuestionIndex === data.question.questionIndex
                ? "answered"
                : "question";
        } else if (data.state === "marking") {
            this._state = "marking";
            this._currentMarkingStep = data.currentMarkingStep;
            this._pastMarkingLog = (data.revealLog || [])
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
    }

    _buildQuestionStrip() {
        if (!this._askedQuestions.length && this._question?.questionIndex === undefined) return [];
        const currentQI = this._question?.questionIndex ?? -1;
        const totalQ = this._question?.totalQuestions || this._roundInfo?.questionCount || 0;

        const strip = [];
        for (let i = 0; i < totalQ; i++) {
            const answered = this._roundAnswerMap.has(i);
            const isCurrent = i === currentQI;
            const isAsked = this._askedQuestions.some(q => q.questionIndex === i);
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
                canNavigate: isAsked && !isCurrent
            });
        }
        return strip;
    }

    _buildAnswerSheet() {
        const totalQ = this._roundInfo?.questionCount || 0;
        if (!totalQ) return [];
        const sheet = [];
        for (let i = 0; i < totalQ; i++) {
            const entry = this._roundAnswerMap.get(i);
            let displayAnswer = null;
            if (entry) {
                const raw = entry.answer;
                const asked = this._askedQuestions.find(q => q.questionIndex === i);
                if (asked?.roundType === "multiple-choice" && typeof raw === "number" && asked.options) {
                    displayAnswer = asked.options[raw] || String(raw);
                } else if (asked?.roundType === "true-false") {
                    displayAnswer = raw ? "True" : "False";
                } else {
                    displayAnswer = String(raw);
                }
            }
            sheet.push({ questionNumber: i + 1, answer: displayAnswer });
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
        if (this._unregisterSocket) {
            this._unregisterSocket();
            this._unregisterSocket = null;
        }
        clearActivePlayerApp();
        return super.close(options);
    }
}
