// Normalized dataset model built from network.json + ops.json.
// Pure TS, no Spacetime imports. Every ID, count and limit comes from the files.

export interface Well {
  id: string;
  facilityId: string;
  systemId: string;
  baselineWaterBpd: number;
  oilBpd: number;
  gasMcfd: number;
  /** oil_bpd * oil price + gas_mcfd * gas price, per hour */
  revenuePerHour: number;
}

export interface Facility {
  id: string;
  systemId: string;
  lat: number;
  lon: number;
  wells: Well[];
  tankId: string;
  capacityBbl: number;
  pumpId: string;
  maxFlowBpd: number;
  startLevelPct: number;
  stopLevelPct: number;
  pipelineId: string;
  pipelineMaxBpd: number;
  pipelineMaxPressurePsi: number;
  responseMin: number;
  cycleMin: number;
  /** sum of wells' revenuePerHour */
  revenuePerHour: number;
  /** sum of wells' baseline_water_bpd */
  baselineInflowBpd: number;
}

export interface SystemInfo {
  id: string;
  centerLat: number;
  centerLon: number;
  yardLat: number;
  yardLon: number;
  disposalId: string;
  disposalLat: number;
  disposalLon: number;
  disposalPressurePsi: number;
  fleetSize: number;
  facilityIds: string[];
}

export interface DatasetModel {
  systems: SystemInfo[];
  facilities: Facility[];
  wells: Well[];
  warningPct: number;
  shutdownPct: number;
  oilPerBbl: number;
  gasPerMcf: number;
  repairHoursPumpFailure: number;
  truckCapacityBbl: number;
  costPerTrip: number;
  opsDatasetId: string;
  /** lookup helpers */
  facilityById: Map<string, Facility>;
  systemById: Map<string, SystemInfo>;
  wellById: Map<string, Well>;
  /** assetId -> facility (for wells, tank, pump, pipeline, facility itself) */
  facilityByAsset: Map<string, Facility>;
}

export type AssetType = 'facility' | 'well' | 'tank' | 'pump' | 'pipeline';

export class DatasetError extends Error {}

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new DatasetError(`${path}: expected number, got ${JSON.stringify(v)}`);
  return v;
}
function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new DatasetError(`${path}: expected non-empty string`);
  return v;
}
function obj(v: unknown, path: string): Record<string, any> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new DatasetError(`${path}: expected object`);
  return v as Record<string, any>;
}
function arr(v: unknown, path: string): any[] {
  if (!Array.isArray(v)) throw new DatasetError(`${path}: expected array`);
  return v;
}
function latlon(v: unknown, path: string): [number, number] {
  const a = arr(v, path);
  if (a.length < 2) throw new DatasetError(`${path}: expected [lat, lon]`);
  return [num(a[0], `${path}[0]`), num(a[1], `${path}[1]`)];
}

/** Parse + validate network.json and ops.json (as parsed JSON values). */
export function buildModel(networkRaw: unknown, opsRaw: unknown): DatasetModel {
  const net = obj(networkRaw, 'network');
  const ops = obj(opsRaw, 'ops');
  const limits = obj(obj(net.defaults, 'network.defaults').tank_limits_pct, 'network.defaults.tank_limits_pct');
  const prices = obj(ops.prices, 'ops.prices');
  const oilPerBbl = num(prices.oil_per_bbl, 'ops.prices.oil_per_bbl');
  const gasPerMcf = num(prices.gas_per_mcf, 'ops.prices.gas_per_mcf');
  const trucking = obj(ops.emergency_trucking, 'ops.emergency_trucking');
  const opsSystems = obj(ops.systems, 'ops.systems');

  const systems: SystemInfo[] = [];
  const facilities: Facility[] = [];
  const wells: Well[] = [];

  arr(net.systems, 'network.systems').forEach((sRaw, si) => {
    const sp = `network.systems[${si}]`;
    const s = obj(sRaw, sp);
    const sid = str(s.id, `${sp}.id`);
    const center = latlon(s.center, `${sp}.center`);
    const yard = latlon(s.truck_yard, `${sp}.truck_yard`);
    const disp = obj(s.disposal_site, `${sp}.disposal_site`);
    const opsSys = obj(opsSystems[sid], `ops.systems.${sid}`);
    const opsFacs = obj(opsSys.facilities, `ops.systems.${sid}.facilities`);
    const facilityIds: string[] = [];
    arr(s.facilities, `${sp}.facilities`).forEach((fRaw, fi) => {
      const fp = `${sp}.facilities[${fi}]`;
      const f = obj(fRaw, fp);
      const fid = str(f.id, `${fp}.id`);
      const tank = obj(f.tank, `${fp}.tank`);
      const pump = obj(f.pump, `${fp}.pump`);
      const pipe = obj(f.pipeline, `${fp}.pipeline`);
      const opsF = obj(opsFacs[fid], `ops.systems.${sid}.facilities.${fid}`);
      const fWells: Well[] = arr(f.wells, `${fp}.wells`).map((wRaw, wi) => {
        const wp = `${fp}.wells[${wi}]`;
        const w = obj(wRaw, wp);
        const oil = num(w.oil_bpd, `${wp}.oil_bpd`);
        const gas = num(w.gas_mcfd, `${wp}.gas_mcfd`);
        return {
          id: str(w.id, `${wp}.id`),
          facilityId: fid,
          systemId: sid,
          baselineWaterBpd: num(w.baseline_water_bpd, `${wp}.baseline_water_bpd`),
          oilBpd: oil,
          gasMcfd: gas,
          revenuePerHour: (oil * oilPerBbl + gas * gasPerMcf) / 24,
        };
      });
      const fac: Facility = {
        id: fid,
        systemId: sid,
        lat: num(f.lat, `${fp}.lat`),
        lon: num(f.lon, `${fp}.lon`),
        wells: fWells,
        tankId: str(tank.id, `${fp}.tank.id`),
        capacityBbl: num(tank.capacity_bbl, `${fp}.tank.capacity_bbl`),
        pumpId: str(pump.id, `${fp}.pump.id`),
        maxFlowBpd: num(pump.max_flow_bpd, `${fp}.pump.max_flow_bpd`),
        startLevelPct: num(pump.start_level_pct, `${fp}.pump.start_level_pct`),
        stopLevelPct: num(pump.stop_level_pct, `${fp}.pump.stop_level_pct`),
        pipelineId: str(pipe.id, `${fp}.pipeline.id`),
        pipelineMaxBpd: num(pipe.max_bpd, `${fp}.pipeline.max_bpd`),
        pipelineMaxPressurePsi: num(pipe.max_pressure_psi, `${fp}.pipeline.max_pressure_psi`),
        responseMin: num(opsF.response_min, `ops...${fid}.response_min`),
        cycleMin: num(opsF.cycle_min, `ops...${fid}.cycle_min`),
        revenuePerHour: fWells.reduce((a, w) => a + w.revenuePerHour, 0),
        baselineInflowBpd: fWells.reduce((a, w) => a + w.baselineWaterBpd, 0),
      };
      if (fac.capacityBbl <= 0) throw new DatasetError(`${fp}.tank.capacity_bbl must be > 0`);
      facilities.push(fac);
      wells.push(...fWells);
      facilityIds.push(fid);
    });
    systems.push({
      id: sid,
      centerLat: center[0],
      centerLon: center[1],
      yardLat: yard[0],
      yardLon: yard[1],
      disposalId: str(disp.id, `${sp}.disposal_site.id`),
      disposalLat: num(disp.lat, `${sp}.disposal_site.lat`),
      disposalLon: num(disp.lon, `${sp}.disposal_site.lon`),
      disposalPressurePsi: num(disp.pressure_psi, `${sp}.disposal_site.pressure_psi`),
      fleetSize: num(opsSys.emergency_fleet_size, `ops.systems.${sid}.emergency_fleet_size`),
      facilityIds,
    });
  });

  const facilityById = new Map(facilities.map((f) => [f.id, f]));
  const systemById = new Map(systems.map((s) => [s.id, s]));
  const wellById = new Map(wells.map((w) => [w.id, w]));
  const facilityByAsset = new Map<string, Facility>();
  for (const f of facilities) {
    for (const id of [f.id, f.tankId, f.pumpId, f.pipelineId, ...f.wells.map((w) => w.id)]) {
      if (facilityByAsset.has(id)) throw new DatasetError(`duplicate asset id ${id}`);
      facilityByAsset.set(id, f);
    }
  }
  const repair = obj(ops.expected_repair_hours, 'ops.expected_repair_hours');

  return {
    systems,
    facilities,
    wells,
    warningPct: num(limits.warning, 'network.defaults.tank_limits_pct.warning'),
    shutdownPct: num(limits.shutdown, 'network.defaults.tank_limits_pct.shutdown'),
    oilPerBbl,
    gasPerMcf,
    repairHoursPumpFailure: num(repair.pump_failure, 'ops.expected_repair_hours.pump_failure'),
    truckCapacityBbl: num(trucking.truck_capacity_bbl, 'ops.emergency_trucking.truck_capacity_bbl'),
    costPerTrip: num(trucking.cost_per_trip, 'ops.emergency_trucking.cost_per_trip'),
    opsDatasetId: typeof ops.dataset_id === 'string' ? ops.dataset_id : '',
    facilityById,
    systemById,
    wellById,
    facilityByAsset,
  };
}

export function assetTypeOf(model: DatasetModel, assetId: string): AssetType | null {
  const f = model.facilityByAsset.get(assetId);
  if (!f) return null;
  if (assetId === f.id) return 'facility';
  if (assetId === f.tankId) return 'tank';
  if (assetId === f.pumpId) return 'pump';
  if (assetId === f.pipelineId) return 'pipeline';
  return 'well';
}
