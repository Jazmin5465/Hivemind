// Live SpacetimeDB data for the console. One connection; global tables (dataset, clock, operators)
// plus every table of the ACTIVE dataset, re-subscribed whenever the active dataset changes.
// Components read an immutable snapshot through useLive() (src/components/LiveProvider.tsx).
// Browser only: never constructed during SSR.
import { DbConnection, type SubscriptionHandle } from '@/module_bindings';
import type {
  Dataset, Decision, Event, EventEvidence, Facility, FacilityState, FleetSweep, Operator, OpsConfig, OpsFacility,
  OpsSystem, Plan, PlanAction, PlanFacility, SimClock, System, Well,
} from '@/module_bindings/types';

export interface LiveData {
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  error: string;
  /** this browser's identity (hex), for "my" plan options */
  identity: string;
  datasets: Dataset[];
  /** the dataset the console shows (dataset.active), if any */
  dataset: Dataset | undefined;
  clock: SimClock | undefined;
  operators: Operator[];
  systems: System[];
  facilities: Facility[];
  wells: Well[];
  opsConfig: OpsConfig | undefined;
  opsSystems: OpsSystem[];
  opsFacilities: OpsFacility[];
  facilityStates: FacilityState[];
  events: Event[];
  evidence: EventEvidence[];
  plans: Plan[];
  planActions: PlanAction[];
  planFacilities: PlanFacility[];
  decisions: Decision[];
  fleetSweep: FleetSweep[];
  /** true once the active dataset's tables have arrived */
  ready: boolean;
}

export const emptyLive: LiveData = {
  status: 'connecting', error: '', identity: '', datasets: [], dataset: undefined, clock: undefined, operators: [],
  systems: [], facilities: [], wells: [], opsConfig: undefined, opsSystems: [], opsFacilities: [], facilityStates: [],
  events: [], evidence: [], plans: [], planActions: [], planFacilities: [], decisions: [], fleetSweep: [], ready: false,
};

const TOKEN_KEY = 'hivemind.stdb_token';
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
export const SPACETIME_URI = env['VITE_SPACETIME_URI'] || 'ws://127.0.0.1:3000';
export const SPACETIME_DB = env['VITE_SPACETIME_DB'] || 'hivemind';

/** SQL string literal (dataset ids come from the backend, but quote defensively). */
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

function datasetQueries(ds: string): string[] {
  const d = lit(ds);
  return [
    `SELECT * FROM system WHERE dataset_id = ${d}`,
    `SELECT * FROM facility WHERE dataset_id = ${d}`,
    `SELECT * FROM well WHERE dataset_id = ${d}`,
    `SELECT * FROM ops_config WHERE dataset_id = ${d}`,
    `SELECT * FROM ops_system WHERE dataset_id = ${d}`,
    `SELECT * FROM ops_facility WHERE dataset_id = ${d}`,
    `SELECT * FROM facility_state WHERE dataset_id = ${d}`,
    `SELECT * FROM event WHERE dataset_id = ${d}`,
    `SELECT * FROM event_evidence WHERE dataset_id = ${d}`,
    `SELECT * FROM plan WHERE dataset_id = ${d}`,
    `SELECT * FROM plan_action WHERE dataset_id = ${d}`,
    // plan_facility has no dataset column; it's small (a few rows per plan)
    `SELECT * FROM plan_facility`,
    `SELECT * FROM decision WHERE dataset_id = ${d}`,
    `SELECT * FROM fleet_sweep WHERE dataset_id = ${d}`,
  ];
}

// table accessors on conn.db that the console reads
const TABLES = [
  'dataset', 'simClock', 'operator', 'system', 'facility', 'well', 'opsConfig', 'opsSystem', 'opsFacility',
  'facilityState', 'event', 'eventEvidence', 'plan', 'planAction', 'planFacility', 'decision', 'fleetSweep',
] as const;

type Listener = () => void;

export class LiveStore {
  private conn: DbConnection | null = null;
  private snapshot: LiveData = emptyLive;
  private listeners = new Set<Listener>();
  private dsHandle: SubscriptionHandle | null = null;
  private subscribedDs: string | null = null;
  private dsReady = false;
  private scheduled = false;
  private status: LiveData['status'] = 'connecting';
  private error = '';
  private identity = '';

  constructor(private uri = SPACETIME_URI, private db = SPACETIME_DB) {}

  start() {
    if (this.conn) return;
    let token: string | undefined;
    try {
      token = window.localStorage.getItem(TOKEN_KEY) ?? undefined;
    } catch {
      token = undefined;
    }
    this.conn = DbConnection.builder()
      .withUri(this.uri)
      .withDatabaseName(this.db)
      .withToken(token)
      .onConnect((conn, identity, tok) => {
        try {
          window.localStorage.setItem(TOKEN_KEY, tok);
        } catch {
          /* storage blocked: a new identity next visit */
        }
        this.identity = identity.toHexString();
        this.status = 'connected';
        this.error = '';
        conn
          .subscriptionBuilder()
          .onApplied(() => this.changed())
          .onError((_ctx: unknown, err?: Error) => this.fail(err?.message ?? 'subscription failed'))
          .subscribe(['SELECT * FROM dataset', 'SELECT * FROM sim_clock', 'SELECT * FROM operator']);
        this.changed();
      })
      .onConnectError((_ctx, err) => this.fail(`cannot reach SpacetimeDB at ${this.uri}: ${err.message}`))
      .onDisconnect(() => {
        this.status = 'disconnected';
        this.changed();
      })
      .build();
    const db = this.conn.db as unknown as Record<string, { onInsert: (cb: () => void) => void; onDelete: (cb: () => void) => void; onUpdate?: (cb: () => void) => void }>;
    for (const t of TABLES) {
      const tbl = db[t];
      if (!tbl) continue;
      tbl.onInsert(() => this.changed());
      tbl.onDelete(() => this.changed());
      tbl.onUpdate?.(() => this.changed());
    }
  }

  stop() {
    this.conn?.disconnect();
    this.conn = null;
  }

  /** reducer access for actions.ts */
  get reducers() {
    if (!this.conn || this.status !== 'connected') throw new Error('Not connected to the backend yet');
    return this.conn.reducers;
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = () => this.snapshot;

  private fail(msg: string) {
    this.status = 'error';
    this.error = msg;
    this.changed();
  }

  /** coalesce bursts of row callbacks into one snapshot rebuild */
  private changed() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.rebuild();
    });
  }

  private rebuild() {
    const conn = this.conn;
    if (!conn) return;
    const db = conn.db;
    const datasets = [...db.dataset.iter()];
    const active = datasets.find((d) => d.active && d.status === 'ready');
    this.ensureDatasetSubscription(active?.datasetId ?? null);
    const ds = this.subscribedDs;
    const mine = <T extends { datasetId: string }>(rows: Iterable<T>) => (ds ? [...rows].filter((r) => r.datasetId === ds) : []);
    const plans = mine(db.plan.iter());
    const planIds = new Set(plans.map((p) => p.planId));
    this.snapshot = {
      status: this.status,
      error: this.error,
      identity: this.identity,
      datasets,
      dataset: active,
      clock: active ? [...db.simClock.iter()].find((c) => c.datasetId === active.datasetId) : undefined,
      operators: [...db.operator.iter()],
      systems: mine(db.system.iter()),
      facilities: mine(db.facility.iter()),
      wells: mine(db.well.iter()),
      opsConfig: ds ? [...db.opsConfig.iter()].find((o) => o.datasetId === ds) : undefined,
      opsSystems: mine(db.opsSystem.iter()),
      opsFacilities: mine(db.opsFacility.iter()),
      facilityStates: mine(db.facilityState.iter()),
      events: mine(db.event.iter()),
      evidence: mine(db.eventEvidence.iter()),
      plans,
      planActions: mine(db.planAction.iter()),
      planFacilities: [...db.planFacility.iter()].filter((f) => planIds.has(f.planId)),
      decisions: mine(db.decision.iter()),
      fleetSweep: mine(db.fleetSweep.iter()),
      ready: Boolean(active) && this.dsReady && this.subscribedDs === active?.datasetId,
    };
    for (const l of this.listeners) l();
  }

  private ensureDatasetSubscription(ds: string | null) {
    if (!this.conn || ds === this.subscribedDs) return;
    const old = this.dsHandle;
    this.subscribedDs = ds;
    this.dsReady = false;
    this.dsHandle = null;
    if (ds) {
      // subscribe to the new dataset before dropping the old one (no empty flash)
      this.dsHandle = this.conn
        .subscriptionBuilder()
        .onApplied(() => {
          if (this.subscribedDs === ds) this.dsReady = true;
          try {
            old?.unsubscribe();
          } catch {
            /* already ended */
          }
          this.changed();
        })
        .onError((_ctx: unknown, err?: Error) => this.fail(err?.message ?? `subscription for ${ds} failed`))
        .subscribe(datasetQueries(ds));
    } else {
      try {
        old?.unsubscribe();
      } catch {
        /* already ended */
      }
    }
  }
}
