import { buildModel } from '../src/model';

/** The README "Opening Scene" facility (EVENT_9 example), as a one-facility network. */
export function event9Model(opts: { fleet?: number; responseMin?: number; cycleMin?: number } = {}) {
  const network = {
    defaults: { tank_limits_pct: { warning: 85, shutdown: 92 } },
    systems: [
      {
        id: 'SX',
        center: [0, 0],
        truck_yard: [0, 0],
        disposal_site: { id: 'SX_DISPOSAL', lat: 0, lon: 0, pressure_psi: 1000 },
        facilities: [
          {
            id: 'FAC_C',
            lat: 0,
            lon: 0,
            wells: [
              { id: 'W_C1', baseline_water_bpd: 450, oil_bpd: 560, gas_mcfd: 2000 },
              { id: 'W_C2', baseline_water_bpd: 700, oil_bpd: 170, gas_mcfd: 600 },
              { id: 'W_C3', baseline_water_bpd: 650, oil_bpd: 390, gas_mcfd: 1400 },
            ],
            tank: { id: 'TANK_C', capacity_bbl: 800 },
            pump: { id: 'PUMP_C', max_flow_bpd: 2700, start_level_pct: 70, stop_level_pct: 30 },
            pipeline: { id: 'PIPE_C', max_bpd: 3000, max_pressure_psi: 1550 },
          },
        ],
      },
    ],
  };
  const ops = {
    prices: { oil_per_bbl: 60, gas_per_mcf: 3.0 },
    expected_repair_hours: { pump_failure: 6 },
    emergency_trucking: { truck_capacity_bbl: 150, cost_per_trip: 905 },
    systems: {
      SX: {
        emergency_fleet_size: opts.fleet ?? 2,
        facilities: { FAC_C: { response_min: opts.responseMin ?? 75, cycle_min: opts.cycleMin ?? 230 } },
      },
    },
  };
  return buildModel(network, ops);
}
