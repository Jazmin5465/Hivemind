// Fake SpacetimeDB rows for tests. Shapes match src/module_bindings/types.ts.
import { emptyLive, type LiveData } from '@/lib/live/store';

export const NOW = 1_791_460_800; // 10-08 12:00 UTC
export const ME = 'aa11';
export const identity = (hex: string) => ({ toHexString: () => hex, isEqual: (o: { toHexString(): string }) => o.toHexString() === hex }) as never;
export const ts = (micros: bigint) => ({ microsSinceUnixEpoch: micros }) as never;

const DS = 'fixture';

export function system(id: string, yardLat = 32, yardLon = -102, extra: Record<string, unknown> = {}) {
  return { key: `${DS}/${id}`, datasetId: DS, systemId: id, centerLat: yardLat, centerLon: yardLon, yardLat, yardLon, disposalId: `${id}_DISPOSAL`, disposalLat: yardLat + 0.1, disposalLon: yardLon + 0.1, disposalPressurePsi: 1000, ...extra } as never;
}
export function facility(id: string, systemId: string, extra: Record<string, unknown> = {}) {
  const s = id.split('_').at(-1);
  return {
    key: `${DS}/${id}`, datasetId: DS, facilityId: id, systemId, lat: 32, lon: -102, tankId: `${systemId}_TANK_${s}`, capacityBbl: 1200,
    pumpId: `${systemId}_PUMP_${s}`, maxFlowBpd: 3000, startLevelPct: 70, stopLevelPct: 30, pipelineId: `${systemId}_PIPELINE_${s}`,
    pipelineMaxBpd: 3500, pipelineMaxPressurePsi: 1700, baselineInflowBpd: 2400, revenuePerHour: 3000, ...extra,
  } as never;
}
export function state(facilityId: string, systemId: string, levelPct: number, inflowBpd: number, extra: Record<string, unknown> = {}) {
  return {
    key: `${DS}/${facilityId}`, datasetId: DS, facilityId, systemId, asOfUnix: NOW, levelPct, inflowBpd, pumpStatus: 1, pumpFlowBpd: 3000,
    dischargePsi: 1150, receiveFlowBpd: 3000, pipelinePressurePsi: 1050, wellsProducing: 1, wellsTotal: 1, health: 'ok',
    wellIds: [], wellStatus: [], wellWaterBpd: [], ...extra,
  } as never;
}
export function event(id: string, facilityId: string, systemId: string, category: string, extra: Record<string, unknown> = {}) {
  return {
    eventId: id, datasetId: DS, systemId, facilityId, assetId: category === 'pipeline_leak' ? `${facilityId}_PIPE` : `${facilityId}_PUMP`,
    category, status: 'ongoing', onsetUnix: NOW - 3600, endUnix: undefined, confidence: 0.9, source: 'rules',
    hoursToLimitP50: category === 'pump_failure' ? 2 : undefined, hoursToLimitP10: undefined, hoursToLimitP90: undefined,
    levelPct: undefined, tripsAtUnix: undefined, repairEndUnix: category === 'pump_failure' ? NOW + 5 * 3600 : undefined,
    lostRevenuePerHour: 3000, alertRank: 1, action: category === 'pump_failure' ? 'plan' : 'field_inspection', planId: undefined, asOfUnix: NOW, ...extra,
  } as never;
}
export function plan(planId: bigint, systemId: string, extra: Record<string, unknown> = {}) {
  return {
    planId, datasetId: DS, systemId, eventIds: [], origin: 'option', status: 'proposed', planStartUnix: NOW, totalCost: 905, doNothingCost: 5000,
    fleetSize: 2, trucksAvailable: 2, valid: true, validationErrors: [], summary: '', rationale: '', overrides: undefined,
    createdBy: identity(ME), createdAt: ts(1n), approvedBy: undefined, approvedAt: undefined, agentRunId: undefined, searchMs: 1,
    optionKey: 'optimal', scenarioFacilityId: '', ...extra,
  } as never;
}
export function action(planId: bigint, facilityId: string, type: string, extra: Record<string, unknown> = {}) {
  return { id: planId * 10n, planId, datasetId: DS, eventId: '', facilityId, type, trucks: 0, tripsPerTruck: 0, wells: [], startAfterMin: 0, assetId: '', ...extra } as never;
}
export function planFacility(planId: bigint, facilityId: string, extra: Record<string, unknown> = {}) {
  return {
    id: planId * 10n, planId, eventId: '', facilityId, cost: 905, truckCost: 905, shutInCost: 0, tripCost: 0, doNothingCost: 5000,
    tripsAtUnix: undefined, tripsAtUnixIfNothing: NOW + 7200, peakLevelPct: 80, repairEndUnix: NOW + 5 * 3600, levelAtStartPct: 60,
    alreadyTripped: false, wellsOff: [], truckArrivalsUnix: [NOW + 75 * 60], truckFreeAtUnix: [NOW + 305 * 60], traceT0: NOW, traceStepSec: 300,
    levelTrace: [], summary: '1 truck, 1 trip', ...extra,
  } as never;
}
export function decision(id: bigint, eventId: string, kind: string, extra: Record<string, unknown> = {}) {
  return {
    id, datasetId: DS, eventId, systemId: 'S1', facilityId: '', kind, optionKey: 'optimal', planId: undefined, title: 't', detail: 'd',
    estimatedCost: 0, status: 'active', decidedBy: identity(ME), operatorName: 'op', asOfUnix: NOW, createdAt: ts(2n), ...extra,
  } as never;
}
export function sweep(systemId: string, fleetSize: number, totalCost: number, isCurrent: boolean) {
  return { key: `${DS}/${systemId}/${fleetSize}`, datasetId: DS, systemId, fleetSize, isCurrent, failures: 3, totalCost, trips: 0, truckTrips: 0, wellsShutIn: 0, asOfUnix: NOW } as never;
}

/** a ready snapshot with sensible defaults; override any table */
export function liveData(over: Partial<LiveData> = {}): LiveData {
  return {
    ...emptyLive,
    status: 'connected',
    identity: ME,
    ready: true,
    dataset: { datasetId: DS, source: '/x', status: 'ready', error: '', tStart: NOW - 86400, tEnd: NOW, stepSec: 300, nSteps: 289, seriesCount: 1, rowCount: 1, active: true, loadVersion: 1, loadedAt: ts(0n), detector: 'rules' } as never,
    clock: { datasetId: DS, nowUnix: NOW, playing: false, speed: 300, carrySec: 0, computedForUnix: NOW, computeMs: 1 } as never,
    opsConfig: { datasetId: DS, oilPerBbl: 60, gasPerMcf: 3, repairHoursPumpFailure: 6, truckCapacityBbl: 150, costPerTrip: 905, warningPct: 85, shutdownPct: 92 } as never,
    ...over,
  };
}
