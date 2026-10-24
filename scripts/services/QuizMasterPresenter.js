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

export class QuizMasterPresenter {

    static buildStateLabel(engine, quizData) {
        switch (engine.state) {
            case "question":
                return `Q${engine.questionIndex + 1}/${engine.currentRound?.questions?.length || 0} \u00b7 ${engine.answeredCount}/${engine.activePlayerCount} answered`;
            case "marking":
                return `Marking ${engine.markingIndex}/${engine.currentRound?.questions?.length || 0}`;
            case "round-end":
                return `R${engine.roundIndex + 1}/${quizData?.rounds?.length || 0} complete`;
            case "round-intro":
                return `R${engine.roundIndex + 1}/${quizData?.rounds?.length || 0}`;
            case "quiz-end":
                return "Finished";
            default:
                return "Ready";
        }
    }

    static buildMarkingOverview(engine, currentStep) {
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

    static buildQuestionStrip(engine, peekedQuestionIndex = null) {
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
                isPeeked: peekedQuestionIndex === i
            };
        });
    }

    static getNextQuestionPreview(engine) {
        const round = engine.currentRound;
        if (!round) return null;
        const nextIdx = engine.questionIndex + 1;
        if (nextIdx >= round.questions.length) return null;
        const text = round.questions[nextIdx].text || "";
        return text.length > 80 ? text.slice(0, 80) + "..." : text;
    }

    static getPeekedQuestion(engine, peekedQuestionIndex) {
        if (peekedQuestionIndex === null) return null;
        const round = engine.currentRound;
        if (!round) return null;
        const q = round.questions[peekedQuestionIndex];
        if (!q) return null;
        const answers = engine.roundAnswers.get(peekedQuestionIndex);
        const answerCount = answers?.size || 0;
        return {
            index: peekedQuestionIndex,
            number: peekedQuestionIndex + 1,
            text: q.text,
            answerCount,
            totalPlayers: engine.activePlayerCount
        };
    }

    static buildRoundTimeline(engine, quizData, peekedRoundIndex = null) {
        const rounds = quizData?.rounds || [];
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
                isPeeked: peekedRoundIndex === i
            };
        });
    }

    static getPeekedRound(quizData, peekedRoundIndex) {
        if (peekedRoundIndex === null) return null;
        const rounds = quizData?.rounds || [];
        const round = rounds[peekedRoundIndex];
        if (!round) return null;

        return {
            index: peekedRoundIndex,
            number: peekedRoundIndex + 1,
            name: round.name || `Round ${peekedRoundIndex + 1}`,
            typeLabel: ROUND_TYPE_LABELS[round.type] || round.type,
            questions: (round.questions || []).map((q, i) => ({
                number: i + 1,
                text: q.text || q.question || q.prompt || "",
                answer: this.formatQuestionAnswer(q, round.type)
            }))
        };
    }

    static getNextRoundPreview(engine, quizData) {
        const rounds = quizData?.rounds || [];
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

    static formatQuestionAnswer(question, roundType) {
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

    static buildAnsweredByUserMap(engine) {
        const map = {};
        for (const [qi, answers] of engine.roundAnswers) {
            for (const [uid, entry] of answers) {
                if (entry.answer !== null && entry.answer !== undefined && !entry.timedOut) {
                    if (!map[uid]) map[uid] = [];
                    map[uid].push(qi);
                }
            }
        }
        return map;
    }

    static buildPlayerRoster(engine) {
        const players = (game.users || []).filter(u => !u.isGM && u.active);
        const askedCount = engine.state === "question" ? Math.max(0, engine.questionIndex + 1) : 0;
        const currentAnswers = engine.roundAnswers.get(engine.questionIndex);
        return players.map(u => {
            let answeredInRound = 0;
            for (let qi = 0; qi < askedCount; qi++) {
                const ans = engine.roundAnswers.get(qi);
                if (ans?.has(u.id) && ans.get(u.id).answer !== null) answeredInRound++;
            }
            const hasCurrent = Boolean(currentAnswers?.has(u.id) && currentAnswers.get(u.id).answer !== null);
            const allAskedAnswered = askedCount > 0 && answeredInRound >= askedCount;
            return {
                userId: u.id,
                name: u.name,
                initial: u.name.charAt(0).toUpperCase(),
                color: u.color || "#ffffff",
                answered: allAskedAnswered || (askedCount <= 1 && hasCurrent),
                answeredInRound,
                askedCount,
                progressLabel: (askedCount > 1 && answeredInRound > 0 && !allAskedAnswered)
                    ? `${answeredInRound}/${askedCount}`
                    : ""
            };
        });
    }

    static buildRoundSummary(engine, cumulativeScores) {
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
            const entry = {
                number: step.questionNumber,
                text: step.questionText,
                correctAnswer: step.correctAnswer,
                correctPct: pct
            };
            if (!hardest || pct < hardest.correctPct) hardest = entry;
            if (!easiest || pct > easiest.correctPct) easiest = entry;
        }

        return { totalQuestions, playerScores, hardestQuestion: hardest, easiestQuestion: easiest };
    }
}
