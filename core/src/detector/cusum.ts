// One-sided CUSUM (Page's test) over a stream of per-step scores.
//   s_t = max(0, s_{t-1} + x_t - k)
// `startIdx` is where the current excursion began (s rose from 0): the classic
// change-point estimate. `onsetIdx` is the first step of the excursion where s reached
// `onsetLevel`, a less noise-sensitive estimate for abrupt changes.
export class Cusum {
  s = 0;
  startIdx: number | null = null;
  onsetIdx: number | null = null;

  constructor(
    private readonly k: number,
    private readonly onsetLevel: number,
  ) {}

  update(x: number, i: number): void {
    const next = this.s + x - this.k;
    if (next <= 0) {
      this.reset();
      return;
    }
    if (this.s === 0) this.startIdx = i;
    this.s = next;
    if (this.onsetIdx === null && this.s >= this.onsetLevel) this.onsetIdx = i;
  }

  reset(): void {
    this.s = 0;
    this.startIdx = null;
    this.onsetIdx = null;
  }
}
