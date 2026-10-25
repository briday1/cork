// Coalesce edits; offline/blocked work waits for resume(), never a polling loop.
export class DriveAutoSaveQueue {
  constructor({save, ready, delay = 2000, now = Date.now, setTimer = (callback, milliseconds) => setTimeout(callback, milliseconds), clearTimer = timer => clearTimeout(timer)}) {
    Object.assign(this, {save, ready, delay, now, setTimer, clearTimer});
    this.pending = new Map(); this.running = false; this.timer = null;
  }

  schedule(id) { this.pending.set(id, this.now() + this.delay); this.resume(); }
  remove(id) { this.pending.delete(id); this.resume(); }

  resume() {
    this.clearTimer(this.timer); this.timer = null;
    if (this.running) return;
    const due = [...this.pending].filter(([id]) => this.ready(id)).map(([, time]) => time);
    if (!due.length) return;
    this.timer = this.setTimer(() => this.flush(), Math.max(0, Math.min(...due) - this.now()));
    this.timer?.unref?.();
  }

  async flush() {
    if (this.running) return;
    this.clearTimer(this.timer); this.timer = null;
    const task = [...this.pending].find(([id, due]) => due <= this.now() && this.ready(id));
    if (!task) return this.resume();
    this.pending.delete(task[0]); this.running = true;
    try { await this.save(task[0]); }
    finally { this.running = false; this.resume(); }
  }
}
