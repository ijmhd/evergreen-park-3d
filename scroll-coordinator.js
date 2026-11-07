/**
 * Coalesces automatic DOM refreshes while any part of the page is scrolling.
 * It owns no DOM, animation frames, or timers: simulation and 3D rendering keep
 * running, and deliberate user actions can render directly without this gate.
 * All supplied times use the injected clock's monotonic millisecond origin.
 */
export class ScrollCoordinator {
  constructor({clock=()=>globalThis.performance?.now()??Date.now(),quietMs=500}={}) {
    if(typeof clock!=='function') throw new TypeError('clock must be a function');
    if(!Number.isFinite(quietMs)||quietMs<0) throw new RangeError('quietMs must be non-negative');
    this.clock=clock;
    this.quietMs=quietMs;
    this._lastActivity=-Infinity;
    this._pointers=new Set();
    this._pending=false;
  }

  get pending() {
    return this._pending;
  }

  _time(now) {
    const value=now??this.clock();
    if(!Number.isFinite(value)) throw new TypeError('time must be a finite number');
    return value;
  }

  // Call for every wheel and captured scroll event, including horizontal chips
  // and inertial scroll events that continue after the finger has lifted.
  activity(now) {
    this._lastActivity=Math.max(this._lastActivity,this._time(now));
  }

  beginInteraction(pointerId=0,now) {
    this._pointers.add(pointerId);
    this.activity(now);
  }

  finishPointer(pointerId=0,now) {
    if(!this._pointers.has(pointerId)) return;
    this._pointers.delete(pointerId);
    this.activity(now);
  }

  shouldDefer(now) {
    return this._pointers.size>0||this._time(now)-this._lastActivity<this.quietMs;
  }

  markPending() {
    this._pending=true;
  }

  // A frame may commit once only after every pointer is released and the last
  // activity has been quiet for quietMs. Further pending refreshes coalesce.
  consumePending(now) {
    if(!this._pending||this.shouldDefer(now)) return false;
    this._pending=false;
    return true;
  }

  // Use on blur/hidden/pointer-capture loss. Preserve work for the next visible
  // frame, while ensuring a missing pointerup cannot leave the UI frozen.
  reset() {
    this._pointers.clear();
    this._lastActivity=-Infinity;
  }
}
