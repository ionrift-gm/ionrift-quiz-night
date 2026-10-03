/**
 * Prize ceremony state: which placings have been revealed, and which prizes
 * have been handed out. Prizes are only delivered once their card is shown.
 *
 * Delivery is claimed at reveal time and persisted before any document is
 * touched, so a quizmaster refresh can never hand the same prize out twice.
 */
export class PrizeCeremony {

    /**
     * @param {object} [data]
     * @param {object[]} [data.reveal] final reveal entries, last place first
     * @param {object[]} [data.cards] enriched cards, same order as reveal
     * @param {number} [data.shown]
     * @param {number[]} [data.claimed] card indexes whose delivery has started
     * @param {object[]} [data.outcomes] delivery outcomes keyed by card index
     * @param {boolean} [data.summaryPosted]
     */
    constructor(data = {}) {
        this.reveal = Array.isArray(data.reveal) ? data.reveal : [];
        this.cards = Array.isArray(data.cards) ? data.cards : [];
        this.shown = Math.max(0, Math.min(Number(data.shown) || 0, this.cards.length));
        this.claimed = Array.isArray(data.claimed) ? [...data.claimed] : [];
        this.outcomes = Array.isArray(data.outcomes) ? [...data.outcomes] : [];
        this.summaryPosted = !!data.summaryPosted;
    }

    /**
     * Rebuild from a persisted session snapshot. Accepts the legacy
     * `ceremonyCards` / `ceremonyShown` fields from older saves.
     * @param {object|null} snapshot
     */
    static fromSnapshot(snapshot) {
        if (!snapshot) return new PrizeCeremony();
        if (snapshot.ceremony) return new PrizeCeremony(snapshot.ceremony);
        const shown = Number(snapshot.ceremonyShown) || 0;
        return new PrizeCeremony({
            reveal: snapshot.finalReveal || [],
            cards: snapshot.ceremonyCards || [],
            shown,
            // Legacy saves delivered everything at end of quiz.
            claimed: (snapshot.ceremonyCards || []).map((_, i) => i),
            summaryPosted: true
        });
    }

    /**
     * True while a persisted snapshot still has placings to reveal or a
     * summary to post. Used to decide whether a refresh should recover.
     * @param {object|null} snapshot
     */
    static isPendingInSnapshot(snapshot) {
        if (!snapshot || snapshot.state !== "quiz-end") return false;
        if (!snapshot.ceremony) return false;
        return !new PrizeCeremony(snapshot.ceremony).isComplete;
    }

    get total() {
        return this.cards.length;
    }

    get hasMore() {
        return this.shown < this.cards.length;
    }

    get visibleCards() {
        return this.cards.slice(0, this.shown);
    }

    get isComplete() {
        return !this.hasMore && this.summaryPosted;
    }

    /**
     * Advance one card and claim its delivery.
     * @returns {{ index: number, card: object, entry: object|null }|null}
     */
    revealNext() {
        if (!this.hasMore) return null;
        const index = this.shown;
        this.shown += 1;
        if (!this.claimed.includes(index)) this.claimed.push(index);
        return { index, card: this.cards[index], entry: this.reveal[index] ?? null };
    }

    /**
     * @param {number} index
     * @param {object} outcome
     */
    recordOutcome(index, outcome) {
        this.outcomes = this.outcomes.filter(o => o.index !== index);
        this.outcomes.push({ ...outcome, index });
    }

    /**
     * Outcomes for every revealed prize in reveal order. A claimed prize with
     * no outcome was interrupted mid-delivery and is flagged for the GM.
     */
    summaryOutcomes() {
        const rows = [];
        for (let i = 0; i < this.shown; i++) {
            const entry = this.reveal[i];
            if (!entry?.prize) continue;
            const outcome = this.outcomes.find(o => o.index === i);
            rows.push(outcome ?? {
                index: i,
                userId: entry.userId,
                name: entry.name,
                label: entry.prize.label,
                type: entry.prize.type || "text",
                delivered: false,
                note: "Delivery was interrupted. Check this prize by hand."
            });
        }
        return rows;
    }

    serialize() {
        return {
            reveal: this.reveal,
            cards: this.cards,
            shown: this.shown,
            claimed: [...this.claimed],
            outcomes: [...this.outcomes],
            summaryPosted: this.summaryPosted
        };
    }
}
