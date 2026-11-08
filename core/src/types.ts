// Shared event / plan types used by detector, planner, module and worker.

export type EventCategory = 'pump_failure' | 'pipeline_leak' | 'pump_degradation';
export type EventStatus = 'ongoing' | 'resolved';
export type EventSource = 'rules' | 'ml' | 'injected';

export interface DetectedEvent {
  category: EventCategory;
  systemId: string;
  facilityId: string;
  /** pump id for pump_failure / pump_degradation, pipeline id for pipeline_leak */
  assetId: string;
  onsetUnix: number;
  /** null while ongoing */
  endUnix: number | null;
  status: EventStatus;
  /** 0..1 */
  confidence: number;
  source: EventSource;
  /** ranked plain-English reasons, most important first */
  evidence: string[];
}

export type ActionType = 'dispatch_truck' | 'shut_in_wells' | 'field_inspection' | 'none';

export interface PlanAction {
  type: ActionType;
  facilityId?: string;
  trucks?: number;
  tripsPerTruck?: number;
  wells?: string[];
  /** minutes after plan start (shut_in_wells) */
  startAfterMin?: number;
  assetId?: string;
}
