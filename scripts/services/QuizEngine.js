import { Logger } from "../lib/Logger.js";
import { FUZZY_TOLERANCE } from "../data/constants.js";
import { QuizSchema } from "../data/QuizSchema.js";

export class QuizEngine {

    state = "idle";
    quiz = null;
    roundIndex = -1;
    questionIndex = -1;

    // Map<questionIndex, Map<userId, {answer, timestamp}>>
    roundAnswers = new Map();
    askedQuestions = [];
    revealLog = [];
    markingIndex = -1;

    // Map<userId, scoredEntry[]> across the full quiz
    playerHistory = new Map();
    paused = false;
    onStateChange = null;

    start(quizData) {
        this.quiz = quizData;
        this.roundIndex = -1;
        this.questionIndex = -1;
        this.roundAnswers.clear();
        this.askedQuestions = [];
        this.revealLog = [];
        this.markingIndex = -1;
        this.paused = false;
        this.state = "running";
        Logger.log("Quiz started:", quizData.name);
        this._emit("state");
    }

    nextRound() {
        this.roundIndex++;
        this.questionIndex = -1;
        this.roundAnswers.clear();
        this.askedQuestions = [];
        this.revealLog = [];
        this.markingIndex = -1;

        if (this.roundIndex >= this.quiz.rounds.length) {
            this.state = "quiz-end";
            Logger.log("All rounds complete.");
            this._emit("state");
            return null;
        }

        this.state = "round-intro";
        Logger.log(`Starting round ${this.roundIndex + 1}: ${this.currentRound.name}`);
        this._emit("state");
        Hooks.callAll("ionrift.quizNight.roundStart", {
            roundIndex: this.roundIndex,
            roundNumber: this.roundIndex + 1,
            roundName: this.currentRound.name,
            roundType: this.currentRound.type,
            roundTag: this.currentRound.tag,
            questionCount: this.currentRound.questions?.length || 0
        });
        return this.currentRound;
    }

    nextQuestion() {
        const round = this.currentRound;
        if (!round) return null;

        const nextIndex = this.questionIndex + 1;

        if (nextIndex >= round.questions.length) {
            return null;
        }

        this.questionIndex = nextIndex;
        this.paused = false;
        this.state = "question";

        const safeQ = this.getPlayerQuestion();
        this.askedQuestions.push(safeQ);

        Logger.log(`Question ${this.questionIndex + 1}/${round.questions.length}`);
        this._emit("state");
        return safeQ;
    }

    getPlayerQuestion() {
        const q = this.currentQuestion;
        if (!q) return null;
        const round = this.currentRound;

        const safe = {
            id: q.id,
            text: q.text,
            hint: q.hint,
            media: q.media,
            roundType: round.type,
            roundName: round.name,
            roundTag: round.tag,
            questionNumber: this.questionIndex + 1,
            totalQuestions: round.questions.length,
            roundNumber: this.roundIndex + 1,
            totalRounds: this.quiz.rounds.length,
            timeLimit: round.timeLimit,
            pointsPerQuestion: round.pointsPerQuestion,
            questionIndex: this.questionIndex
        };

        if (round.type === "multiple-choice") {
            safe.options = q.options;
        }

        return safe;
    }

    // Mutable until lockRound() is called.
    submitAnswer(userId, answer, questionIndex = this.questionIndex, timestamp = Date.now(), extra = {}) {
        if (this.state !== "question") return false;
        if (questionIndex < 0 || questionIndex > this.questionIndex) return false;

        if (!this.roundAnswers.has(questionIndex)) {
            this.roundAnswers.set(questionIndex, new Map());
        }
        const entry = { answer, timestamp, ...extra };
        this.roundAnswers.get(questionIndex).set(userId, entry);

        Logger.log(`Answer from ${userId} for Q${questionIndex + 1}:`, answer);
        this._emit("answer", { userId, questionIndex });
        return true;
    }

    lockRound() {
        if (this.state !== "question") return;

        // Backfill null entries for players who didn't answer
        const allPlayers = game.users.filter(u => !u.isGM && u.active);
        for (let qi = 0; qi <= this.questionIndex; qi++) {
            if (!this.roundAnswers.has(qi)) this.roundAnswers.set(qi, new Map());
            const qAnswers = this.roundAnswers.get(qi);
            for (const user of allPlayers) {
                if (!qAnswers.has(user.id)) {
                    qAnswers.set(user.id, { answer: null, timestamp: null, timedOut: true });
                }
            }
        }

        this.state = "marking";
        this.markingIndex = 0;
        this.revealLog = [];
        Logger.log("Round locked. Beginning marking phase.");
        this._emit("state");
        Hooks.callAll("ionrift.quizNight.roundLocked", {
            roundIndex: this.roundIndex,
            roundNumber: this.roundIndex + 1
        });
    }

    markNextQuestion() {
        if (this.state !== "marking") return null;
        const round = this.currentRound;
        if (!round) return null;

        if (this.markingIndex >= round.questions.length) {
            this.state = "round-end";
            Logger.log(`Marking complete for round ${this.roundIndex + 1}.`);
            this._emit("state");
            return null;
        }

        const qi = this.markingIndex;
        const q = round.questions[qi];
        const qAnswers = this.roundAnswers.get(qi) || new Map();
        const tolerance = FUZZY_TOLERANCE;

        const playerResults = [];
        for (const [userId, submission] of qAnswers) {
            const user = game.users.get(userId);
            if (!user) continue;

            let correct = false;
            let fuzzy = false;
            let confidence = "unlikely";
            let distance = Infinity;
            if (!submission.timedOut && submission.answer !== null) {
                const check = this._checkAnswer(submission.answer, q, round.type, tolerance);
                correct = check.correct;
                fuzzy = check.fuzzy;
                confidence = check.confidence || (correct ? (fuzzy ? "probable" : "definite") : "unlikely");
                distance = check.distance ?? Infinity;
            }

            let points = 0;
            if (round.type === "nearest-number") {
                // Assigned after all distances known
            } else if (correct) {
                points = round.pointsPerQuestion;
            }

            playerResults.push({
                userId,
                name: user.name,
                color: user.color,
                answer: submission.answer,
                timedOut: submission.timedOut || false,
                correct,
                fuzzy,
                confidence,
                distance,
                points,
                adjudicated: false,
                appealed: false
            });
        }

        if (round.type === "nearest-number") {
            this._scoreNearestNumber(playerResults, q, round);
        }

        for (const result of playerResults) {
            const history = this.playerHistory.get(result.userId) || [];
            history.push({
                roundIndex: this.roundIndex,
                questionIndex: qi,
                correct: result.correct,
                points: result.points
            });
            this.playerHistory.set(result.userId, history);
        }

        const step = {
            questionIndex: qi,
            questionNumber: qi + 1,
            questionText: q.text,
            correctAnswer: this._getDisplayAnswer(q, round.type),
            playerResults,
            roundType: round.type
        };

        this.revealLog.push(step);
        this.markingIndex++;

        Logger.log(`Marked Q${qi + 1}: ${step.correctAnswer}`);
        this._emit("state");
        return step;
    }

    adjudicateAnswer(userId, questionIndex, markCorrect) {
        const logEntry = this.revealLog.find(e => e.questionIndex === questionIndex);
        if (!logEntry) return;

        const round = this.currentRound;
        const result = logEntry.playerResults.find(r => r.userId === userId);
        let points = 0;
        if (markCorrect) {
            points = round.pointsPerQuestion;
        }

        if (result) {
            result.correct = markCorrect;
            result.points = points;
            result.adjudicated = true;
            result.confidence = markCorrect ? "definite" : "unlikely";
        }

        const history = this.playerHistory?.get(userId);
        if (history) {
            const entry = history.find(h => h.roundIndex === this.roundIndex && h.questionIndex === questionIndex);
            if (entry) {
                entry.correct = markCorrect;
                entry.points = points;
                entry.adjudicated = true;
            }
        }

        Logger.log(`Adjudicated Q${questionIndex + 1} for ${userId}: ${markCorrect ? "correct" : "incorrect"}`);
        Hooks.callAll("ionrift.quizNight.answerAdjudicated", {
            userId,
            questionIndex,
            markCorrect,
            points
        });
    }

    adjudicateAllForQuestion(questionIndex, markCorrect, onlyAppealed = false) {
        const logEntry = this.revealLog.find(e => e.questionIndex === questionIndex);
        if (!logEntry) return 0;
        let count = 0;
        for (const result of logEntry.playerResults) {
            if (result.timedOut) continue;
            if (onlyAppealed && !result.appealed) continue;
            if (result.correct === markCorrect && result.adjudicated) continue;
            this.adjudicateAnswer(result.userId, questionIndex, markCorrect);
            count++;
        }
        return count;
    }

    flagAppeal(userId, questionIndex) {
        const logEntry = this.revealLog.find(e => e.questionIndex === questionIndex);
        if (!logEntry) return false;
        const result = logEntry.playerResults.find(r => r.userId === userId);
        if (!result || result.correct) return false;
        result.appealed = true;
        Logger.log(`Appeal flagged Q${questionIndex + 1} by ${userId}`);
        return true;
    }

    skipQuestion() {
        if (this.state !== "question") return null;
        Logger.log(`Question ${this.questionIndex + 1} skipped.`);
        if (this.askedQuestions.length && this.askedQuestions[this.askedQuestions.length - 1]?.questionIndex === this.questionIndex) {
            this.askedQuestions.pop();
        }
        this._emit("skip");
        return this.nextQuestion();
    }

    getSyncSnapshot(quizName, prizes, timerState = {}) {
        const answeredByUser = {};
        for (const [qi, answers] of this.roundAnswers) {
            for (const [uid, entry] of answers) {
                if (entry.answer !== null && entry.answer !== undefined && !entry.timedOut) {
                    if (!answeredByUser[uid]) answeredByUser[uid] = [];
                    answeredByUser[uid].push(qi);
                }
            }
        }

        return {
            active: this.state !== "idle" && this.state !== "quiz-end",
            state: this.state,
            quizName,
            prizes,
            roundIndex: this.roundIndex,
            questionIndex: this.questionIndex,
            paused: this.paused,
            roundInfo: this.currentRound ? {
                roundName: this.currentRound.name,
                roundType: this.currentRound.type,
                roundTag: this.currentRound.tag,
                roundNumber: this.roundIndex + 1,
                totalRounds: this.quiz?.rounds?.length || 0,
                questionCount: this.currentRound.questions?.length || 0
            } : null,
            question: (this.state === "question") ? this.getPlayerQuestion() : null,
            currentMarkingStep: this.currentMarkingStep,
            revealLog: this.revealLog,
            markingIndex: this.markingIndex,
            timer: timerState,
            answeredByUser,
            askedQuestions: this.askedQuestions
        };
    }

    togglePause() {
        this.paused = !this.paused;
        Logger.log(this.paused ? "Quiz paused." : "Quiz resumed.");
        this._emit("pause", { paused: this.paused });
    }

    endQuiz() {
        this.state = "quiz-end";
        Logger.log("Quiz ended.");
        this._emit("state");
    }

    serialize() {
        const roundAnswersObj = {};
        for (const [qi, answers] of this.roundAnswers) {
            const qObj = {};
            for (const [uid, entry] of answers) {
                qObj[uid] = entry;
            }
            roundAnswersObj[qi] = qObj;
        }

        const historyObj = {};
        for (const [uid, entries] of this.playerHistory) {
            historyObj[uid] = entries;
        }

        return {
            state: this.state,
            quiz: this.quiz,
            roundIndex: this.roundIndex,
            questionIndex: this.questionIndex,
            markingIndex: this.markingIndex,
            paused: this.paused,
            roundAnswers: roundAnswersObj,
            askedQuestions: this.askedQuestions,
            revealLog: this.revealLog,
            playerHistory: historyObj
        };
    }

    restore(snapshot) {
        if (!snapshot) return;
        this.state = snapshot.state ?? "idle";
        this.quiz = snapshot.quiz ?? null;
        this.roundIndex = snapshot.roundIndex ?? -1;
        this.questionIndex = snapshot.questionIndex ?? -1;
        this.markingIndex = snapshot.markingIndex ?? -1;
        this.paused = snapshot.paused ?? false;
        this.askedQuestions = snapshot.askedQuestions ?? [];
        this.revealLog = snapshot.revealLog ?? [];

        this.roundAnswers = new Map();
        if (snapshot.roundAnswers) {
            for (const [qi, answers] of Object.entries(snapshot.roundAnswers)) {
                const qMap = new Map();
                for (const [uid, entry] of Object.entries(answers)) {
                    qMap.set(uid, entry);
                }
                this.roundAnswers.set(Number(qi), qMap);
            }
        }

        this.playerHistory = new Map();
        if (snapshot.playerHistory) {
            for (const [uid, entries] of Object.entries(snapshot.playerHistory)) {
                this.playerHistory.set(uid, entries);
            }
        }
    }

    get currentRound() {
        if (!this.quiz || this.roundIndex < 0 || this.roundIndex >= this.quiz.rounds.length) return null;
        return this.quiz.rounds[this.roundIndex];
    }

    get currentQuestion() {
        const round = this.currentRound;
        if (!round || this.questionIndex < 0 || this.questionIndex >= round.questions.length) return null;
        return round.questions[this.questionIndex];
    }

    get answeredCount() {
        return this.roundAnswers.get(this.questionIndex)?.size || 0;
    }

    get activePlayerCount() {
        return game.users.filter(u => !u.isGM && u.active).length;
    }

    get allAnswered() {
        return this.answeredCount >= this.activePlayerCount;
    }

    get allQuestionsAsked() {
        const round = this.currentRound;
        if (!round) return false;
        return this.questionIndex >= round.questions.length - 1;
    }

    get currentMarkingStep() {
        if (!this.revealLog.length) return null;
        return this.revealLog[this.revealLog.length - 1];
    }

    get pastRevealLog() {
        if (this.revealLog.length <= 1) return [];
        return [...this.revealLog].reverse().slice(1);
    }

    _checkAnswer(answer, question, roundType, tolerance = FUZZY_TOLERANCE) {
        if (answer === null || answer === undefined) {
            return { correct: false, fuzzy: false, confidence: "unlikely", distance: Infinity };
        }

        switch (roundType) {
            case "text-answer":
            case "picture": {
                const result = QuizSchema.checkTextAnswer(
                    answer,
                    question.answer,
                    question.acceptedAnswers || [],
                    tolerance
                );
                // Definite auto-scores. Probable is flagged for GM review (not auto-correct).
                return {
                    correct: result.confidence === "definite",
                    fuzzy: result.confidence === "probable",
                    confidence: result.confidence,
                    distance: result.distance
                };
            }
            case "multiple-choice":
                return {
                    correct: answer === question.correctIndex,
                    fuzzy: false,
                    confidence: answer === question.correctIndex ? "definite" : "unlikely",
                    distance: 0
                };
            case "true-false":
                return {
                    correct: answer === question.answer,
                    fuzzy: false,
                    confidence: answer === question.answer ? "definite" : "unlikely",
                    distance: 0
                };
            case "nearest-number": {
                const num = Number(answer);
                const target = Number(question.answer);
                if (!Number.isFinite(num) || !Number.isFinite(target)) {
                    return { correct: false, fuzzy: false, confidence: "unlikely", distance: Infinity };
                }
                return {
                    correct: false,
                    fuzzy: false,
                    confidence: "unlikely",
                    distance: Math.abs(num - target)
                };
            }
            default:
                return { correct: false, fuzzy: false, confidence: "unlikely", distance: Infinity };
        }
    }

    _scoreNearestNumber(playerResults, question, round) {
        const target = Number(question.answer);
        const scored = playerResults.filter(r => !r.timedOut && Number.isFinite(Number(r.answer)));
        if (!scored.length || !Number.isFinite(target)) return;

        let best = Infinity;
        for (const r of scored) {
            r.distance = Math.abs(Number(r.answer) - target);
            if (r.distance < best) best = r.distance;
        }
        for (const r of scored) {
            if (r.distance === best) {
                r.correct = true;
                r.confidence = r.distance === 0 ? "definite" : "probable";
                r.fuzzy = r.distance !== 0;
                r.points = round.pointsPerQuestion;
            }
        }
    }

    _getDisplayAnswer(question, roundType) {
        switch (roundType) {
            case "text-answer":
            case "picture":
                return question.answer;
            case "nearest-number":
                return String(question.answer);
            case "multiple-choice":
                return question.options[question.correctIndex];
            case "true-false":
                return question.answer ? "True" : "False";
            default:
                return "Unknown";
        }
    }

    _emit(type, extra = {}) {
        if (this.onStateChange) {
            this.onStateChange(type, { state: this.state, ...extra });
        }
    }
}
