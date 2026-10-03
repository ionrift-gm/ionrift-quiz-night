import { Logger } from "../lib/Logger.js";
import { MODULE_ID, QUESTION_WARN_COUNT, CLOSER_PRESETS } from "../data/constants.js";
import { QuizEngine } from "../services/QuizEngine.js";
import { ScoringEngine } from "../services/ScoringEngine.js";
import { TimerEngine } from "../services/TimerEngine.js";
import { SocketHandler } from "../services/sockets/SocketHandler.js";
import { PrizeDelivery } from "../services/PrizeDelivery.js";
import { SessionPersistence } from "../services/SessionPersistence.js";
import { planWindowClose, isQuizFormallyStarted } from "../services/SessionWindowPolicy.js";
import { showQuizDock, hideQuizDock } from "../ui/QuizDock.js";
import { clearActiveMasterApp } from "../composition/sessionState.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const ROUND_TYPE_ICONS = {
    "text-answer": "fa-keyboard",
    "multiple-choice": "fa-list-ol",
    "true-false": "fa-check-double",
    picture: "fa-image",
    "nearest-number": "fa-bullseye"
};

const ROUND_TYPE_LABELS = {
    "text-answer": "Text",
    "multiple-choice": "MC",
    "true-false": "T/F",
    picture: "Picture",
    "nearest-number": "Nearest"
};

export class QuizMasterApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "ionrift-quiz-master",
        classes: ["ionrift-window", "glass-ui", "ionrift-quiz-master"],
        window: {
            title: "Quiz Night: Quizmaster",
            resizable: true
        },
        position: { width: 520, height: 700 },
        actions: {
            "start-quiz": QuizMasterApp.#onStartQuiz,
            "next-round": QuizMasterApp.#onNextRound,
            "next-question": QuizMasterApp.#onNextQuestion,
            "lock-round": QuizMasterApp.#onLockRound,
            "mark-next": QuizMasterApp.#onMarkNext,
            "skip-question": QuizMasterApp.#onSkipQuestion,
            "toggle-pause": QuizMasterApp.#onTogglePause,
            "start-closer": QuizMasterApp.#onStartCloser,
            "end-quiz": QuizMasterApp.#onEndQuiz,
            "show-teaser": QuizMasterApp.#onShowTeaser,
            "adjudicate": QuizMasterApp.#onAdjudicate,
            "bulk-accept": QuizMasterApp.#onBulkAccept,
            "bulk-accept-appeals": QuizMasterApp.#onBulkAcceptAppeals,
            "peek-question": QuizMasterApp.#onPeekQuestion,
            "peek-round": QuizMasterApp.#onPeekRound,
            "timer-extend": QuizMasterApp.#onTimerExtend,
            "toggle-marking-overview": QuizMasterApp.#onToggleMarkingOverview,
            "reveal-next-prize": QuizMasterApp.#onRevealNextPrize,
            "abandon-quiz": QuizMasterApp.#onAbandonQuiz
        }
    };

    static PARTS = {
        body: { template: `modules/${MODULE_ID}/templates/quiz-master.hbs` }
    };

    _engine = new QuizEngine();
    _timer = new TimerEngine();
    _lastReveal = null;
    _unregisterSocket = null;
    _finalReveal = null;
    _showMarkingOverview = false;
    _peekedQuestionIndex = null;
    _peekedRoundIndex = null;
    _prizeDisplay = {};
    _ceremonyCards = [];
    _ceremonyShown = 0;
    _lockWarningActive = false;
    _lockWarningTimer = null;
    _docked = false;

    constructor(quizData, options = {}) {
        super(options);
        this._quizData = quizData;

        this._engine.onStateChange = () => {
            this._persistSession();
            this.render();
        };

        this._timer.onTick = (data) => {
            SocketHandler.broadcastTimer(data);
            if (data.remaining % 5 === 0 || data.expired) this.render();
        };
        this._timer.onExpire = () => {
            if (this._engine.state === "question") {
                Logger.log("Timer expired, locking round.");
                if (this._lockWarningTimer) {
                    clearTimeout(this._lockWarningTimer);
                    this._lockWarningTimer = null;
                }
                this._lockWarningActive = false;
                QuizMasterApp.#performLock.call(this);
            }
        };

        this._unregisterSocket = SocketHandler.register((data) => this._handleSocket(data));
    }

    static recover(snapshot) {
        if (!snapshot?.quizData) return null;
        const app = new QuizMasterApp(snapshot.quizData);
        app._engine.restore(snapshot);

        if (snapshot.state === "question" && snapshot.timerState?.remaining > 0) {
            app._timer.start(snapshot.timerState.remaining);
        }

        if (snapshot.state === "quiz-end" && snapshot.finalReveal) {
            app._finalReveal = snapshot.finalReveal;
            app._ceremonyCards = snapshot.ceremonyCards || [];
            app._ceremonyShown = snapshot.ceremonyShown || 0;
        }

        Logger.log("Recovered quiz session from persisted state.");
        return app;
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

    syncPlayers() {
        this._sendStateSync();
    }

    _onRender(context, options) {
        PrizeDelivery.bindPrizeInspect(this.element);
    }

    async _prepareContext(options) {
        if (!Object.keys(this._prizeDisplay || {}).length && this._quizData?.prizes) {
            this._prizeDisplay = await PrizeDelivery.toPlayerPrizeDisplay(this._quizData.prizes);
        }

        const engine = this._engine;
        const scores = ScoringEngine.calculateScores(engine.playerHistory);
        const isMarking = engine.state === "marking";

        let question = engine.currentQuestion;
        let optionsList = null;
        if (question?.options) {
            optionsList = question.options.map((opt, i) => ({
                text: opt,
                letter: ["A", "B", "C", "D"][i] || String(i + 1),
                isCorrect: i === question.correctIndex
            }));
        }

        const currentStep = engine.currentMarkingStep || null;
        const pastLog = (engine.pastRevealLog || []).map(step => ({
            ...step,
            canAdjudicate: ["text-answer", "picture"].includes(step.roundType),
            hasProbable: step.playerResults?.some(r => r.confidence === "probable" && !r.adjudicated),
            hasAppeals: step.playerResults?.some(r => r.appealed && !r.correct)
        }));
        const canAdjudicate = ["text-answer", "picture"].includes(currentStep?.roundType);
        const hasProbable = currentStep?.playerResults?.some(r => r.confidence === "probable" && !r.correct && !r.adjudicated);
        const hasAppeals = currentStep?.playerResults?.some(r => r.appealed && !r.correct);

        const questionStrip = this._buildQuestionStrip(engine);
        const nextQuestionPreview = this._getNextQuestionPreview(engine);
        const peekedQuestion = this._getPeekedQuestion(engine);
        const roundTimeline = this._buildRoundTimeline(engine);
        const peekedRound = this._getPeekedRound();
        const nextRoundPreview = this._getNextRoundPreview(engine);
        const showFullRoundMap = ["idle", "running", "round-intro", "round-end", "quiz-end"].includes(engine.state);

        let roundSummary = null;
        if (engine.state === "round-end" && engine.revealLog.length) {
            roundSummary = this._buildRoundSummary(engine, scores);
        }

        const roster = this._buildPlayerRoster(engine);

        let stateLabel;
        switch (engine.state) {
            case "question":
                stateLabel = `Q${engine.questionIndex + 1}/${engine.currentRound?.questions?.length || 0} \u00b7 ${engine.answeredCount}/${engine.activePlayerCount} answered`;
                break;
            case "marking":
                stateLabel = `Marking ${engine.markingIndex}/${engine.currentRound?.questions?.length || 0}`;
                break;
            case "round-end":
                stateLabel = `R${engine.roundIndex + 1}/${this._quizData?.rounds?.length || 0} complete`;
                break;
            case "round-intro":
                stateLabel = `R${engine.roundIndex + 1}/${this._quizData?.rounds?.length || 0}`;
                break;
            case "quiz-end":
                stateLabel = "Finished";
                break;
            default:
                stateLabel = "Ready";
        }

        let markingMatrix = null;
        let pendingAdjudications = [];
        let markingSummary = null;
        if (isMarking) {
            const cockpit = this._buildMarkingCockpit(engine, currentStep);
            markingMatrix = cockpit.matrix;
            pendingAdjudications = cockpit.adjudications;
            markingSummary = cockpit.summary;
        }

        return {
            state: engine.state,
            quizName: this._quizData?.name || "Quiz Night",
            round: engine.currentRound,
            roundIndex: engine.roundIndex,
            totalRounds: this._quizData?.rounds?.length || 0,
            question,
            optionsList,
            questionIndex: engine.questionIndex,
            totalQuestions: engine.currentRound?.questions?.length || 0,
            answeredCount: engine.answeredCount,
            activePlayerCount: engine.activePlayerCount,
            allAnswered: engine.allAnswered,
            playerRoster: roster,
            rosterCompact: roster.length > 4,
            allQuestionsAsked: engine.allQuestionsAsked,
            paused: engine.paused || this._timer.paused,
            timerRemaining: this._timer.remaining,
            timerTotal: this._timer.total,
            timerActive: this._timer.active,
            timerClock: TimerEngine.formatClock(this._timer.remaining),
            closerPresets: CLOSER_PRESETS,
            lockWarningActive: this._lockWarningActive,
            scores,
            isMarking,
            currentStep,
            pastLog,
            canAdjudicate,
            hasProbable,
            hasAppeals,
            markingIndex: engine.markingIndex,
            markingTotal: engine.currentRound?.questions?.length || 0,
            isLastRound: (engine.roundIndex + 1) >= (this._quizData?.rounds?.length || 0),
            finalReveal: this._finalReveal,
            questionStrip,
            stripDense: questionStrip.length > QUESTION_WARN_COUNT,
            nextQuestionPreview,
            peekedQuestion,
            roundTimeline,
            peekedRound,
            nextRoundPreview,
            showFullRoundMap,
            roundSummary,
            stateLabel,
            showMarkingOverview: this._showMarkingOverview,
            markingMatrix,
            pendingAdjudications,
            hasPendingAdjudications: pendingAdjudications.length > 0,
            markingSummary,
            prizeTiers: PrizeDelivery.toPrizeTierList(this._prizeDisplay),
            ceremonyCards: this._ceremonyCards.slice(0, this._ceremonyShown),
            ceremonyHasMore: this._ceremonyShown < this._ceremonyCards.length,
            ceremonyTotal: this._ceremonyCards.length,
            ceremonyShown: this._ceremonyShown,
            canAbandon: isQuizFormallyStarted(engine.state)
        };
    }

    async start() {
        this._engine.start(this._quizData);

        this._prizeDisplay = await PrizeDelivery.toPlayerPrizeDisplay(this._quizData.prizes);
        SocketHandler.broadcastQuizStart(this._quizData.name, this._prizeDisplay);

        this._chatAnnounce(
            PrizeDelivery.formatStartAnnouncement(this._quizData.name, this._prizeDisplay)
        );

        this.render();
    }

    static async #onStartQuiz(event, target) {
        await this.start();
    }

    static async #onAbandonQuiz() {
        await this.close({ abandon: true });
    }

    static async #onNextRound(event, target) {
        this._lastReveal = null;
        const isLastRound = (this._engine.roundIndex + 1) >= (this._quizData.rounds?.length || 0);

        if (isLastRound) {
            const confirmed = await Dialog.confirm({
                title: "Final Round Complete",
                content: "<p>All rounds are finished. Proceed to final results and prize delivery?</p>"
            });
            if (!confirmed) return;
            await QuizMasterApp.#onEndQuiz.call(this, event, target);
            return;
        }

        const round = this._engine.nextRound();
        if (!round) {
            await QuizMasterApp.#onEndQuiz.call(this, event, target);
            return;
        }

        SocketHandler.broadcastRoundStart({
            name: round.name,
            type: round.type,
            tag: round.tag,
            roundNumber: this._engine.roundIndex + 1,
            totalRounds: this._quizData.rounds.length,
            questionCount: round.questions.length
        });

        this._chatAnnounce(
            `<h4><i class="fas fa-layer-group"></i> Round ${this._engine.roundIndex + 1}: ${round.name}</h4>
            <p>${round.questions.length} questions | ${round.pointsPerQuestion} pts each</p>
            <p class="quiz-tag">${round.tag}</p>`
        );

        this.render();
    }

    static #onNextQuestion(event, target) {
        const question = this._engine.nextQuestion();
        if (!question) {
            this.render();
            return;
        }

        SocketHandler.broadcastQuestion(question);

        this.render();
    }

    static async #onLockRound(event, target) {
        if (!this._engine.allQuestionsAsked) {
            const total = this._engine.currentRound?.questions?.length || 0;
            const asked = this._engine.questionIndex + 1;
            const remaining = total - asked;
            const confirmed = await Dialog.confirm({
                title: "Pens Down",
                content: `<p>Lock answers now? ${remaining} question${remaining !== 1 ? "s have" : " has"} not been asked yet.</p>`
            });
            if (!confirmed) return;
        }

        const unanswered = this._engine.activePlayerCount - this._engine.answeredCount;
        if (!this._lockWarningActive && unanswered > 0) {
            this._lockWarningActive = true;
            SocketHandler.broadcastLockWarning(10);
            this.render();

            this._lockWarningTimer = setTimeout(() => {
                this._lockWarningTimer = null;
                this._lockWarningActive = false;
                QuizMasterApp.#performLock.call(this);
            }, 10000);
            return;
        }

        if (this._lockWarningTimer) {
            clearTimeout(this._lockWarningTimer);
            this._lockWarningTimer = null;
        }
        this._lockWarningActive = false;
        QuizMasterApp.#performLock.call(this);
    }

    static #performLock() {
        this._timer.stop();
        this._engine.lockRound();
        SocketHandler.broadcastLock();

        this._chatAnnounce(
            `<p><i class="fas fa-lock"></i> <strong>Pens Down.</strong> The answers are locked. Marking begins now.</p>`
        );

        this.render();
    }

    static #onMarkNext(event, target) {
        const step = this._engine.markNextQuestion();
        const engine = this._engine;

        if (!step) {
            SocketHandler.broadcastRoundEnd(engine.roundIndex + 1);
            this.render();
            return;
        }

        SocketHandler.broadcastMarkingStep(
            step,
            engine.revealLog,
            engine.markingIndex,
            engine.currentRound.questions.length
        );

        this.render();
    }

    static async #onSkipQuestion(event, target) {
        const confirmed = await Dialog.confirm({
            title: "Skip Question",
            content: "<p>Skip this question? It will not appear during marking.</p>"
        });
        if (!confirmed) return;

        const next = this._engine.skipQuestion();
        SocketHandler.broadcastSkip();
        if (next) {
            SocketHandler.broadcastQuestion(next);
        }
        this.render();
    }

    static #onStartCloser(event, target) {
        const seconds = Number(target.dataset.seconds) || 180;
        this._timer.start(seconds);
        SocketHandler.broadcastTimer({
            remaining: this._timer.remaining,
            total: this._timer.total,
            progress: this._timer.progress,
            expired: false
        });
        const minutes = Math.round(seconds / 60);
        const unit = minutes === 1 ? "minute" : "minutes";
        this._chatAnnounce(
            `<p><i class="fas fa-hourglass-half"></i> <strong>Last few minutes.</strong> ${minutes} ${unit} left on this round.</p>`
        );
        this.render();
    }

    static #onTogglePause(event, target) {
        if (!this._timer.active) return;
        this._engine.togglePause();
        this._timer.togglePause();
        SocketHandler.broadcastPause(this._engine.paused);
        this.render();
    }

    static #onTimerExtend(event, target) {
        if (!this._timer.active) return;
        this._timer.extend(60);
        SocketHandler.broadcastTimerExtend({
            remaining: this._timer.remaining,
            total: this._timer.total,
            progress: this._timer.progress,
            expired: false
        });
        this.render();
    }

    static #onShowTeaser(event, target) {
        const scores = ScoringEngine.calculateScores(this._engine.playerHistory);
        const teaser = ScoringEngine.generateTeaser(scores, this._engine.roundIndex + 1);

        SocketHandler.broadcastTeaser(teaser, this._engine.roundIndex + 1);

        this._chatAnnounce(
            `<p><i class="fas fa-eye-slash"></i> <em>${teaser}</em></p>`
        );

        this.render();
    }

    static async #onEndQuiz(event, target, options = {}) {
        const force = options?.force || options?._forceClose || target?.dataset?.force === "true";
        const confirmed = force || await Dialog.confirm({
            title: "End Quiz?",
            content: "<p>This will announce final results and deliver prizes to all players. This cannot be undone.</p>"
        });
        if (!confirmed) return;

        this._timer.stop();
        this._engine.endQuiz();

        const scores = ScoringEngine.calculateScores(this._engine.playerHistory);
        const reveal = ScoringEngine.generateFinalReveal(scores, this._quizData.prizes);
        this._finalReveal = reveal;
        this._ceremonyCards = await PrizeDelivery.enrichRevealCards(reveal);
        this._ceremonyShown = 0;

        this._persistSession();

        SocketHandler.broadcastQuizEnd(reveal, {
            ceremonyCards: this._ceremonyCards,
            ceremonyShown: 0
        });

        Hooks.callAll("ionrift.quizNight.quizEnd", {
            reveal,
            scores
        });

        const topDown = [...reveal].reverse();
        const outcomes = await PrizeDelivery.deliverAll(topDown);
        const prizeHtml = PrizeDelivery.formatChatSummary(outcomes);
        if (prizeHtml) this._chatAnnounce(prizeHtml);

        SessionPersistence.clear();
        this.render();
    }

    static #onRevealNextPrize() {
        if (this._ceremonyShown >= this._ceremonyCards.length) return;
        this._ceremonyShown += 1;
        const cards = this._ceremonyCards.slice(0, this._ceremonyShown);
        SocketHandler.broadcastPrizeReveal({
            cards,
            shown: this._ceremonyShown,
            total: this._ceremonyCards.length
        });
        this.render();
    }

    static #onAdjudicate(event, target) {
        const userId = target.dataset.userId;
        const questionIndex = Number(target.dataset.questionIndex);
        const markCorrect = target.dataset.correct === "true";

        this._engine.adjudicateAnswer(userId, questionIndex, markCorrect);
        this._rebroadcastMarking();
        this.render();
    }

    static #onBulkAccept(event, target) {
        const questionIndex = Number(target.dataset.questionIndex);
        const logEntry = this._engine.revealLog.find(e => e.questionIndex === questionIndex);
        if (!logEntry) return;
        for (const result of logEntry.playerResults) {
            if (result.timedOut) continue;
            if (result.confidence === "probable" && !result.correct) {
                this._engine.adjudicateAnswer(result.userId, questionIndex, true);
            }
        }
        this._rebroadcastMarking();
        this.render();
    }

    static #onBulkAcceptAppeals(event, target) {
        const questionIndex = Number(target.dataset.questionIndex);
        this._engine.adjudicateAllForQuestion(questionIndex, true, true);
        this._rebroadcastMarking();
        this.render();
    }

    static #onPeekQuestion(event, target) {
        const idx = Number(target.dataset.questionIndex);
        if (!Number.isFinite(idx)) return;
        this._peekedQuestionIndex = this._peekedQuestionIndex === idx ? null : idx;
        this.render();
    }

    static #onPeekRound(event, target) {
        const idx = Number(target.dataset.roundIndex);
        if (!Number.isFinite(idx)) return;
        this._peekedRoundIndex = this._peekedRoundIndex === idx ? null : idx;
        this.render();
    }

    static #onToggleMarkingOverview(event, target) {
        this._showMarkingOverview = !this._showMarkingOverview;
        this.render();
    }

    _buildMarkingCockpit(engine, currentStep) {
        const allQuestions = engine.currentRound?.questions || [];
        const revealedMap = new Map();
        for (const entry of (engine.revealLog || [])) {
            revealedMap.set(entry.questionIndex, entry);
        }
        if (currentStep && !revealedMap.has(currentStep.questionIndex)) {
            revealedMap.set(currentStep.questionIndex, currentStep);
        }

        const playerOrder = [];
        const playerSeen = new Set();
        for (const entry of revealedMap.values()) {
            for (const r of (entry.playerResults || [])) {
                if (!playerSeen.has(r.userId)) {
                    playerSeen.add(r.userId);
                    playerOrder.push({ userId: r.userId, name: r.name });
                }
            }
        }

        const playerTotals = new Map();
        for (const p of playerOrder) {
            playerTotals.set(p.userId, { roundScore: 0, roundCorrect: 0 });
        }

        const matrixQuestions = allQuestions.map((q, i) => {
            const entry = revealedMap.get(i);
            const revealed = !!entry;
            let correctPct = 0;
            const playerResults = [];

            if (revealed && entry.playerResults) {
                const total = entry.playerResults.length;
                const correctCount = entry.playerResults.filter(r => r.correct).length;
                correctPct = total > 0 ? Math.round((correctCount / total) * 100) : 0;

                const resultMap = new Map();
                for (const r of entry.playerResults) {
                    resultMap.set(r.userId, r);
                    if (r.correct) {
                        const t = playerTotals.get(r.userId);
                        if (t) {
                            t.roundCorrect++;
                            t.roundScore += r.points || 0;
                        }
                    }
                }

                for (const p of playerOrder) {
                    const r = resultMap.get(p.userId);
                    if (!r) playerResults.push({ state: "pending" });
                    else if (r.correct) playerResults.push({ state: "correct" });
                    else if (r.timedOut) playerResults.push({ state: "timeout" });
                    else if (r.confidence === "probable") playerResults.push({ state: "probable" });
                    else playerResults.push({ state: "incorrect" });
                }
            }

            return { index: i, number: i + 1, text: q.text || "", correctPct, revealed, playerResults };
        });

        const matrixPlayers = playerOrder.map(p => {
            const t = playerTotals.get(p.userId) || { roundScore: 0, roundCorrect: 0 };
            const shortName = p.name.length > 6 ? p.name.slice(0, 5) + "." : p.name;
            return { userId: p.userId, name: p.name, shortName, roundScore: t.roundScore, roundCorrect: t.roundCorrect };
        });

        const matrix = {
            questions: matrixQuestions,
            players: matrixPlayers,
            hasData: matrixQuestions.some(q => q.revealed)
        };

        const adjudications = [];
        for (const entry of revealedMap.values()) {
            for (const result of (entry.playerResults || [])) {
                if (result.appealed && !result.correct) {
                    adjudications.push({
                        questionIndex: entry.questionIndex,
                        questionNumber: entry.questionNumber,
                        userId: result.userId,
                        name: result.name,
                        answer: result.timedOut ? "No answer" : result.answer,
                        type: "appeal"
                    });
                } else if (result.confidence === "probable" && !result.adjudicated && !result.correct) {
                    adjudications.push({
                        questionIndex: entry.questionIndex,
                        questionNumber: entry.questionNumber,
                        userId: result.userId,
                        name: result.name,
                        answer: result.timedOut ? "No answer" : result.answer,
                        type: "probable"
                    });
                }
            }
        }

        let summary = null;
        if (currentStep?.playerResults) {
            const results = currentStep.playerResults;
            summary = {
                correctCount: results.filter(r => r.correct).length,
                probableCount: results.filter(r => r.confidence === "probable" && !r.correct).length,
                timedOutCount: results.filter(r => r.timedOut).length,
                totalCount: results.length
            };
        }

        return { matrix, adjudications, summary };
    }

    _buildQuestionStrip(engine) {
        const round = engine.currentRound;
        if (!round || engine.state === "idle" || engine.state === "quiz-end") return [];

        const totalPlayers = engine.activePlayerCount;
        return round.questions.map((q, i) => {
            const isAsked = i <= engine.questionIndex;
            const isCurrent = i === engine.questionIndex;

            let status = "upcoming";
            if (isCurrent) status = "current";
            else if (isAsked) status = "asked";

            const answers = engine.roundAnswers.get(i);
            const answerCount = answers?.size || 0;

            return {
                index: i,
                number: i + 1,
                status,
                answerCount,
                totalPlayers,
                text: q.text || "",
                isPeeked: this._peekedQuestionIndex === i
            };
        });
    }

    _getNextQuestionPreview(engine) {
        const round = engine.currentRound;
        if (!round) return null;
        const nextIdx = engine.questionIndex + 1;
        if (nextIdx >= round.questions.length) return null;
        const text = round.questions[nextIdx].text || "";
        return text.length > 80 ? text.slice(0, 80) + "..." : text;
    }

    _getPeekedQuestion(engine) {
        if (this._peekedQuestionIndex === null) return null;
        const round = engine.currentRound;
        if (!round) return null;
        const q = round.questions[this._peekedQuestionIndex];
        if (!q) return null;
        const answers = engine.roundAnswers.get(this._peekedQuestionIndex);
        const answerCount = answers?.size || 0;
        return {
            index: this._peekedQuestionIndex,
            number: this._peekedQuestionIndex + 1,
            text: q.text,
            answerCount,
            totalPlayers: engine.activePlayerCount
        };
    }

    _buildRoundTimeline(engine) {
        const rounds = this._quizData?.rounds || [];
        if (!rounds.length) return [];

        const current = engine.roundIndex;
        const state = engine.state;

        return rounds.map((r, i) => {
            let status = "upcoming";
            if (state === "quiz-end" || (current >= 0 && i < current) || (state === "round-end" && i === current)) {
                status = "done";
            } else if (state === "round-end" && i === current + 1) {
                status = "next";
            } else if (current === i && state !== "idle" && state !== "running") {
                status = "current";
            } else if ((state === "idle" || state === "running") && i === 0) {
                status = "next";
            }

            return {
                index: i,
                number: i + 1,
                name: r.name || `Round ${i + 1}`,
                type: r.type || "text-answer",
                typeIcon: ROUND_TYPE_ICONS[r.type] || "fa-question",
                typeLabel: ROUND_TYPE_LABELS[r.type] || r.type,
                questionCount: r.questions?.length || 0,
                status,
                isPeeked: this._peekedRoundIndex === i
            };
        });
    }

    _getPeekedRound() {
        if (this._peekedRoundIndex === null) return null;
        const rounds = this._quizData?.rounds || [];
        const round = rounds[this._peekedRoundIndex];
        if (!round) return null;

        return {
            index: this._peekedRoundIndex,
            number: this._peekedRoundIndex + 1,
            name: round.name || `Round ${this._peekedRoundIndex + 1}`,
            typeLabel: ROUND_TYPE_LABELS[round.type] || round.type,
            questions: (round.questions || []).map((q, i) => ({
                number: i + 1,
                text: q.text || "",
                answer: this._formatQuestionAnswer(q, round.type)
            }))
        };
    }

    _getNextRoundPreview(engine) {
        const rounds = this._quizData?.rounds || [];
        if (!rounds.length || engine.state === "quiz-end") return null;

        const nextIdx = (engine.state === "idle" || engine.state === "running")
            ? 0
            : engine.roundIndex + 1;
        if (nextIdx < 0 || nextIdx >= rounds.length) return null;

        const round = rounds[nextIdx];
        const name = round.name || `Round ${nextIdx + 1}`;
        const count = round.questions?.length || 0;
        const type = ROUND_TYPE_LABELS[round.type] || "";
        return `${name} (${count} questions${type ? `, ${type}` : ""})`;
    }

    _formatQuestionAnswer(question, roundType) {
        if (!question) return "";
        if (roundType === "multiple-choice") {
            const idx = question.correctIndex;
            const opt = question.options?.[idx];
            if (opt == null) return "";
            const letter = ["A", "B", "C", "D"][idx] || String(idx + 1);
            return `${letter}. ${opt}`;
        }
        if (roundType === "true-false") {
            if (question.answer === true || question.answer === "true") return "True";
            if (question.answer === false || question.answer === "false") return "False";
        }
        return question.answer != null ? String(question.answer) : "";
    }

    _rebroadcastMarking() {
        const engine = this._engine;
        SocketHandler.broadcastMarkingStep(
            engine.currentMarkingStep,
            engine.revealLog,
            engine.markingIndex,
            engine.currentRound?.questions?.length || 0
        );
    }

    _handleSocket(data) {
        switch (data.type) {
            case "answer:submit":
                if (!game.user.isGM) return;
                this._engine.submitAnswer(
                    data.userId,
                    data.answer,
                    data.questionIndex,
                    data.timestamp,
                    {}
                );
                this.render();
                break;

            case "answer:appeal":
                if (!game.user.isGM) return;
                this._engine.flagAppeal(data.userId, data.questionIndex);
                this._rebroadcastMarking();
                this.render();
                break;

            case "state:request":
                if (!game.user.isGM) return;
                this._sendStateSync();
                break;
        }
    }

    _sendStateSync() {
        const payload = this._engine.getSyncSnapshot(
            this._quizData?.name || "Quiz Night",
            this._prizeDisplay,
            {
                remaining: this._timer.remaining,
                total: this._timer.total,
                progress: this._timer.total > 0 ? this._timer.remaining / this._timer.total : 1,
                expired: false
            }
        );
        if (this._engine.state === "quiz-end" && this._finalReveal) {
            payload.active = false;
            payload.finalReveal = this._finalReveal;
            payload.ceremonyCards = this._ceremonyCards;
            payload.ceremonyShown = this._ceremonyShown;
        }
        SocketHandler.broadcastStateSync(payload);
    }

    _chatAnnounce(content) {
        ChatMessage.create({
            content: `<div class="ionrift-quiz-chat">${content}</div>`,
            speaker: { alias: "Quiz Night" }
        });
    }

    _persistSession() {
        const extra = {};
        if (this._finalReveal) extra.finalReveal = this._finalReveal;
        extra.ceremonyCards = this._ceremonyCards;
        extra.ceremonyShown = this._ceremonyShown;
        SessionPersistence.save(this._engine, this._quizData, {
            remaining: this._timer.remaining,
            total: this._timer.total
        }, extra);
    }

    _buildPlayerRoster(engine) {
        const players = game.users.filter(u => !u.isGM && u.active);
        const currentAnswers = engine.roundAnswers.get(engine.questionIndex);
        return players.map(u => ({
            name: u.name,
            initial: u.name.charAt(0).toUpperCase(),
            color: u.color || "#ffffff",
            answered: currentAnswers?.has(u.id) && currentAnswers.get(u.id).answer !== null
        }));
    }

    _buildRoundSummary(engine, cumulativeScores) {
        const log = engine.revealLog;
        const totalQuestions = log.length;
        const playerMap = new Map();

        for (const step of log) {
            for (const r of step.playerResults) {
                if (!playerMap.has(r.userId)) {
                    playerMap.set(r.userId, { name: r.name, color: r.color, roundScore: 0, roundCorrect: 0 });
                }
                const entry = playerMap.get(r.userId);
                entry.roundScore += r.points;
                if (r.correct) entry.roundCorrect++;
            }
        }

        const playerScores = [];
        for (const [userId, data] of playerMap) {
            const cumulative = cumulativeScores.find(s => s.userId === userId);
            playerScores.push({
                name: data.name,
                color: data.color,
                roundScore: data.roundScore,
                roundCorrect: data.roundCorrect,
                cumulativeScore: cumulative?.score ?? data.roundScore
            });
        }
        playerScores.sort((a, b) => b.roundScore - a.roundScore);

        let hardest = null;
        let easiest = null;
        for (let i = 0; i < log.length; i++) {
            const step = log[i];
            const total = step.playerResults.filter(r => !r.timedOut).length || 1;
            const correct = step.playerResults.filter(r => r.correct).length;
            const pct = Math.round((correct / total) * 100);
            const entry = { number: step.questionNumber, text: step.questionText, correctPct: pct };
            if (!hardest || pct < hardest.correctPct) hardest = entry;
            if (!easiest || pct > easiest.correctPct) easiest = entry;
        }

        return { totalQuestions, playerScores, hardestQuestion: hardest, easiestQuestion: easiest };
    }

    _stopLiveQuiz() {
        this._timer.stop();
        if (this._lockWarningTimer) {
            clearTimeout(this._lockWarningTimer);
            this._lockWarningTimer = null;
        }
        this._lockWarningActive = false;
    }

    async close(options = {}) {
        const forced = options.force || options._forceClose;
        const intent = (options.abandon || forced) ? "abandon" : "window";
        const plan = planWindowClose({
            role: "gm",
            state: this._engine?.state,
            intent
        });

        if (plan.action === "minimize") {
            this._docked = true;
            showQuizDock({
                label: "Quiz in progress",
                onResume: () => this.resumeFromDock()
            });
            return super.close(options);
        }

        if (plan.action === "end-for-all") {
            const confirmed = forced || await Dialog.confirm({
                title: "Abandon quiz?",
                content: "<p>End this quiz for everyone? This sitting stops, and prizes are not awarded.</p>"
            });
            if (!confirmed) return;
            this._stopLiveQuiz();
        }

        if (plan.broadcast) {
            SocketHandler.broadcastStateSync(plan.broadcast);
        }

        hideQuizDock();
        this._docked = false;
        if (plan.clearSession) await SessionPersistence.clear();
        if (this._unregisterSocket) {
            this._unregisterSocket();
            this._unregisterSocket = null;
        }
        clearActiveMasterApp();
        return super.close(options);
    }
}
