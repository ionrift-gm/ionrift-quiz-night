import { AbstractPackRegistryApp } from "../../../ionrift-library/scripts/apps/packs/AbstractPackRegistryApp.js";
import { getWorldSetting } from "../../../ionrift-library/scripts/services/platform/connectOwnedSettings.js";
import { MODULE_ID } from "../data/constants.js";

export class QuizPackRegistryApp extends AbstractPackRegistryApp {

    static DEFAULT_OPTIONS = {
        id: "quiz-pack-registry",
        window: {
            title: "Quiz Night Packs",
            icon: "fas fa-question-circle",
            resizable: true
        },
        position: { width: 460, height: 480 },
        classes: ["ionrift-window"]
    };

    _getModuleId() {
        return MODULE_ID;
    }

    _getTabDefinitions() {
        return [
            { id: "quizPacks", label: "Question Packs", icon: "fas fa-question-circle" }
        ];
    }

    async _preparePackData() {
        const installedPacks = getWorldSetting("installedPacks") ?? {};
        const packs = Object.entries(installedPacks)
            .filter(([id, meta]) => meta?.type === "quiz" || id.startsWith("quiz-"))
            .map(([id, meta]) => ({
                id,
                label: meta.name ?? id,
                icon: "fas fa-list-ol",
                description: meta.description ?? "Question pack",
                enabled: meta.enabled !== false,
                totalItems: meta.itemCount ?? 0,
                version: meta.version ?? "1.0.0",
                countLabel: "questions",
                author: meta.author
            }));

        packs.sort((a, b) => a.label.localeCompare(b.label));
        return { packs, extra: {} };
    }

    async _renderTabPanel(tabId, context, panel) {
        if (tabId === "quizPacks") {
            await this._renderQuizPacksTab(context, panel);
        }
    }

    _isUpdateRelevant(update) {
        return update.packId?.startsWith("quiz-") || update.packType === "quiz";
    }

    async _renderQuizPacksTab(context, panel) {
        let html = `<div class="pack-tab-content">`;

        html += this._renderSummaryBar([
            { label: "questions loaded", value: context.totalEnabled },
            { label: "packs enabled", value: context.packs.filter(p => p.enabled).length },
            { label: "total available", value: context.totalAll }
        ]);

        if (context.packs.length === 0) {
            html += `<div class="pack-empty-state">
                <p>No question packs installed yet.</p>
                <p class="hint">Import a pack using the button below.</p>
            </div>`;
        } else {
            for (const pack of context.packs) {
                html += this._renderPackCard(pack, `
                    <span class="pack-stat">${pack.totalItems} ${pack.countLabel}</span>
                `);
            }
        }

        html += `</div>`;
        html += this._renderFooterLinks([
            { href: "https://github.com/ionrift-gm/ionrift-library/wiki", icon: "fas fa-book", label: "Documentation" }
        ]);
        html += this._renderActionButtons([
            { cls: "pack-import-btn", icon: "fas fa-file-import", label: "Import Pack" },
            { cls: "pack-save-btn", icon: "fas fa-save", label: "Save Changes" }
        ]);

        panel.innerHTML = html;
    }
}
