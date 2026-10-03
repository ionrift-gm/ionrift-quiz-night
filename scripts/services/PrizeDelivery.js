import { Logger } from "../lib/Logger.js";

export class PrizeDelivery {

    static async deliverAll(revealEntries) {
        const results = [];
        for (const entry of revealEntries || []) {
            if (!entry?.prize) continue;
            const outcome = await this.deliver(entry);
            results.push(outcome);
        }
        return results;
    }

    static async deliver(entry) {
        const prize = entry.prize;
        const user = game.users.get(entry.userId);
        const actor = this._resolveActor(user);
        const outcome = {
            userId: entry.userId,
            name: entry.name,
            label: prize.label,
            type: prize.type || "text",
            delivered: false,
            note: ""
        };

        try {
            const notes = [];
            const gold = Number(prize.gold) || 0;
            if (gold > 0) {
                const goldOut = await this._deliverGold(actor, gold, entry.name);
                notes.push(goldOut.note);
                if (goldOut.delivered) outcome.delivered = true;
            }
            const itemUuids = this._prizeItemUuids(prize);
            for (const uuid of itemUuids) {
                const itemOut = await this._deliverItem(actor, uuid, entry.name);
                notes.push(itemOut.note);
                if (itemOut.delivered) outcome.delivered = true;
            }
            if (!notes.length) {
                outcome.delivered = true;
                notes.push(prize.label || "Prize noted");
            }
            outcome.note = notes.filter(Boolean).join("; ");
        } catch (err) {
            Logger.warn("Prize delivery failed:", err.message);
            outcome.note = `Delivery failed: ${err.message}`;
        }

        return outcome;
    }

    static async _deliverGold(actor, gold, fallbackName) {
        if (actor?.system?.currency) {
            const gp = Number(actor.system.currency.gp ?? 0);
            await actor.update({ "system.currency.gp": gp + gold });
            return { delivered: true, note: `+${gold} gp to ${actor.name}` };
        }
        return { delivered: false, note: `Award ${gold} gp to ${fallbackName} (no character currency found)` };
    }

    static async _deliverItem(actor, itemUuid, fallbackName) {
        if (!actor) {
            return { delivered: false, note: `Give item ${itemUuid} to ${fallbackName} (no character linked)` };
        }
        const doc = await fromUuid(itemUuid);
        if (!doc) {
            return { delivered: false, note: `Item not found: ${itemUuid}` };
        }
        const data = doc.toObject();
        delete data._id;
        const existing = actor.items.find(
            i => i.name === data.name && i.type === data.type
        );
        if (existing && typeof existing.system?.quantity === "number") {
            const qty = existing.system.quantity + 1;
            await existing.update({ "system.quantity": qty });
            return { delivered: true, note: `${doc.name} stacked on ${actor.name} (qty ${qty})` };
        }
        // guardAll validates and normalises in place; it has no return value.
        const minting = game.ionrift?.library?.minting;
        if (minting?.guardAll) minting.guardAll([data], { moduleId: "ionrift-quiz-night", mode: "create" });
        const created = await actor.createEmbeddedDocuments("Item", [data]);
        if (!created?.length) {
            return { delivered: false, note: `Could not add ${doc.name} to ${actor.name}` };
        }
        return { delivered: true, note: `${doc.name} added to ${actor.name}` };
    }

    static _prizeItemUuids(prize) {
        return this._prizeItemEntries(prize).map(entry => entry.uuid);
    }

    static _prizeItemEntries(prize) {
        const seen = new Set();
        const entries = [];
        const legacyMystery = !!prize?.mystery;
        const push = (entry) => {
            const uuid = typeof entry === "string" ? entry.trim() : String(entry?.uuid || "").trim();
            if (!uuid || seen.has(uuid)) return;
            seen.add(uuid);
            const ownMystery = typeof entry?.mystery === "boolean";
            entries.push({
                uuid,
                name: typeof entry?.name === "string" ? entry.name : "",
                img: typeof entry?.img === "string" ? entry.img : "",
                mystery: ownMystery ? !!entry.mystery : legacyMystery
            });
        };
        for (const entry of prize?.items || []) push(entry);
        if (typeof prize?.itemUuid === "string") push(prize.itemUuid);
        return entries;
    }

    static _resolveActor(user) {
        if (!user) return null;
        if (user.character) return user.character;
        const owned = game.actors?.filter(a => a.type === "character" && a.testUserPermission?.(user, "OWNER")) || [];
        return owned[0] || null;
    }

    static formatChatSummary(outcomes) {
        if (!outcomes?.length) return "";
        let html = `<h4><i class="fas fa-gift"></i> Prize Delivery</h4><ul>`;
        for (const o of outcomes) {
            const mark = o.delivered ? "✓" : "!";
            html += `<li><strong>${o.name}</strong>: ${o.label} (${mark} ${o.note})</li>`;
        }
        html += `</ul>`;
        return html;
    }

    static PRIZE_ART = {
        gold: "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp",
        text: "icons/svg/item-bag.svg",
        mystery: "icons/svg/mystery-man.svg",
        item: "icons/svg/item-bag.svg"
    };

    static TIER_ORDER = ["first", "second", "consolation"];

    static TIER_LABELS = {
        first: "1st",
        second: "2nd",
        consolation: "Everyone"
    };

    static async enrichPrize(prize, { revealMystery = false } = {}) {
        const raw = prize || {};
        const gold = Number(raw.gold) || 0;
        const entries = this._prizeItemEntries(raw);
        const goldMystery = gold > 0 && !revealMystery && (
            typeof raw.goldMystery === "boolean" ? raw.goldMystery : !!raw.mystery
        );
        const hideLabel = gold === 0 && entries.length === 0 && !!raw.mystery && !revealMystery;
        const enriched = {
            label: hideLabel ? "???" : (raw.label || "Prize"),
            mystery: false,
            type: raw.type || "text",
            gold,
            goldMystery,
            goldLabel: gold > 0 && !goldMystery ? `${gold} gp` : "",
            itemUuid: "",
            itemName: "",
            items: [],
            img: gold > 0 && !goldMystery ? this.PRIZE_ART.gold : this.PRIZE_ART.text,
            inspectHtml: "",
            canInspect: false
        };

        if (typeof fromUuid === "function") {
            for (const entry of entries) {
                const hidden = !!entry.mystery && !revealMystery;
                if (hidden) {
                    enriched.items.push({
                        uuid: "",
                        name: "???",
                        img: this.PRIZE_ART.mystery,
                        mystery: true,
                        canInspect: false
                    });
                    continue;
                }
                try {
                    const doc = await fromUuid(entry.uuid);
                    enriched.items.push({
                        uuid: doc?.uuid || entry.uuid,
                        name: doc?.name || entry.name || "",
                        img: doc?.img || entry.img || this.PRIZE_ART.item,
                        mystery: false,
                        canInspect: true
                    });
                } catch (err) {
                    Logger.warn("Prize item lookup failed:", err.message);
                    enriched.items.push({
                        uuid: entry.uuid,
                        name: entry.name || "",
                        img: entry.img || this.PRIZE_ART.item,
                        mystery: false,
                        canInspect: true
                    });
                }
            }
        }

        const visible = enriched.items.find(item => !item.mystery);
        const first = visible || enriched.items[0];
        if (first) {
            enriched.itemUuid = first.uuid;
            enriched.itemName = first.name;
            enriched.img = first.img;
            enriched.canInspect = !first.mystery && !!first.uuid;
            if (!raw.label && first.name && !first.mystery) enriched.label = first.name;
        } else if (goldMystery || hideLabel) {
            enriched.img = this.PRIZE_ART.mystery;
        }

        enriched.mystery = hideLabel || goldMystery || enriched.items.some(item => item.mystery);
        if (gold > 0 && entries.length) enriched.type = "bundle";
        else if (entries.length) enriched.type = "item";
        else if (gold > 0) enriched.type = "gold";
        else enriched.type = "text";

        return enriched;
    }

    static async toPlayerPrizeDisplay(prizes) {
        const out = {};
        for (const tier of this.TIER_ORDER) {
            const prize = prizes?.[tier];
            if (!prize) continue;
            out[tier] = {
                tier,
                tierLabel: this.TIER_LABELS[tier],
                ...await this.enrichPrize(prize)
            };
        }
        return out;
    }

    static toPrizeTierList(prizesMap) {
        return this.TIER_ORDER
            .map(tier => prizesMap?.[tier])
            .filter(Boolean);
    }

    static _escapeHtml(value) {
        return String(value ?? "").replace(/[&<>"']/g, ch => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        }[ch]));
    }

    static renderStakeCard(tier, { sized = false } = {}) {
        const gold = tier.goldLabel
            ? `<span class="pc-gold"><i class="fas fa-coins"></i> ${this._escapeHtml(tier.goldLabel)}</span>`
            : "";
        const sizeAttr = sized
            ? ` width="32" height="32" style="width:32px;height:32px;max-width:32px;max-height:32px"`
            : "";
        const thumbs = tier.items?.length
            ? tier.items
            : [{
                uuid: tier.itemUuid,
                name: tier.itemName || tier.label,
                img: tier.img || this.PRIZE_ART.text,
                mystery: !!tier.mystery && !tier.goldLabel && !tier.items?.length,
                inspect: tier.canInspect && tier.itemUuid
            }];
        const artInner = thumbs.map(item => {
            const safeImg = this._escapeHtml(item.img || this.PRIZE_ART.text);
            const inspect = !item.mystery && (item.inspect ?? (item.canInspect && item.uuid) ?? (tier.canInspect && item.uuid));
            return inspect
                ? `<button type="button" class="prize-item-link" data-prize-uuid="${this._escapeHtml(item.uuid)}" data-tooltip="${this._escapeHtml(item.name || tier.label)}"><img src="${safeImg}" alt=""${sizeAttr} /></button>`
                : `<img src="${safeImg}" alt=""${sizeAttr} />`;
        }).join("");
        const mystery = tier.mystery ? " mystery" : "";
        return `<div class="prize-card ${this._escapeHtml(tier.tier || "")} ${this._escapeHtml(tier.type || "text")}${mystery}">
            <span class="pc-tier">${this._escapeHtml(tier.tierLabel || "")}</span>
            <div class="pc-body">
                <span class="pc-label">${this._escapeHtml(tier.label || "Prize")}</span>
                ${gold}
            </div>
            <div class="pc-art${thumbs.length > 1 ? " pc-art-stack" : ""}">${artInner}</div>
        </div>`;
    }

    static formatStartAnnouncement(quizName, prizesMap) {
        const cards = this.toPrizeTierList(prizesMap).map(t => this.renderStakeCard(t, { sized: true })).join("");
        return `<h3><i class="fas fa-trophy"></i> Quiz Night</h3>
            <p><strong>${this._escapeHtml(quizName)}</strong> is about to begin.</p>
            <p>Stakes:</p>
            <div class="prize-card-row prize-stakes">${cards}</div>`;
    }

    static async enrichRevealCards(revealEntries) {
        const cards = [];
        for (const entry of revealEntries || []) {
            cards.push({
                rank: entry.rank,
                userId: entry.userId,
                name: entry.name,
                color: entry.color,
                score: entry.score,
                correct: entry.correct,
                total: entry.total,
                prize: entry.prize
                    ? await this.enrichPrize(entry.prize, { revealMystery: true })
                    : null
            });
        }
        return cards;
    }

    static sanitizePrizeArt(root) {
        root?.querySelectorAll?.(".pc-art, .prc-art").forEach(art => {
            art.querySelectorAll("a, .content-link, [data-link], [data-uuid]").forEach(el => {
                el.classList.remove("content-link");
                delete el.dataset.link;
                delete el.dataset.uuid;
                delete el.dataset.type;
                if (el.tagName === "A") {
                    el.removeAttribute("href");
                    el.setAttribute("role", "presentation");
                }
            });
        });
    }

    static bindPrizeInspect(root) {
        this.sanitizePrizeArt(root);
        root?.querySelectorAll?.(".prize-item-link[data-prize-uuid]").forEach(el => {
            if (el.dataset.inspectBound) return;
            el.dataset.inspectBound = "1";
            el.addEventListener("click", async ev => {
                ev.preventDefault();
                ev.stopPropagation();
                const doc = await fromUuid(el.dataset.prizeUuid);
                doc?.sheet?.render(true);
            });
        });
    }
}
