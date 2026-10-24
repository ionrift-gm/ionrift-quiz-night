import { Logger } from "../lib/Logger.js";
import { MODULE_ID, QUESTION_WARN_COUNT, CLOSER_PRESETS, QUIZ_EMOTES } from "../data/constants.js";
import { QuizEngine } from "../services/QuizEngine.js";
import { ScoringEngine } from "../services/ScoringEngine.js";
import { TimerEngine } from "../services/TimerEngine.js";
import { SocketHandler } from "../services/sockets/SocketHandler.js";
import { PrizeDelivery } from "../services/PrizeDelivery.js";
import { PrizeCeremony } from "../services/PrizeCeremony.js";
import { SessionPersistence } from "../services/SessionPersistence.js";
import { QuizMasterPresenter } from "../services/QuizMasterPresenter.js";
import { planWindowClose, isQuizFormallyStarted } from "../services/SessionWindowPolicy.js";
import { showQuizDock, hideQuizDock } from "../ui/QuizDock.js";
import { confirmQuizModal, isQuizModalOpen } from "../ui/confirmQuizModal.js";
import { renderEmoteWisp } from "../ui/emoteWisp.js";
import { clearActiveMasterApp } from "../composition/sessionState.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class QuizMasterApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "ionrift-quiz-master",
        classes: ["ionrift-window", "glass-ui", "ionrift-quiz-master"],
        window: {
            title: "Quiz Night: Quizmaster",
            resizable: true
        },
        position: { width: 780, height: 670 },
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
            "abandon-quiz": QuizMasterApp.#onAbandonQuiz,
            "send-emote": QuizMasterApp.#onSendEmote
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
    _ceremony = new PrizeCeremony();
    _revealing = false;
    _lockWarningActive = false;
    _lockWarningRemaining = 0;
    _lockWarningTimer = null;
    _lockWarningInterval = null;
    _docked = false;
    _lastEmoteLine = "";
    _lastTeaser = "";
    _userConnectedHook = null;

    /** Views kept for callers (and screenshot tooling) that predate PrizeCeremony. */
    get _ceremonyCards() {
        return this._ceremony.cards;
    }

    set _ceremonyCards(cards) {
        this._ceremony = new PrizeCeremony({
            ...this._ceremony.serialize(),
            cards: Array.isArray(cards) ? cards : []
        });
    }

    get _ceremonyShown() {
        return this._ceremony.shown;
    }

    set _ceremonyShown(n) {
        this._ceremony = new PrizeCeremony({ ...this._ceremony.serialize(), shown: n });
    }

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
                this._clearLockWarning();
                QuizMasterApp.#performLock.call(this);
            }
        };

        this._unregisterSocket = SocketHandler.register((data) => this._handleSocket(data));
        if (typeof Hooks !== "undefined" && Hooks.on) {
            this._userConnectedHook = Hooks.on("userConnected", () => {
                if (this.rendered) this.render();
            });
        }
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
            app._ceremony = PrizeCeremony.fromSnapshot(snapshot);
            if (!app._ceremony.hasMore && !app._ceremony.summaryPosted) {
                app._finishCeremony().catch(err => Logger.warn("Ceremony finish failed:", err?.message));
            }
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

        const questionStrip = QuizMasterPresenter.buildQuestionStrip(engine, this._peekedQuestionIndex);
        const nextQuestionPreview = QuizMasterPresenter.getNextQuestionPreview(engine);
        const peekedQuestion = QuizMasterPresenter.getPeekedQuestion(engine, this._peekedQuestionIndex);
        const roundTimeline = QuizMasterPresenter.buildRoundTimeline(engine, this._quizData, this._peekedRoundIndex);
        const peekedRound = QuizMasterPresenter.getPeekedRound(this._quizData, this._peekedRoundIndex);
        const nextRoundPreview = QuizMasterPresenter.getNextRoundPreview(engine, this._quizData);
        const showFullRoundMap = ["idle", "running", "round-intro", "round-end", "quiz-end"].includes(engine.state);

        let roundSummary = null;
        if (engine.state === "round-end" && engine.revealLog.length) {
            roundSummary = QuizMasterPresenter.buildRoundSummary(engine, scores);
        }

        const roster = QuizMasterPresenter.buildPlayerRoster(engine);
        const stateLabel = QuizMasterPresenter.buildStateLabel(engine, this._quizData);

        let markingMatrix = null;
        let pendingAdjudications = [];
        let markingSummary = null;
        if (isMarking) {
            const overview = QuizMasterPresenter.buildMarkingOverview(engine, currentStep);
            markingMatrix = overview.matrix;
            pendingAdjudications = overview.adjudications;
            markingSummary = overview.summary;
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
            lockWarningRemaining: this._lockWarningRemaining || 10,
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
            ceremonyCards: [...this._ceremony.visibleCards].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999)),
            ceremonyHasMore: this._ceremony.hasMore,
            ceremonyTotal: this._ceremony.total,
            ceremonyShown: this._ceremony.shown,
            ceremonyBusy: this._revealing,
            canAbandon: isQuizFormallyStarted(engine.state),
            showLobbyRoster: ["idle", "running", "round-intro"].includes(engine.state),
            showScoreboard: scores.length >= 1 && !["quiz-end"].includes(engine.state),
            canShowTeaser: scores.length >= 2 && !["idle", "quiz-end"].includes(engine.state),
            emotes: QUIZ_EMOTES,
            lastEmoteLine: this._lastEmoteLine,
            lastTeaser: this._lastTeaser
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
        if (this._abandonInFlight || isQuizModalOpen()) return;
        this._abandonInFlight = true;
        try {
            await this.close({ abandon: true });
        } finally {
            this._abandonInFlight = false;
        }
    }

    static #onSendEmote(event, target) {
        const emoteId = target.dataset.emoteId;
        const emote = QUIZ_EMOTES.find(e => e.id === emoteId);
        if (!emote) return;
        const userName = game.user?.name || "Quizmaster";
        const color = game.user?.color || "#ffdc82";
        if (!this._handleEmote(emote, userName, color)) return;
        SocketHandler.sendEmote(emote.id, userName, color);
    }

    _handleEmote(emote, userName, color = "#ffdc82") {
        const line = renderEmoteWisp(this.element, emote, userName, color);
        if (line) this._lastEmoteLine = line;
        return Boolean(line);
    }

    static async #onNextRound(event, target) {
        this._lastReveal = null;
        const isLastRound = (this._engine.roundIndex + 1) >= (this._quizData.rounds?.length || 0);

        if (isLastRound) {
            const confirmed = await confirmQuizModal({
                title: "Final Round Complete",
                message: "All rounds are finished. Proceed to final results and the prize reveal?",
                confirmLabel: "Reveal Results",
                cancelLabel: "Stay Here",
                confirmIcon: "fa-trophy"
            });
            if (!confirmed) return;
            await QuizMasterApp.#onEndQuiz.call(this, event, target, { force: true });
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
            questionCount: round.questions.length,
            roundsMeta: (this._quizData.rounds || []).map((r, i) => ({
                number: i + 1,
                name: r.name,
                tag: r.tag
            }))
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
            const confirmed = await confirmQuizModal({
                title: "Pens Down?",
                message: `Lock answers now? ${remaining} question${remaining !== 1 ? "s have" : " has"} not been asked yet.`,
                confirmLabel: "Lock Round",
                cancelLabel: "Keep Asking",
                confirmIcon: "fa-lock"
            });
            if (!confirmed) return;
        }

        const unanswered = this._engine.activePlayerCount - this._engine.answeredCount;
        if (!this._lockWarningActive && unanswered > 0) {
            this._lockWarningActive = true;
            this._lockWarningRemaining = 10;
            SocketHandler.broadcastLockWarning(10);
            this.render();
            this._startLockWarningCountdown(10);

            this._lockWarningTimer = setTimeout(() => {
                this._clearLockWarning();
                QuizMasterApp.#performLock.call(this);
            }, 10000);
            return;
        }

        this._clearLockWarning();
        QuizMasterApp.#performLock.call(this);
    }

    _startLockWarningCountdown(seconds = 10) {
        if (this._lockWarningInterval) {
            clearInterval(this._lockWarningInterval);
            this._lockWarningInterval = null;
        }
        this._lockWarningRemaining = seconds;
        this._lockWarningInterval = setInterval(() => {
            this._lockWarningRemaining = Math.max(1, this._lockWarningRemaining - 1);
            this.element?.querySelectorAll?.(".lock-warning-seconds")?.forEach(el => {
                el.textContent = String(this._lockWarningRemaining);
            });
            SocketHandler.broadcastLockWarning(this._lockWarningRemaining);
        }, 1000);
    }

    _clearLockWarning() {
        if (this._lockWarningTimer) {
            clearTimeout(this._lockWarningTimer);
            this._lockWarningTimer = null;
        }
        if (this._lockWarningInterval) {
            clearInterval(this._lockWarningInterval);
            this._lockWarningInterval = null;
        }
        this._lockWarningActive = false;
        this._lockWarningRemaining = 0;
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
            const scores = ScoringEngine.calculateScores(engine.playerHistory);
            const nudges = ScoringEngine.generateAllPlayerNudges(
                scores,
                engine.currentRound?.pointsPerQuestion || 10
            );
            const roundInfo = engine.currentRound ? {
                roundName: engine.currentRound.name,
                roundType: engine.currentRound.type,
                roundTag: engine.currentRound.tag,
                roundNumber: engine.roundIndex + 1,
                totalRounds: this._quizData?.rounds?.length || 0,
                questionCount: engine.currentRound.questions?.length || 0,
                roundsMeta: (this._quizData?.rounds || []).map((r, i) => ({
                    number: i + 1,
                    name: r.name,
                    tag: r.tag
                }))
            } : null;
            SocketHandler.broadcastRoundEnd(engine.roundIndex + 1, { nudges, roundInfo });
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
        const confirmed = await confirmQuizModal({
            title: "Skip Question?",
            message: "Skip this question? It will not appear during marking.",
            confirmLabel: "Skip Question",
            cancelLabel: "Cancel",
            confirmIcon: "fa-forward"
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
        const roundSummary = this._engine.revealLog.length
            ? QuizMasterPresenter.buildRoundSummary(this._engine, scores)
            : null;
        const teaser = ScoringEngine.generateTeaser(scores, this._engine.roundIndex + 1, roundSummary);
        const nudges = ScoringEngine.generateAllPlayerNudges(
            scores,
            this._engine.currentRound?.pointsPerQuestion || 10
        );
        this._lastTeaser = teaser;

        SocketHandler.broadcastTeaser(teaser, this._engine.roundIndex + 1, { nudges });

        this._chatAnnounce(
            `<p><i class="fas fa-eye-slash"></i> <em>${teaser}</em></p>`
        );

        this.render();
    }

    static async #onEndQuiz(event, target, options = {}) {
        const force = options?.force || options?._forceClose || target?.dataset?.force === "true";
        const confirmed = force || await confirmQuizModal({
            title: "End Quiz?",
            message: "This will announce final results. Prizes are handed out as you reveal each placing. This cannot be undone.",
            confirmLabel: "End Quiz",
            cancelLabel: "Continue Quiz",
            confirmIcon: "fa-stop"
        });
        if (!confirmed) return;

        this._timer.stop();
        this._engine.endQuiz();

        const scores = ScoringEngine.calculateScores(this._engine.playerHistory);
        const reveal = ScoringEngine.generateFinalReveal(scores, this._quizData.prizes);
        this._finalReveal = reveal;
        this._ceremony = new PrizeCeremony({
            reveal,
            cards: await PrizeDelivery.enrichRevealCards(reveal)
        });

        if (!this._ceremony.hasMore) {
            this._ceremony.summaryPosted = true;
        }
        await this._persistSession();

        SocketHandler.broadcastQuizEnd(reveal, {
            ceremonyCards: [],
            ceremonyShown: 0,
            ceremonyTotal: this._ceremony.total,
            ceremonyLive: !this._ceremony.isComplete
        });

        Hooks.callAll("ionrift.quizNight.quizEnd", {
            reveal,
            scores
        });

        if (this._ceremony.isComplete) await SessionPersistence.clear();
        this.render();
    }

    static async #onRevealNextPrize() {
        if (this._revealing) return;
        const step = this._ceremony.revealNext();
        if (!step) return;
        this._revealing = true;
        try {
            // The claim must land before any character is touched, so a refresh
            // mid-delivery can never hand the same prize out twice.
            await this._persistSession();

            SocketHandler.broadcastPrizeReveal({
                cards: this._ceremony.visibleCards,
                shown: this._ceremony.shown,
                total: this._ceremony.total
            });
            this.render();

            if (step.entry?.prize) {
                const outcome = await PrizeDelivery.deliver(step.entry);
                this._ceremony.recordOutcome(step.index, outcome);
                await this._persistSession();
            }

            if (!this._ceremony.hasMore) await this._finishCeremony();
        } finally {
            this._revealing = false;
            this.render();
        }
    }

    /** Post the delivery summary once every placing is out, then close the books. */
    async _finishCeremony() {
        if (this._ceremony.summaryPosted) return;
        const prizeHtml = PrizeDelivery.formatChatSummary(this._ceremony.summaryOutcomes());
        if (prizeHtml) this._chatAnnounce(prizeHtml);
        this._ceremony.summaryPosted = true;
        await SessionPersistence.clear();
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
        const raw = target.dataset.questionIndex;
        if (raw === undefined || raw === "") {
            this._peekedQuestionIndex = null;
            this.render();
            return;
        }
        const idx = Number(raw);
        if (!Number.isFinite(idx)) return;
        this._peekedQuestionIndex = this._peekedQuestionIndex === idx ? null : idx;
        this.render();
    }

    static #onPeekRound(event, target) {
        const raw = target.dataset.roundIndex;
        if (raw === undefined || raw === "") {
            this._peekedRoundIndex = null;
            this.render();
            return;
        }
        const idx = Number(raw);
        if (!Number.isFinite(idx)) return;
        this._peekedRoundIndex = this._peekedRoundIndex === idx ? null : idx;
        this.render();
    }

    static #onToggleMarkingOverview(event, target) {
        this._showMarkingOverview = !this._showMarkingOverview;
        this.render();
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
                if (data.senderId && data.userId && data.senderId !== data.userId) return;
                this._engine.submitAnswer(
                    data.senderId || data.userId,
                    data.answer,
                    data.questionIndex,
                    data.timestamp,
                    {}
                );
                SocketHandler.broadcastAnswerPulse(QuizMasterPresenter.buildAnsweredByUserMap(this._engine));
                this.render();
                break;

            case "answer:appeal":
                if (!game.user.isGM) return;
                if (data.senderId && data.userId && data.senderId !== data.userId) return;
                this._engine.flagAppeal(data.senderId || data.userId, data.questionIndex);
                this._rebroadcastMarking();
                this.render();
                break;

            case "state:request":
                if (!game.user.isGM) return;
                this._sendStateSync();
                this.render();
                break;

            case "table:emote": {
                if (data.userId && data.userId === game.user?.id) break;
                const emote = QUIZ_EMOTES.find(e => e.id === data.emoteId);
                if (emote) {
                    const chipCount = this.element?.querySelectorAll?.(".roster-chip")?.length ?? 0;
                    if (chipCount !== this._engine.activePlayerCount) {
                        this.render();
                    }
                    this._handleEmote(emote, data.userName || "Player", data.color || "#ffdc82");
                }
                break;
            }
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
        if (this._engine.state === "round-end") {
            const scores = ScoringEngine.calculateScores(this._engine.playerHistory);
            payload.nudges = ScoringEngine.generateAllPlayerNudges(
                scores,
                this._engine.currentRound?.pointsPerQuestion || 10
            );
        }
        if (this._engine.state === "quiz-end" && this._finalReveal) {
            payload.active = false;
            payload.finalReveal = this._finalReveal;
            payload.ceremonyCards = this._ceremony.visibleCards;
            payload.ceremonyShown = this._ceremony.shown;
            payload.ceremonyTotal = this._ceremony.total;
            payload.ceremonyLive = !this._ceremony.isComplete;
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
        if (this._finalReveal) {
            extra.finalReveal = this._finalReveal;
            extra.ceremony = this._ceremony.serialize();
        }
        return SessionPersistence.save(this._engine, this._quizData, {
            remaining: this._timer.remaining,
            total: this._timer.total
        }, extra);
    }

    _stopLiveQuiz() {
        this._timer.stop();
        this._clearLockWarning();
    }

    async close(options = {}) {
        const forced = options.force || options._forceClose;
        const intent = (options.abandon || forced) ? "abandon" : "window";
        const plan = planWindowClose({
            role: "gm",
            state: this._engine?.state,
            intent,
            ceremonyPending: !!this._finalReveal && !this._ceremony.isComplete
        });

        if (plan.action === "minimize") {
            this._docked = true;
            showQuizDock({
                label: this._engine?.state === "quiz-end" ? "Prize reveal in progress" : "Quiz in progress",
                onResume: () => this.resumeFromDock()
            });
            return super.close(options);
        }

        if (plan.action === "end-for-all") {
            if (!forced && isQuizModalOpen()) return;
            const confirmed = forced || await confirmQuizModal({
                title: "Abandon Quiz?",
                message: "This will cancel the quiz for all players. Prizes will not be awarded.",
                confirmLabel: "Abandon",
                cancelLabel: "Continue Quiz",
                confirmIcon: "fa-ban"
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
        if (this._userConnectedHook && typeof Hooks !== "undefined" && Hooks.off) {
            Hooks.off("userConnected", this._userConnectedHook);
            this._userConnectedHook = null;
        }
        clearActiveMasterApp();
        return super.close(options);
    }
}
