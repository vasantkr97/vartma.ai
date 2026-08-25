export class ManualClock {
  constructor(milliseconds = 0) {
    this.milliseconds = milliseconds;
  }
  now() {
    return this.milliseconds;
  }
  advance(milliseconds) {
    this.milliseconds += milliseconds;
  }
}
