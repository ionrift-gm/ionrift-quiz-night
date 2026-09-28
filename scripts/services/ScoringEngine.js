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

    static generateTeaser(scores, roundNumber) {
        if (scores.length < 2) return "The competition heats up...";

        const teasers = [];
        const count = scores.length;
        const revealPattern = roundNumber % 3;

        switch (revealPattern) {
            case 0: {
                if (count >= 3) {
                    teasers.push(`${scores[1].name} is in 2nd place, just behind a mystery leader.`);
                    teasers.push(`${scores[2].name} is nipping at their heels in 3rd.`);
                } else {
                    teasers.push(`${scores[1].name} trails the leader... but by how much?`);
                }
                break;
            }
            case 1: {
                const gap = scores[0].score - scores[count - 1].score;
                teasers.push(`The gap between 1st and last is ${gap} points.`);
                if (count >= 3) {
                    const midGap = scores[0].score - scores[Math.floor(count / 2)].score;
                    teasers.push(midGap <= 10 ? "It's still anyone's game." : "Someone is pulling ahead...");
                }
                break;
            }
            case 2: {
                teasers.push(`${scores[count - 1].name} is in last place. Time for a comeback?`);
                if (count >= 3) {
                    const mid = Math.floor(count / 2);
                    teasers.push(`${scores[mid].name} sits somewhere in the middle of the pack.`);
                }
                break;
            }
        }

        return teasers.join(" ");
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
