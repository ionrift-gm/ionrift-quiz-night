import { MODULE_ID } from "../data/constants.js";
import { QuizEditorApp } from "./QuizEditorApp.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class QuizLauncherApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "ionrift-quiz-launcher",
        classes: ["ionrift-window", "glass-ui", "ionrift-quiz-launcher-dialog"],
        window: {
            title: "Quiz Night",
            resizable: true
        },
        position: { width: 400, height: 360 },
        actions: {
            "new-quiz": QuizLauncherApp.#onNewQuiz,
            "edit-quiz": QuizLauncherApp.#onEditQuiz,
            "duplicate-quiz": QuizLauncherApp.#onDuplicateQuiz,
            "start-quiz": QuizLauncherApp.#onStartQuiz,
            "delete-quiz": QuizLauncherApp.#onDeleteQuiz
        }
    };

    static PARTS = {
        body: { template: `modules/${MODULE_ID}/templates/quiz-launcher.hbs` }
    };

    static getInstance() {
        const apps = foundry.applications?.instances;
        if (!apps) return null;
        const byId = apps.get?.("ionrift-quiz-launcher");
        if (byId) return byId;
        for (const app of apps.values()) {
            if (app.id === "ionrift-quiz-launcher") return app;
        }
        return null;
    }

    _prepareContext() {
        const quizzes = game.settings.get(MODULE_ID, "quizzes") || {};
        return {
            quizzes: Object.values(quizzes).map(q => ({
                id: q.id,
                name: q.name || "Untitled",
                rounds: q.rounds?.length || 0,
                questions: q.rounds?.reduce((sum, r) => sum + (r.questions?.length || 0), 0) || 0
            }))
        };
    }

    static #onNewQuiz() {
        new QuizEditorApp().render({ force: true });
        this.close();
    }

    static #onEditQuiz(event, target) {
        new QuizEditorApp(target.dataset.quizId).render({ force: true });
        this.close();
    }

    static async #onDuplicateQuiz(event, target) {
        const copy = await game.ionrift.quizNight.duplicateQuiz(target.dataset.quizId);
        if (copy) {
            ui.notifications.info(`Duplicated: ${copy.name}`);
            this.render({ force: true });
        }
    }

    static #onStartQuiz(event, target) {
        game.ionrift.quizNight.startQuiz(target.dataset.quizId);
        this.close();
    }

    static async #onDeleteQuiz(event, target) {
        const confirmed = await game.ionrift.library.confirm({
            title: "Delete Quiz",
            content: "Are you sure you want to delete this quiz?",
            yesLabel: "Delete",
            noLabel: "Cancel"
        });
        if (!confirmed) return;
        const all = foundry.utils.deepClone(game.settings.get(MODULE_ID, "quizzes") || {});
        delete all[target.dataset.quizId];
        await game.settings.set(MODULE_ID, "quizzes", all);
        ui.notifications.info("Quiz deleted.");
        this.render({ force: true });
    }
}
