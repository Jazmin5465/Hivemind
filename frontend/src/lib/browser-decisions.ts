import { z } from 'zod';
import { datasetNow } from './hive-data';
import { decisionPlans, priorityQueue, type PlanKey } from './operations';

export const decisionStorageKey = 'hivemind.decisions.v1';
const decisionSchema = z.object({
  id: z.string(), created_at: z.string(), dataset_ts: z.number(),
  queue_id: z.string(), facility: z.string(), option_key: z.string(),
  title: z.string(), detail: z.string(), estimated_cost: z.number(),
});
export type BrowserDecision = z.infer<typeof decisionSchema>;

export function readBrowserDecisions(storage: Pick<Storage, 'getItem'>): BrowserDecision[] {
  const raw = storage.getItem(decisionStorageKey);
  return raw ? z.array(decisionSchema).parse(JSON.parse(raw)) : [];
}

export function saveBrowserDecision(storage: Pick<Storage, 'getItem' | 'setItem'>, queueId: string, optionKey: PlanKey): BrowserDecision[] {
  const item = priorityQueue.find(q => q.id === queueId);
  if (!item) throw new Error('This forecast is no longer available');
  const plan = decisionPlans(item).find(p => p.key === optionKey);
  if (!plan) throw new Error('This option is unavailable');
  const existing = readBrowserDecisions(storage);
  if (existing.some(d => d.queue_id === queueId)) throw new Error('A decision was already submitted for this item');
  const row: BrowserDecision = {
    id: crypto.randomUUID(), created_at: new Date().toISOString(), dataset_ts: datasetNow,
    queue_id: item.id, facility: item.facility, option_key: plan.key,
    title: `${item.facility} · ${plan.label}`,
    detail: `${item.scenario ? 'Outage contingency selected (not a live dispatch). ' : 'Operator action recorded (execution not confirmed). '}${plan.detail}`,
    estimated_cost: plan.cost,
  };
  const rows = [row, ...existing];
  storage.setItem(decisionStorageKey, JSON.stringify(rows));
  return rows;
}