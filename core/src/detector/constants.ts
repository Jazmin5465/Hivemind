// Detector constants. Everything here is either documented in the EOG SPEC or a generic,
// network-independent quantity (a ratio, a z-score, a count of 5-minute steps).
// Asset sizes, flows and pressures always come from network.json via DatasetModel.

/** Pump status codes (SPEC: 0 stopped, 1 running, 2 fault). */
export const PUMP_STOPPED = 0;
export const PUMP_RUNNING = 1;
export const PUMP_FAULT = 2;

/** SPEC "Pressure formulas": healthy pipeline pressure = disposal + 50 psi while pumping. */
export const PIPE_RUN_OFFSET_PSI = 50;
/** SPEC "Pressure formulas": healthy discharge pressure = disposal + 150 psi while pumping. */
export const DISCHARGE_RUN_OFFSET_PSI = 150;

// Sensor noise (1 standard deviation per 5-minute reading). Measured on healthy readings:
// relative flow noise ~0.6% of rated flow, receive/pump ratio ~0.8% (two noisy flows),
// pressures ~3 psi. Expressed as ratios / fractions of the documented offsets so they scale.
/** flow_bpd / max_flow_bpd noise */
export const FLOW_NOISE = 0.006;
/** receive_flow_bpd / flow_bpd noise */
export const RECV_NOISE = 0.0085;
/** pipeline pressure noise, as 6% of the documented pipeline run offset (~3 psi) */
export const PIPE_P_NOISE_PSI = 0.06 * PIPE_RUN_OFFSET_PSI;
/** discharge pressure noise, as 2% of the documented discharge run offset (~3 psi) */
export const DISCHARGE_NOISE_PSI = 0.02 * DISCHARGE_RUN_OFFSET_PSI;

/** Evidence strings summarise the last hour of pumping (12 running 5-minute steps). */
export const EVIDENCE_WINDOW_STEPS = 12;

/**
 * Leak: abrupt drop in both receive/pump ratio and pipeline pressure while pumping.
 * All values are in units of the combined per-step z-score.
 */
export const LEAK = {
  /** CUSUM reference: half of the smallest leak shift we want to catch fast (~4 sigma). */
  K: 2,
  /** Alarm level: ~5 steps (25 min) for a typical leak, negligible false-alarm rate. */
  H: 15,
  /** Onset = first step where the CUSUM reaches this (one clearly abnormal step). */
  ONSET_LEVEL: 3,
  /** Both symptoms must agree on the confirmation window (mean z of each component). */
  MIN_MEAN_Z_EACH: 1.5,
  CONFIRM_WINDOW_STEPS: 6,
  /** Recovery: healthy steps add K_END each; end when the recovery CUSUM reaches H_END. */
  K_END: 2,
  H_END: 12,
  /** One outlier reading can't count for more than this many sigma. */
  Z_CLIP: 8,
  /** confidence = 1 - exp(-meanZ / CONF_SCALE), clamped */
  CONF_SCALE: 4,
  CONF_MIN: 0.5,
  CONF_MAX: 0.99,
} as const;

/**
 * Degradation: slow decline of flow / rated flow and of discharge pressure while pumping.
 */
export const DEG = {
  /** Low reference so a slow drift accumulates early (detects ~1 sigma mean shifts). */
  K: 0.5,
  /** Alarm level of the CUSUM. */
  H: 14,
  /** Flow itself must be down on the confirmation window (a worn pump "moves less water"). */
  MIN_MEAN_Z_FLOW: 1,
  CONFIRM_WINDOW_STEPS: 12,
  /** Recovery: healthy steps add K_END each; end when the recovery CUSUM reaches H_END. */
  K_END: 1,
  H_END: 12,
  Z_CLIP: 6,
  CONF_SCALE: 3,
  CONF_MIN: 0.3,
  CONF_MAX: 0.97,
} as const;
