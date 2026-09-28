import { Logger } from "../lib/Logger.js";
import { MAX_QUESTIONS_PER_ROUND } from "./constants.js";

const QUIZ_NAMES = [
    "The Sinister Man's Inquisition",
    "The Grand Campaign Retrospective",
    "Lights Out, Quills Down",
    "What Were You Even Doing?",
    "The Reckoning",
    "Annual Campaign Review",
    "The Big Quiz Night",
    "Test of Memory and Honour"
];

const ROUND_NAMES = [
    "Campaign Recall",
    "Who Said That?",
    "Places & Faces",
    "The Plot Thickens",
    "Villains & Allies",
    "Name That NPC",
    "Lore & Legend",
    "Where Were You When...?"
];

const ROUND_TAGS = ["campaign", "campaign", "campaign", "rules", "general"];

export class QuizSchema {

    static levenshtein(a, b) {
        a = String(a).toLowerCase();
        b = String(b).toLowerCase();
        if (a === b) return 0;
        if (a.length === 0) return b.length;
        if (b.length === 0) return a.length;

        const matrix = [];
        for (let i = 0; i <= b.length; i++) matrix[i] = [i];
        for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                matrix[i][j] = b[i - 1] === a[j - 1]
                    ? matrix[i - 1][j - 1]
                    : Math.min(
                        matrix[i - 1][j - 1] + 1, // substitute
                        matrix[i][j - 1] + 1,     // insert
                        matrix[i - 1][j] + 1      // delete
                    );
            }
        }
        return matrix[b.length][a.length];
    }

    // Exact = definite. Within tolerance = probable (GM review). Else unlikely.
    static checkTextAnswer(playerAnswer, correctAnswer, acceptedAnswers = [], tolerance = 5) {
        const input = String(playerAnswer || "").trim().toLowerCase();
        const correct = String(correctAnswer || "").trim().toLowerCase();
        const variants = [correct, ...acceptedAnswers.map(a => String(a).trim().toLowerCase())];

        let bestDistance = Infinity;
        for (const variant of variants) {
            if (!variant) continue;
            if (input === variant) {
                return { matched: true, fuzzy: false, confidence: "definite", distance: 0 };
            }
            const dist = this.levenshtein(input, variant);
            if (dist < bestDistance) bestDistance = dist;
        }

        if (bestDistance <= tolerance) {
            return { matched: true, fuzzy: true, confidence: "probable", distance: bestDistance };
        }

        return { matched: false, fuzzy: false, confidence: "unlikely", distance: bestDistance };
    }

    static validate(raw) {
        const errors = [];
        if (!raw || typeof raw !== "object") {
            return { valid: false, quiz: null, errors: ["Quiz data is not an object."] };
        }

        const quiz = {
            id: raw.id || foundry.utils.randomID(),
            name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Untitled Quiz",
            description: typeof raw.description === "string" ? raw.description.trim() : "",
            prizes: this._validatePrizes(raw.prizes),
            rounds: [],
            createdAt: raw.createdAt || Date.now(),
            updatedAt: Date.now()
        };

        if (!Array.isArray(raw.rounds) || raw.rounds.length === 0) {
            errors.push("Quiz must have at least one round.");
            return { valid: false, quiz: null, errors };
        }

        for (let i = 0; i < raw.rounds.length; i++) {
            const result = this._validateRound(raw.rounds[i], i);
            if (result.errors.length > 0) {
                errors.push(...result.errors.map(e => `Round ${i + 1}: ${e}`));
            }
            if (result.round) quiz.rounds.push(result.round);
        }

        return { valid: errors.length === 0, quiz, errors };
    }

    static derivePrizeType(prize) {
        const gold = Number(prize?.gold) || 0;
        const items = this._normalizePrizeItems(prize);
        if (gold > 0 && items.length) return "bundle";
        if (items.length) return "item";
        if (gold > 0) return "gold";
        return "text";
    }

    static _normalizePrizeItems(prize) {
        const seen = new Set();
        const items = [];
        const legacyMystery = !!prize?.mystery;
        const push = (entry) => {
            const uuid = typeof entry === "string"
                ? entry.trim()
                : String(entry?.uuid || "").trim();
            if (!uuid || seen.has(uuid)) return;
            seen.add(uuid);
            const ownMystery = typeof entry?.mystery === "boolean";
            items.push({
                uuid,
                name: typeof entry?.name === "string" ? entry.name.trim() : "",
                img: typeof entry?.img === "string" ? entry.img.trim() : "",
                mystery: ownMystery ? !!entry.mystery : legacyMystery
            });
        };
        if (Array.isArray(prize?.items)) prize.items.forEach(push);
        if (typeof prize?.itemUuid === "string") push(prize.itemUuid);
        return items;
    }

    static _emptyPrize(label, mystery) {
        return { label, gold: 0, type: "text", itemUuid: "", items: [], mystery, goldMystery: false };
    }

    static _validatePrizes(raw) {
        const defaults = {
            first: this._emptyPrize("Mystery Box", true),
            second: this._emptyPrize("Mystery Box", true),
            consolation: this._emptyPrize("Consolation Prize", false)
        };
        if (!raw || typeof raw !== "object") {
            return foundry.utils.deepClone(defaults);
        }

        const prizes = {};
        for (const tier of ["first", "second", "consolation"]) {
            const p = raw[tier];
            if (!p || typeof p !== "object") {
                prizes[tier] = { ...defaults[tier], items: [] };
                continue;
            }
            const gold = typeof p.gold === "number" ? Math.max(0, Math.floor(p.gold)) : 0;
            const items = this._normalizePrizeItems(p);
            const goldMystery = typeof p.goldMystery === "boolean"
                ? p.goldMystery
                : (!!p.mystery && gold > 0);
            const mystery = goldMystery
                || items.some(item => item.mystery)
                || (gold === 0 && items.length === 0 && !!p.mystery);
            prizes[tier] = {
                label: typeof p.label === "string" && p.label.trim() ? p.label.trim() : defaults[tier].label,
                gold,
                goldMystery,
                items,
                itemUuid: items[0]?.uuid || "",
                type: this.derivePrizeType({ gold, items }),
                mystery
            };
        }
        return prizes;
    }

    static _validateRound(raw, index) {
        const errors = [];
        if (!raw || typeof raw !== "object") {
            return { round: null, errors: ["Round is not an object."] };
        }

        const validTypes = ["text-answer", "multiple-choice", "true-false", "picture", "nearest-number"];
        const parkedTypes = { audio: "text-answer", wager: "text-answer" };
        const type = parkedTypes[raw.type] || (validTypes.includes(raw.type) ? raw.type : null);
        if (!type) {
            errors.push(`Unknown round type "${raw.type}". Valid types: ${validTypes.join(", ")}`);
            return { round: null, errors };
        }

        const round = {
            id: raw.id || foundry.utils.randomID(),
            type,
            name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : `Round ${index + 1}`,
            tag: typeof raw.tag === "string" ? raw.tag.trim() : "general",
            timeLimit: typeof raw.timeLimit === "number" ? Math.max(0, Math.floor(raw.timeLimit)) : 0,
            pointsPerQuestion: typeof raw.pointsPerQuestion === "number" ? Math.max(1, Math.floor(raw.pointsPerQuestion)) : 10,
            questions: []
        };

        if (!Array.isArray(raw.questions) || raw.questions.length === 0) {
            errors.push("Round must have at least one question.");
            return { round: null, errors };
        }

        if (raw.questions.length > MAX_QUESTIONS_PER_ROUND) {
            errors.push(`A round can have at most ${MAX_QUESTIONS_PER_ROUND} questions.`);
        }

        for (let i = 0; i < raw.questions.length; i++) {
            const q = this._validateQuestion(raw.questions[i], type, i);
            if (q.errors.length > 0) {
                errors.push(...q.errors.map(e => `Q${i + 1}: ${e}`));
            }
            if (q.question) round.questions.push(q.question);
        }

        return { round, errors };
    }

    static _validateQuestion(raw, roundType, index) {
        const errors = [];
        if (!raw || typeof raw !== "object") {
            return { question: null, errors: ["Question is not an object."] };
        }

        const base = {
            id: raw.id || foundry.utils.randomID(),
            text: typeof raw.text === "string" ? raw.text.trim() : "",
            hint: typeof raw.hint === "string" ? raw.hint.trim() : "",
            media: typeof raw.media === "string" ? raw.media.trim() : ""
        };

        if (!base.text) {
            errors.push("Question text is required.");
        }

        switch (roundType) {
            case "text-answer":
                base.answer = typeof raw.answer === "string" ? raw.answer.trim() : "";
                base.acceptedAnswers = Array.isArray(raw.acceptedAnswers)
                    ? raw.acceptedAnswers.map(a => String(a).trim().toLowerCase()).filter(Boolean)
                    : [];
                if (base.answer && !base.acceptedAnswers.includes(base.answer.toLowerCase())) {
                    base.acceptedAnswers.push(base.answer.toLowerCase());
                }
                if (!base.answer) errors.push("Text answer is required.");
                break;

            case "multiple-choice":
                base.options = Array.isArray(raw.options) ? raw.options.map(o => String(o).trim()) : [];
                base.correctIndex = typeof raw.correctIndex === "number" ? raw.correctIndex : -1;
                if (base.options.length < 2) errors.push("Multiple choice needs at least 2 options.");
                if (base.correctIndex < 0 || base.correctIndex >= base.options.length) {
                    errors.push("Correct answer index is out of range.");
                }
                break;

            case "true-false":
                base.answer = typeof raw.answer === "boolean" ? raw.answer : null;
                if (base.answer === null) errors.push("True/False answer must be true or false.");
                break;

            case "picture":
                base.answer = typeof raw.answer === "string" ? raw.answer.trim() : "";
                base.acceptedAnswers = Array.isArray(raw.acceptedAnswers)
                    ? raw.acceptedAnswers.map(a => String(a).trim().toLowerCase()).filter(Boolean)
                    : [];
                if (base.answer && !base.acceptedAnswers.includes(base.answer.toLowerCase())) {
                    base.acceptedAnswers.push(base.answer.toLowerCase());
                }
                if (!base.media) errors.push("Picture round questions need an image path.");
                if (!base.answer) errors.push("Answer is required.");
                break;

            case "nearest-number":
                base.answer = typeof raw.answer === "number" ? raw.answer : Number(raw.answer);
                if (!Number.isFinite(base.answer)) errors.push("Nearest-number answer must be a number.");
                break;
        }

        return { question: base, errors };
    }

    static createBlank() {
        const name = QUIZ_NAMES[Math.floor(Math.random() * QUIZ_NAMES.length)];
        return {
            id: foundry.utils.randomID(),
            name,
            description: "",
            prizes: this._validatePrizes({}),
            rounds: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
    }

    static createBlankRound(type = "text-answer") {
        const name = ROUND_NAMES[Math.floor(Math.random() * ROUND_NAMES.length)];
        const tag = ROUND_TAGS[Math.floor(Math.random() * ROUND_TAGS.length)];
        const parked = { audio: "text-answer", wager: "text-answer" };
        return {
            id: foundry.utils.randomID(),
            type: parked[type] || type,
            name,
            tag,
            timeLimit: 0,
            pointsPerQuestion: 10,
            questions: []
        };
    }

    static createBlankQuestion(roundType = "text-answer") {
        const base = {
            id: foundry.utils.randomID(),
            text: "",
            hint: "",
            media: ""
        };

        switch (roundType) {
            case "text-answer":
            case "picture":
            case "audio":
            case "wager":
                base.answer = "";
                base.acceptedAnswers = [];
                break;
            case "multiple-choice":
                base.options = ["", "", "", ""];
                base.correctIndex = 0;
                break;
            case "true-false":
                base.answer = true;
                break;
            case "nearest-number":
                base.answer = 0;
                break;
        }

        return base;
    }
}
