import { Logger } from "../lib/Logger.js";
import { MODULE_ID, MAX_QUESTIONS_PER_ROUND, QUESTION_WARN_COUNT } from "../data/constants.js";
import { QuizSchema } from "../data/QuizSchema.js";
import { QuizPrizesApp } from "./QuizPrizesApp.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class QuizEditorApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "ionrift-quiz-editor",
        classes: ["ionrift-window", "glass-ui", "ionrift-quiz-editor"],
        window: {
            title: "Quiz Night: Editor",
            resizable: true
        },
        position: { width: 620, height: 680 },
        actions: {
            "add-round": QuizEditorApp.#onAddRound,
            "select-round": QuizEditorApp.#onSelectRound,
            "delete-round": QuizEditorApp.#onDeleteRound,
            "move-round-up": QuizEditorApp.#onMoveRoundUp,
            "move-round-down": QuizEditorApp.#onMoveRoundDown,
            "add-question": QuizEditorApp.#onAddQuestion,
            "delete-question": QuizEditorApp.#onDeleteQuestion,
            "duplicate-question": QuizEditorApp.#onDuplicateQuestion,
            "move-question-up": QuizEditorApp.#onMoveQuestionUp,
            "move-question-down": QuizEditorApp.#onMoveQuestionDown,
            "toggle-question": QuizEditorApp.#onToggleQuestion,
            "select-question": QuizEditorApp.#onSelectQuestion,
            "pick-media": QuizEditorApp.#onPickMedia,
            "open-prizes": QuizEditorApp.#onOpenPrizes,
            "toggle-footer-menu": QuizEditorApp.#onToggleFooterMenu,
            "save-quiz": QuizEditorApp.#onSaveQuiz,
            "export-quiz": QuizEditorApp.#onExportQuiz,
            "import-quiz": QuizEditorApp.#onImportQuiz
        }
    };

    static PARTS = {
        form: { template: `modules/${MODULE_ID}/templates/quiz-editor.hbs` }
    };

    _quiz = null;
    _selectedRound = 0;
    _expandedQuestion = null;
    _dirty = false;
    _savedSnapshot = "";
    _prizesApp = null;
    _footerMenuOpen = false;

    constructor(quizId = null, options = {}) {
        super(options);
        if (quizId) {
            const quizzes = game.settings.get(MODULE_ID, "quizzes") || {};
            this._quiz = foundry.utils.deepClone(quizzes[quizId]) || QuizSchema.createBlank();
        } else {
            this._quiz = QuizSchema.createBlank();
        }
        this._quiz.prizes = QuizSchema._validatePrizes(this._quiz.prizes);
        this._savedSnapshot = JSON.stringify(this._quiz);
        const firstRound = this._quiz.rounds[0];
        if (firstRound?.questions?.length) {
            this._expandedQuestion = 0;
        }
    }

    get title() {
        const dirty = this._dirty ? " *" : "";
        return `Quiz Night: Editor${dirty}`;
    }

    async _prepareContext(options) {
        const rawRound = this._quiz.rounds[this._selectedRound] || null;
        const roundTypes = [
            { value: "text-answer", label: "Text Answer", icon: "fa-keyboard" },
            { value: "multiple-choice", label: "Multiple Choice", icon: "fa-list-ol" },
            { value: "true-false", label: "True / False", icon: "fa-check-double" },
            { value: "picture", label: "Picture Round", icon: "fa-image" },
            { value: "nearest-number", label: "Nearest Number", icon: "fa-bullseye" }
        ];

        const typeIconMap = Object.fromEntries(roundTypes.map(t => [t.value, t.icon]));

        if (rawRound?.questions?.length === 1 && this._expandedQuestion == null) {
            this._expandedQuestion = 0;
        }

        let round = null;
        if (rawRound) {
            round = {
                ...rawRound,
                roundType: rawRound.type,
                questions: rawRound.questions.map((q, qi) => ({
                    ...q,
                    qIndex: qi,
                    qLabel: `Q${qi + 1}`,
                    isExpanded: qi === this._expandedQuestion,
                    hasContent: Boolean(q.text && q.text.trim()),
                    hasImagePreview: rawRound.type === "picture" && Boolean(q.media),
                    acceptedAnswersStr: (q.acceptedAnswers || []).join(", "),
                    optionsList: (q.options || []).map((opt, oi) => ({
                        oIndex: oi,
                        oLabel: ["A", "B", "C", "D"][oi] || String(oi + 1),
                        text: opt,
                        isCorrect: oi === q.correctIndex
                    }))
                }))
            };
        }

        this._dirty = JSON.stringify(this._quiz) !== this._savedSnapshot;

        return {
            quiz: this._quiz,
            dirty: this._dirty,
            footerMenuOpen: this._footerMenuOpen,
            rounds: this._quiz.rounds.map((r, i) => ({
                ...r,
                index: i,
                selected: i === this._selectedRound,
                questionCount: r.questions.length,
                typeIcon: typeIconMap[r.type] || "fa-question",
                canMoveUp: i > 0,
                canMoveDown: i < this._quiz.rounds.length - 1
            })),
            selectedRound: this._selectedRound,
            expandedQuestion: this._expandedQuestion,
            hasExpandedQuestion: this._expandedQuestion != null,
            showSidebar: round ? round.questions.length > 1 : false,
            questionAtCap: round ? round.questions.length >= MAX_QUESTIONS_PER_ROUND : false,
            questionCountWarn: round ? round.questions.length >= QUESTION_WARN_COUNT : false,
            round,
            roundTypes,
            tags: ["campaign", "rules", "general", "custom"]
        };
    }

    _onRender(context, options) {
        const el = this.element;
        if (el && !el.dataset.bound) {
            el.dataset.bound = "1";
            el.addEventListener("change", (e) => this._handleChange(e));
            el.addEventListener("input", (e) => {
                if (e.target?.name || e.target?.dataset?.questionField) {
                    this._markDirty();
                }
            });
        }
    }

    _markDirty() {
        this._dirty = true;
        const titleEl = this.element?.querySelector?.(".window-title");
        if (titleEl && !titleEl.textContent.endsWith(" *")) {
            titleEl.textContent = `${titleEl.textContent} *`;
        }
    }

    async _handleChange(e) {
        const target = e.target;
        const name = target.name;
        const round = this._quiz.rounds[this._selectedRound];

        if (name === "quiz-name") {
            this._quiz.name = target.value;
            this._markDirty();
            return;
        }
        if (name === "round-name" && round) {
            round.name = target.value;
            this._markDirty();
            this.render();
            return;
        }
        if (name === "round-type" && round) {
            const newType = target.value;
            if (newType === round.type) return;
            if (round.questions.length > 0) {
                const confirmed = await game.ionrift.library.confirm({
                    title: "Change Round Type",
                    content: "Changing the round type clears all questions in this round. Continue?",
                    yesLabel: "Clear Questions",
                    noLabel: "Cancel"
                });
                if (!confirmed) {
                    target.value = round.type;
                    return;
                }
            }
            round.type = newType;
            round.questions = [];
            this._expandedQuestion = null;
            this._markDirty();
            this.render();
            return;
        }
        if (name === "round-tag" && round) {
            round.tag = target.value;
            this._markDirty();
            return;
        }
        if (name === "round-time" && round) {
            round.timeLimit = Number(target.value) || 0;
            this._markDirty();
            return;
        }
        if (name === "round-points" && round) {
            round.pointsPerQuestion = Number(target.value) || 10;
            this._markDirty();
            return;
        }

        const qField = target.dataset.questionField;
        if (qField && round) {
            const qIdx = Number(target.dataset.questionIndex);
            const q = round.questions[qIdx];
            if (!q) return;
            const value = target.value;

            switch (qField) {
                case "text": q.text = value; break;
                case "answer": q.answer = value; break;
                case "number-answer": q.answer = Number(value) || 0; break;
                case "hint": q.hint = value; break;
                case "media": q.media = value; break;
                case "accepted":
                    q.acceptedAnswers = value.split(",").map(a => a.trim().toLowerCase()).filter(Boolean);
                    break;
                case "correctIndex":
                    q.correctIndex = Number(value);
                    break;
                case "tf-answer":
                    q.answer = value === "true";
                    break;
            }
            this._markDirty();
            return;
        }

        const optIdx = target.dataset.optionIndex;
        if (optIdx !== undefined && round) {
            const qIdx = Number(target.dataset.questionIndex);
            if (round.questions[qIdx]) {
                round.questions[qIdx].options[Number(optIdx)] = target.value;
                this._markDirty();
            }
        }
    }

    static #onSelectRound(event, target) {
        this._selectedRound = Number(target.dataset.index);
        const round = this._quiz.rounds[this._selectedRound];
        this._expandedQuestion = round?.questions?.length ? 0 : null;
        this.render();
    }

    static #onAddRound(event, target) {
        this._quiz.rounds.push(QuizSchema.createBlankRound());
        this._selectedRound = this._quiz.rounds.length - 1;
        this._expandedQuestion = null;
        this._markDirty();
        this.render();
    }

    static #onDeleteRound(event, target) {
        const idx = Number(target.dataset.index);
        this._quiz.rounds.splice(idx, 1);
        if (this._selectedRound >= this._quiz.rounds.length) {
            this._selectedRound = Math.max(0, this._quiz.rounds.length - 1);
        }
        this._expandedQuestion = null;
        this._markDirty();
        this.render();
    }

    static #onMoveRoundUp(event, target) {
        event.stopPropagation();
        const idx = Number(target.dataset.index);
        if (idx <= 0) return;
        const rounds = this._quiz.rounds;
        [rounds[idx - 1], rounds[idx]] = [rounds[idx], rounds[idx - 1]];
        this._selectedRound = idx - 1;
        this._markDirty();
        this.render();
    }

    static #onMoveRoundDown(event, target) {
        event.stopPropagation();
        const idx = Number(target.dataset.index);
        const rounds = this._quiz.rounds;
        if (idx >= rounds.length - 1) return;
        [rounds[idx], rounds[idx + 1]] = [rounds[idx + 1], rounds[idx]];
        this._selectedRound = idx + 1;
        this._markDirty();
        this.render();
    }

    static #onToggleQuestion(event, target) {
        const idx = Number(target.dataset.index);
        const onlyOne = (this._quiz.rounds[this._selectedRound]?.questions?.length || 0) <= 1;
        if (onlyOne) {
            this._expandedQuestion = idx;
        } else {
            this._expandedQuestion = (this._expandedQuestion === idx) ? null : idx;
        }
        this.render();
    }

    static #onSelectQuestion(event, target) {
        const idx = Number(target.dataset.index);
        this._expandedQuestion = idx;
        this.render();
    }

    static #onOpenPrizes(event, target) {
        if (this._prizesApp) {
            this._prizesApp.render({ force: true });
            this._prizesApp.bringToFront?.();
            return;
        }
        this._prizesApp = new QuizPrizesApp(this);
        this._prizesApp.render({ force: true });
    }

    static #onToggleFooterMenu(event, target) {
        this._footerMenuOpen = !this._footerMenuOpen;
        this.render();
    }

    static #onAddQuestion(event, target) {
        const round = this._quiz.rounds[this._selectedRound];
        if (!round) return;
        if (round.questions.length >= MAX_QUESTIONS_PER_ROUND) {
            ui.notifications.warn(`A round can have at most ${MAX_QUESTIONS_PER_ROUND} questions.`);
            return;
        }
        if (round.questions.length === QUESTION_WARN_COUNT - 1) {
            ui.notifications.info(`This round is getting long. ${QUESTION_WARN_COUNT} or more questions get hard to run live.`);
        }
        round.questions.push(QuizSchema.createBlankQuestion(round.type));
        this._expandedQuestion = round.questions.length - 1;
        this._markDirty();
        this.render();
    }

    static #onDeleteQuestion(event, target) {
        const idx = Number(target.dataset.index);
        const round = this._quiz.rounds[this._selectedRound];
        if (round) {
            round.questions.splice(idx, 1);
            if (!round.questions.length) this._expandedQuestion = null;
            else if (this._expandedQuestion == null || this._expandedQuestion >= round.questions.length) {
                this._expandedQuestion = Math.max(0, round.questions.length - 1);
            } else if (this._expandedQuestion > idx) {
                this._expandedQuestion -= 1;
            }
            this._markDirty();
            this.render();
        }
    }

    static #onDuplicateQuestion(event, target) {
        event.stopPropagation();
        const idx = Number(target.dataset.index);
        const round = this._quiz.rounds[this._selectedRound];
        if (!round?.questions[idx]) return;
        if (round.questions.length >= MAX_QUESTIONS_PER_ROUND) {
            ui.notifications.warn(`A round can have at most ${MAX_QUESTIONS_PER_ROUND} questions.`);
            return;
        }
        const clone = foundry.utils.deepClone(round.questions[idx]);
        round.questions.splice(idx + 1, 0, clone);
        this._expandedQuestion = idx + 1;
        this._markDirty();
        this.render();
    }

    static #onMoveQuestionUp(event, target) {
        event.stopPropagation();
        const idx = Number(target.dataset.index);
        const round = this._quiz.rounds[this._selectedRound];
        if (!round || idx <= 0) return;
        const qs = round.questions;
        [qs[idx - 1], qs[idx]] = [qs[idx], qs[idx - 1]];
        this._expandedQuestion = idx - 1;
        this._markDirty();
        this.render();
    }

    static #onMoveQuestionDown(event, target) {
        event.stopPropagation();
        const idx = Number(target.dataset.index);
        const round = this._quiz.rounds[this._selectedRound];
        if (!round || idx >= round.questions.length - 1) return;
        const qs = round.questions;
        [qs[idx], qs[idx + 1]] = [qs[idx + 1], qs[idx]];
        this._expandedQuestion = idx + 1;
        this._markDirty();
        this.render();
    }

    static #onPickMedia(event, target) {
        const qIdx = Number(target.dataset.questionIndex);
        const round = this._quiz.rounds[this._selectedRound];
        if (!round?.questions[qIdx]) return;
        const Picker = foundry.applications?.apps?.FilePicker ?? globalThis.FilePicker;
        const fp = new Picker({
            type: "image",
            current: round.questions[qIdx].media || "",
            callback: (path) => {
                round.questions[qIdx].media = path;
                this._markDirty();
                this.render();
            }
        });
        fp.render(true);
    }

    static async #onSaveQuiz(event, target) {
        this._quiz.updatedAt = Date.now();
        const result = QuizSchema.validate(this._quiz);

        if (!result.valid) {
            ui.notifications.warn(`Quiz has issues: ${result.errors.slice(0, 3).join("; ")}`);
            Logger.warn("Validation errors:", result.errors);
        }

        const quiz = result.quiz || this._quiz;
        const quizzes = foundry.utils.deepClone(game.settings.get(MODULE_ID, "quizzes") || {});
        quizzes[quiz.id] = quiz;
        await game.settings.set(MODULE_ID, "quizzes", quizzes);
        this._quiz = quiz;
        this._savedSnapshot = JSON.stringify(this._quiz);
        this._dirty = false;

        ui.notifications.info(`Quiz saved: ${quiz.name}`);
        Logger.log("Quiz saved:", quiz.id);
        this.render();
        this._prizesApp?.render({ force: true });
    }

    static #onExportQuiz(event, target) {
        const data = JSON.stringify(this._quiz, null, 2);
        const blob = new Blob([data], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${this._quiz.name || "quiz"}.json`.replace(/\s+/g, "_").toLowerCase();
        a.click();
        URL.revokeObjectURL(url);
        ui.notifications.info("Quiz exported.");
    }

    static async #onImportQuiz(event, target) {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const raw = JSON.parse(text);
                const result = QuizSchema.validate(raw);
                if (result.quiz) {
                    result.quiz.id = foundry.utils.randomID();
                    this._quiz = result.quiz;
                    this._markDirty();
                    this.render();
                    this._prizesApp?.render({ force: true });
                    ui.notifications.info(`Imported: ${result.quiz.name}`);
                    if (!result.valid) {
                        ui.notifications.warn(`Import had issues: ${result.errors.slice(0, 3).join("; ")}`);
                    }
                } else {
                    ui.notifications.error("Import failed: " + result.errors.join("; "));
                }
            } catch (err) {
                ui.notifications.error("Failed to parse JSON file.");
                Logger.error("Import error:", err);
            }
        };
        input.click();
    }

    async close(options = {}) {
        if (this._dirty && !options._forceClose) {
            const confirmed = await game.ionrift.library.confirm({
                title: "Unsaved Changes",
                content: "This quiz has unsaved changes. Close anyway?",
                yesLabel: "Discard",
                noLabel: "Keep Editing"
            });
            if (!confirmed) return this;
        }
        if (this._prizesApp) {
            await this._prizesApp.close({ _forceClose: true });
            this._prizesApp = null;
        }
        return super.close(options);
    }
}
