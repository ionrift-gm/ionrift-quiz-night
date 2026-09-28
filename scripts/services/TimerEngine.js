import { Logger } from "../lib/Logger.js";

export class TimerEngine {

    remaining = 0;
    total = 0;
    paused = false;
    _intervalId = null;
    onTick = null;
    onExpire = null;

    start(seconds) {
        this.stop();
        if (seconds <= 0) {
            this.remaining = 0;
            this.total = 0;
            return;
        }

        this.total = seconds;
        this.remaining = seconds;
        this.paused = false;

        this._intervalId = setInterval(() => this._tick(), 1000);
        this._broadcast();
    }

    stop() {
        if (this._intervalId !== null) {
            clearInterval(this._intervalId);
            this._intervalId = null;
        }
        this.remaining = 0;
        this.total = 0;
        this.paused = false;
    }

    extend(seconds) {
        if (seconds <= 0 || !this.active) return;
        this.remaining += seconds;
        this.total += seconds;
        Logger.log(`Timer extended by ${seconds}s. Now ${this.remaining}s remaining.`);
        this._broadcast();
    }

    togglePause() {
        this.paused = !this.paused;
        Logger.log(this.paused ? "Timer paused." : "Timer resumed.");
    }

    get progress() {
        if (this.total <= 0) return 1;
        return this.remaining / this.total;
    }

    get active() {
        return this._intervalId !== null;
    }

    static formatClock(seconds) {
        const total = Math.max(0, Math.floor(Number(seconds) || 0));
        const minutes = Math.floor(total / 60);
        const remainder = total % 60;
        return `${minutes}:${String(remainder).padStart(2, "0")}`;
    }

    _tick() {
        if (this.paused) return;
        this.remaining = Math.max(0, this.remaining - 1);
        this._broadcast();

        if (this.remaining <= 0) {
            this.stop();
            Logger.log("Timer expired.");
            Hooks.callAll("ionrift.quizNight.timerExpired", {
                total: this.total,
                remaining: 0
            });
            if (this.onExpire) this.onExpire();
        }
    }

    _broadcast() {
        if (this.onTick) {
            this.onTick({
                remaining: this.remaining,
                total: this.total,
                progress: this.progress,
                expired: this.remaining <= 0 && this.total > 0
            });
        }
    }
}
