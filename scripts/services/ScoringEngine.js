import { Logger } from "../lib/Logger.js";

export class ScoringEngine {

    static calculateScores(playerHistory) {
        const scores = [];

        for (const [userId, history] of playerHistory) {
            const user = game.users.get(userId);
            if (!user) continue;

            const score = history.reduce((sum, h) => sum + h.points, 0);
            const correct = history.filter(h => h.correct).length;

            scores.push({
                userId,
                name: user.name,
                color: user.color,
                score,
                correct,
                total: history.length
            });
        }

        scores.sort((a, b) => b.score - a.score || b.correct - a.correct);

        let rank = 1;
        for (let i = 0; i < scores.length; i++) {
            if (i > 0 && scores[i].score < scores[i - 1].score) {
                rank = i + 1;
            }
            scores[i].rank = rank;
        }

        return scores;
    }

    static generateTeaser(scores, roundNumber, roundSummary = null) {
        if (!Array.isArray(scores) || scores.length < 2) return "The competition heats up...";

        const teasers = [];
        const count = scores.length;

        let tiedPairs = 0;
        let minGap = Infinity;
        let closePairs = 0;
        for (let i = 1; i < count; i++) {
            const gap = Math.max(0, (scores[i - 1].score || 0) - (scores[i].score || 0));
            if (gap === 0 && (scores[i].score || 0) > 0) tiedPairs++;
            if (gap > 0 && gap < minGap) minGap = gap;
            if (gap <= 10) closePairs++;
        }
        if (!Number.isFinite(minGap)) minGap = 0;

        const totalCorrect = scores.reduce((sum, s) => sum + (s.correct || 0), 0);
        const revealPattern = Math.abs(Number(roundNumber) || 0) % 3;

        switch (revealPattern) {
            case 0: {
                if (closePairs >= 2) {
                    teasers.push(`${closePairs} spots on the board are within a single question of each other.`);
                    teasers.push("One good round can reshuffle the whole table.");
                } else if (minGap > 0) {
                    const unit = minGap === 1 ? "point separates" : "points separate";
                    teasers.push(`The closest chase on the board: just ${minGap} ${unit} two contenders.`);
                    if (totalCorrect > 0) {
                        teasers.push(`The table has cracked ${totalCorrect} correct answers so far.`);
                    }
                } else {
                    teasers.push("Scores are dead level across the board. Everything is up for grabs.");
                }
                break;
            }
            case 1: {
                if (tiedPairs > 0 && minGap > 0) {
                    const unit = minGap === 1 ? "point" : "points";
                    teasers.push(`Dead heat on the board: we have a tie, and another spot is within ${minGap} ${unit}.`);
                } else if (tiedPairs > 0) {
                    teasers.push("Dead heat! Multiple players are locked on the exact same score.");
                } else {
                    const unit = minGap === 1 ? "point separates" : "points separate";
                    teasers.push(`Razor-thin margin: just ${minGap} ${unit} two players right now.`);
                    teasers.push("A single question could flip the spots.");
                }
                break;
            }
            case 2: {
                if (count >= 3) {
                    let tightestTrio = Infinity;
                    for (let i = 0; i <= count - 3; i++) {
                        const span = Math.max(0, (scores[i].score || 0) - (scores[i + 2].score || 0));
                        if (span < tightestTrio) tightestTrio = span;
                    }
                    if (tightestTrio === 0) {
                        teasers.push("Three players are dead even on points. The pack couldn't be tighter.");
                    } else {
                        const unit = tightestTrio === 1 ? "point" : "points";
                        teasers.push(`Tight pack: three players are bunched within ${tightestTrio} ${unit} of each other.`);
                        teasers.push("Nobody is out of reach.");
                    }
                } else {
                    const unit = minGap === 1 ? "point" : "points";
                    teasers.push(`Neck and neck: only ${minGap} ${unit} between contenders. Still anyone's game.`);
                }
                break;
            }
        }

        if (roundSummary?.playerScores?.length && roundSummary.totalQuestions > 1) {
            const topRound = roundSummary.playerScores[0];
            if (topRound && topRound.roundCorrect === roundSummary.totalQuestions) {
                teasers.push(`${topRound.name} went ${topRound.roundCorrect} for ${roundSummary.totalQuestions} this round!`);
            }
        }

        return teasers.join(" ");
    }

    static generatePlayerNudge(scores, userId, pointsPerQuestion = 10) {
        if (!Array.isArray(scores) || scores.length < 2 || !userId) return "";
        const myIdx = scores.findIndex(s => s.userId === userId);
        if (myIdx === -1) return "";

        const me = scores[myIdx];
        const pts = Math.max(1, Number(pointsPerQuestion) || 10);
        const tiedAbove = myIdx > 0 && scores[myIdx - 1].score === me.score;
        const tiedBelow = myIdx < scores.length - 1 && scores[myIdx + 1].score === me.score;

        if ((tiedAbove || tiedBelow) && me.score > 0) {
            return "You're tied on points with another player at the table. One answer breaks the tie!";
        }

        if (myIdx > 0) {
            const ahead = scores[myIdx - 1];
            const gap = Math.max(1, (ahead.score || 0) - (me.score || 0));
            const questionsAway = Math.ceil(gap / pts);
            if (gap === 1) {
                return "You're just 1 point away from the next spot up!";
            }
            if (questionsAway <= 1) {
                return `You're just ${gap} pts (a single question!) from catching the next spot up.`;
            }
            if (questionsAway === 2) {
                return `Within striking distance: just ${gap} pts from overtaking the next spot ahead of you!`;
            }
            return `Still in the hunt: ${gap} pts to reel in the next spot ahead of you.`;
        }

        const chaser = scores[1];
        const leadGap = Math.max(0, (me.score || 0) - (chaser?.score || 0));
        if (leadGap === 0) {
            return "Neck and neck at the table. Every question counts!";
        }
        if (leadGap <= pts) {
            const unit = leadGap === 1 ? "1 point" : `${leadGap} pts`;
            return `Keep sharp: another contender is within ${unit} of your score!`;
        }
        return `Strong momentum: another contender is ${leadGap} pts behind your pace!`;
    }

    static generateAllPlayerNudges(scores, pointsPerQuestion = 10) {
        const nudges = {};
        if (!Array.isArray(scores)) return nudges;
        for (const s of scores) {
            if (!s.userId) continue;
            const text = this.generatePlayerNudge(scores, s.userId, pointsPerQuestion);
            if (text) nudges[s.userId] = text;
        }
        return nudges;
    }

    static generateFinalReveal(scores, prizes = {}) {
        const reveal = scores.map((s, i) => {
            let prize = null;
            if (i === 0 && prizes.first) prize = prizes.first;
            else if (i === 1 && prizes.second) prize = prizes.second;
            else if (prizes.consolation) prize = prizes.consolation;

            return {
                rank: s.rank,
                userId: s.userId,
                name: s.name,
                color: s.color,
                score: s.score,
                correct: s.correct,
                total: s.total,
                prize
            };
        });

        return reveal.reverse();
    }
}
