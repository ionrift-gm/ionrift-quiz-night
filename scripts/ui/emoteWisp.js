const BURST_FREE_HEAT = 3;
const COOL_RATE_PER_SEC = 1.8;
const MAX_HEAT = 11;
const BASE_INTERVAL_MS = 70;
const BACKOFF_SCALE_MS = 220;
const BACKOFF_EXPONENT = 1.85;
const MAX_INTERVAL_MS = 2400;

const buckets = new Map();

/**
 * Non-linear progressive rate limiter: allows fast bursts for the first few seconds,
 * then tightens the interval exponentially until the user eases off.
 */
export function tryConsumeEmote(key = "default", now = Date.now()) {
    let state = buckets.get(key);
    if (!state) {
        state = { heat: 0, lastDecayAt: now, lastAllowedAt: 0 };
        buckets.set(key, state);
    }

    const dtSec = Math.max(0, (now - state.lastDecayAt) / 1000);
    state.heat = Math.max(0, state.heat - dtSec * COOL_RATE_PER_SEC);
    state.lastDecayAt = now;

    const excess = Math.max(0, state.heat - BURST_FREE_HEAT);
    const minIntervalMs = Math.min(
        MAX_INTERVAL_MS,
        BASE_INTERVAL_MS + Math.pow(excess, BACKOFF_EXPONENT) * BACKOFF_SCALE_MS
    );

    if (state.lastAllowedAt > 0 && (now - state.lastAllowedAt) < minIntervalMs) {
        state.heat = Math.min(MAX_HEAT, state.heat + 0.25);
        return false;
    }

    state.lastAllowedAt = now;
    state.heat = Math.min(MAX_HEAT, state.heat + 1);
    return true;
}

export function resetEmoteThrottle() {
    buckets.clear();
}

/**
 * Render a floating emote wisp inside `.emote-wisp-host`.
 * Returns the formatted emote line when allowed, or `null` when throttled.
 */
export function renderEmoteWisp(rootElement, emote, userName, color = "#ffdc82", doc = globalThis.document) {
    if (!tryConsumeEmote(userName || "default")) return null;

    const line = `${userName} ${emote.label}`;
    const host = rootElement?.querySelector?.(".emote-wisp-host");
    if (!host || !doc?.createElement) return line;

    const wisp = doc.createElement("div");
    wisp.className = "emote-wisp";

    const iconEl = doc.createElement("i");
    iconEl.className = emote.icon;
    iconEl.style.color = color;
    iconEl.style.textShadow = `0 0 8px ${color}`;

    const nameEl = doc.createElement("span");
    nameEl.className = "emote-wisp-name";
    nameEl.textContent = userName;
    nameEl.style.color = color;

    wisp.appendChild(iconEl);
    wisp.appendChild(nameEl);
    wisp.style.left = `${15 + Math.random() * 65}%`;
    host.appendChild(wisp);
    setTimeout(() => wisp.remove(), 3000);

    return line;
}
