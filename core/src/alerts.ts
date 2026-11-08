// Alerts view ordering (SPEC.md): pump failures first by smallest hoursToLimit
// (ties: higher lost revenue per hour first), then leaks and worn pumps.
import type { EventCategory } from './types';

export interface AlertItem {
  key: string;
  category: EventCategory;
  status: 'ongoing' | 'resolved';
  hoursToLimit: number | null;
  lostRevenuePerHour: number;
  onsetUnix: number;
}

/** Returns ongoing alerts in display order. */
export function orderAlerts<T extends AlertItem>(items: T[]): T[] {
  const ongoing = items.filter((i) => i.status === 'ongoing');
  const fails = ongoing.filter((i) => i.category === 'pump_failure');
  const rest = ongoing.filter((i) => i.category !== 'pump_failure');
  const h = (x: T) => (x.hoursToLimit == null ? Infinity : x.hoursToLimit);
  fails.sort((a, b) => h(a) - h(b) || b.lostRevenuePerHour - a.lostRevenuePerHour || a.onsetUnix - b.onsetUnix);
  // leaks before worn pumps (leaks are "urgent" in the README), then by onset
  const rank = (c: EventCategory) => (c === 'pipeline_leak' ? 0 : 1);
  rest.sort((a, b) => rank(a.category) - rank(b.category) || a.onsetUnix - b.onsetUnix);
  return [...fails, ...rest];
}
