import { MODULE_ID } from "../data/constants.js";
import { QuizSchema } from "../data/QuizSchema.js";
import { resolveItemFromDropEvent } from "../utils/itemDrop.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const MAX_ITEMS_PER_TIER = 6;

const TIER_META = [
    { tier: "first", tierLabel: "1st", hint: "Winner takes these." },
    { tier: "second", tierLabel: "2nd", hint: "Runner-up." },
    {
        tier: "consolation",
        tierLabel: "Everyone",
        hint: "Each item is minted once per player below 2nd."
    }
];

export class QuizPrizesApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "ionrift-quiz-prizes",
        classes: ["ionrift-window", "glass-ui", "ionrift-quiz-prizes"],
        window: {
            title: "Quiz Night: Prizes",
            resizable: true
        },
        position: { width: 480, height: 640 },
        actions: {
            "remove-item": QuizPrizesApp.#onRemoveItem
        }
    };

    static PARTS = {
        body: { template: `modules/${MODULE_ID}/templates/quiz-prizes.hbs` }
    };

    constructor(editor, options = {}) {
        super(options);
        this._editor = editor;
    }

    get title() {
        const name = this._editor?._quiz?.name;
        return name ? `Quiz Night: Prizes (${name})` : "Quiz Night: Prizes";
    }

    async _prepareContext() {
        const prizes = this._editor?._quiz?.prizes || {};
        await this._hydrateItemArt(prizes);
        return {
            tiers: TIER_META.map(meta => {
                const prize = prizes[meta.tier] || {};
                return {
                    ...meta,
                    label: prize.label || "",
                    gold: prize.gold || 0,
                    goldMystery: !!prize.goldMystery,
                    items: prize.items || [],
                    isConsolation: meta.tier === "consolation"
                };
            })
        };
    }

    async _hydrateItemArt(prizes) {
        if (typeof fromUuid !== "function") return;
        for (const meta of TIER_META) {
            const prize = prizes[meta.tier];
            if (!prize?.items?.length) continue;
            for (const item of prize.items) {
                if (item.name && item.img) continue;
                try {
                    const doc = await fromUuid(item.uuid);
                    if (!doc) continue;
                    if (!item.name) item.name = doc.name || "";
                    if (!item.img) item.img = doc.img || "";
                } catch {
                    /* keep stub chip */
                }
            }
            prize.itemUuid = prize.items[0]?.uuid || "";
        }
    }

    _onRender(context, options) {
        const el = this.element;
        if (!el) return;
        if (!el.dataset.prizeBound) {
            el.dataset.prizeBound = "1";
            el.addEventListener("change", ev => this._onFieldChange(ev));
            el.addEventListener("input", ev => this._onFieldChange(ev));
            el.addEventListener("dragover", ev => this._onDragOver(ev));
            el.addEventListener("dragleave", ev => this._onDragLeave(ev));
            el.addEventListener("drop", ev => this._onDrop(ev));
        }
    }

    _onDragOver(event) {
        const placing = event.target.closest?.(".prize-placing");
        if (!placing) return;
        event.preventDefault();
        placing.querySelector(".prize-drop-zone")?.classList.add("is-over");
    }

    _onDragLeave(event) {
        const placing = event.target.closest?.(".prize-placing");
        if (!placing) return;
        if (placing.contains(event.relatedTarget)) return;
        placing.querySelector(".prize-drop-zone")?.classList.remove("is-over");
    }

    async _onDrop(event) {
        const placing = event.target.closest?.(".prize-placing");
        if (!placing) return;
        event.preventDefault();
        event.stopPropagation();
        placing.querySelector(".prize-drop-zone")?.classList.remove("is-over");
        const item = await resolveItemFromDropEvent(event);
        if (!item) {
            ui.notifications.warn("Drop an item from the sidebar or a compendium.");
            return;
        }
        this._addItem(placing.dataset.tier, item);
    }

    _onFieldChange(event) {
        const target = event.target;
        const tier = target?.dataset?.prizeTier;
        const field = target?.dataset?.prizeField;
        const prize = this._editor?._quiz?.prizes?.[tier];
        if (!prize || !field) return;
        if (field === "gold") prize.gold = Math.max(0, Number(target.value) || 0);
        else if (field === "gold-mystery") prize.goldMystery = target.checked;
        else if (field === "item-mystery") {
            const item = prize.items?.find(entry => entry.uuid === target.dataset.uuid);
            if (item) item.mystery = target.checked;
        }
        else if (field === "label") prize.label = target.value;
        prize.mystery = !!prize.goldMystery || (prize.items || []).some(entry => entry.mystery);
        prize.type = QuizSchema.derivePrizeType(prize);
        this._editor?._markDirty?.();
    }

    _addItem(tier, item) {
        const prize = this._editor?._quiz?.prizes?.[tier];
        if (!prize) return;
        if (!Array.isArray(prize.items)) prize.items = [];
        const uuid = item.uuid;
        if (!uuid) return;
        if (prize.items.some(entry => entry.uuid === uuid)) return;
        if (prize.items.length >= MAX_ITEMS_PER_TIER) {
            ui.notifications.warn(`A placing can hold ${MAX_ITEMS_PER_TIER} items.`);
            return;
        }
        prize.items.push({
            uuid,
            name: item.name || "",
            img: item.img || "",
            mystery: false
        });
        prize.itemUuid = prize.items[0]?.uuid || "";
        prize.type = QuizSchema.derivePrizeType(prize);
        if (!prize.label || prize.label === "Mystery Box" || prize.label === "Consolation Prize") {
            prize.label = item.name || prize.label;
        }
        this._editor?._markDirty?.();
        this.render();
    }

    async close(options = {}) {
        if (this._editor?._prizesApp === this) this._editor._prizesApp = null;
        return super.close(options);
    }

    static #onRemoveItem(event, target) {
        event.preventDefault();
        const tier = target.dataset.tier;
        const uuid = target.dataset.uuid;
        const prize = this._editor?._quiz?.prizes?.[tier];
        if (!prize?.items) return;
        prize.items = prize.items.filter(entry => entry.uuid !== uuid);
        prize.itemUuid = prize.items[0]?.uuid || "";
        prize.type = QuizSchema.derivePrizeType(prize);
        this._editor?._markDirty?.();
        this.render();
    }
}
