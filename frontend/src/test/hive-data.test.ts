import { describe, it, expect } from 'vitest';
import {datasetNow, detectedEvents, incidents, facilityReadings, fleets, thresholds, operatingCosts, sensorProblem, hoursToLimit, revenuePerHour} from '@/lib/hive-data';

describe('Supplied operational dataset', () => {
  it('uses the final sensor timestamp as now', () => expect(datasetNow).toBe(1791762900));
  it('uses the supplied 85% warning threshold', () => expect(thresholds.warning).toBe(85));
  it('uses the supplied 92% shutdown threshold', () => expect(thresholds.shutdown).toBe(92));
  it('prices each emergency trip at $905', () => expect(operatingCosts.emergency_trucking.cost_per_trip).toBe(905));
  it('limits each truck trip to 150 bbl', () => expect(operatingCosts.emergency_trucking.truck_capacity_bbl).toBe(150));
  it('uses a six-hour expected failure repair', () => expect(operatingCosts.expected_repair_hours.pump_failure).toBe(6));
  it('uses the supplied system fleet capacities', () => expect(fleets.map(f => f.trucks)).toEqual([2, 2, 3, 2, 2]));
  it('calculates revenue with $60 oil and $3 gas', () => expect(revenuePerHour([{oil_bpd: 24, gas_mcfd: 24}])).toBe(63));
  it('forecasts remaining tank headroom in hours', () => expect(hoursToLimit(50, 1200, 2400)).toBeCloseTo(5.04));
  it('does not classify an off-cycle pump as a failure', () => expect(sensorProblem([60, 0, 0, 0], 3000).pump_failure).toBe(false));
  it('detects an explicit failed status', () => expect(sensorProblem([60, 2, 0, 0], 3000).pump_failure).toBe(true));
  it('detects all thirteen failed-pump episodes from telemetry', () => expect(detectedEvents.filter(e => e.category === 'pump_failure')).toHaveLength(13));
  it('does not invent active incidents in the completed week', () => expect(incidents).toHaveLength(0));
  it('imports the final tank reading without rounding', () => expect(facilityReadings.find(f => f.tank.id === 'S1_TANK_A')?.readings[0]).toBe(48.69));
});