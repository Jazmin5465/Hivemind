"""POST /fixes: several costed ways to fix each predicted event (see ml/PLAN.md,
"Fixing predicted events").

Events come from the LightGBM detector (detector.detect). Pump-failure costs come from
the backend's exact planner (core/src/planner.ts) through ml/fixes/bridge.ts, so they
match the console's plans. This module builds the response shape:

    {"eventId": str, "fixes": [{"fixDescription": str, "predictedSequence": [str],
                                "cost": number, "costReasoning": str}]}

Every number and time in the text is computed here from the planner output and the
dataset files. Nothing reads answer_key.json.
"""
import json
import shutil
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

import detector

REPO = Path(__file__).resolve().parents[1]
BRIDGE = Path(__file__).resolve().parent / "fixes" / "bridge.ts"
STEP = 300
THR = 0.5
MIN_STEPS = {"pump_failure": 3, "pipeline_leak": 6, "pump_degradation": 6}   # 15 / 30 / 30 min
MERGE_GAP_STEPS = 6                                                          # join dips up to 30 min
CLASS_TO_CAT = {"failure": "pump_failure", "leak": "pipeline_leak", "degradation": "pump_degradation"}
ALLOWED_OVERRIDES = {"fleetSize", "repairHours", "extraRepairHours", "truckCapacityBbl",
                     "costPerTrip", "lockedWells", "noTrucks"}


class FixesError(ValueError):
    """Bad request (unknown event, bad override...)."""


# ------------------------------------------------------------------ formatting
def ts(t):
    return datetime.fromtimestamp(int(t), timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def hm(t):
    return datetime.fromtimestamp(int(t), timezone.utc).strftime("%H:%M")


def money(x):
    return f"${x:,.2f}" if abs(x - round(x)) > 0.004 else f"${x:,.0f}"


def plural(n, word):
    return f"{n} {word}{'' if n == 1 else 's'}"


# ------------------------------------------------------------------ planner bridge
class PlannerBridge:
    """Long-lived `npx tsx ml/fixes/bridge.ts` process, one JSON line per request."""

    def __init__(self):
        self.proc = None
        self.lock = threading.Lock()
        self.n = 0

    def _start(self):
        npx = shutil.which("npx")
        if not npx:
            raise RuntimeError("npx not found: Node.js is needed for the planner bridge (run npm install in the repo)")
        self.proc = subprocess.Popen([npx, "tsx", str(BRIDGE)], cwd=REPO, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     text=True, encoding="utf-8", bufsize=1)

    def call(self, req):
        with self.lock:
            if self.proc is None or self.proc.poll() is not None:
                self._start()
            self.n += 1
            req = {**req, "id": self.n}
            self.proc.stdin.write(json.dumps(req) + "\n")
            self.proc.stdin.flush()
            line = self.proc.stdout.readline()
            if not line:
                self.proc = None
                raise RuntimeError("planner bridge exited; check that `npm install` was run in the repo")
            resp = json.loads(line)
            if not resp.get("ok"):
                raise RuntimeError(f"planner: {resp.get('error')}")
            return resp["result"]

    def close(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()


bridge = PlannerBridge()


# ------------------------------------------------------------------ events from LightGBM
def _runs(mask, min_steps, merge_gap):
    raw, i, n = [], 0, len(mask)
    while i < n:
        if mask[i]:
            j = i
            while j < n and mask[j]:
                j += 1
            if j - i >= min_steps:
                raw.append((i, j))
            i = j
        else:
            i += 1
    out = []
    for s, t in raw:
        if out and s - out[-1][1] <= merge_gap:
            out[-1] = (out[-1][0], t)
        else:
            out.append((s, t))
    return out


def ongoing_events(dataset_dir, as_of=None):
    """Ongoing events at "now" from the LightGBM probabilities (causal: uses data <= now)."""
    out = detector.detect(dataset_dir, as_of)
    ds, _, _ = detector._prepare(dataset_dir, as_of)
    fac_of = {}
    for s, f in ds.facilities():
        fac_of[f["pump"]["id"]] = (s["id"], f["id"])
        fac_of[f["pipeline"]["id"]] = (s["id"], f["id"])
    events = []
    for x in out["assets"]:
        tsx = np.array(x["tsUnix"])
        for cname, p in x["probs"].items():
            if cname == "normal":
                continue
            cat = CLASS_TO_CAT[cname]
            p = np.array(p)
            for s, t in _runs(p > THR, MIN_STEPS[cat], MERGE_GAP_STEPS):
                if t != len(tsx):          # only events still going at "now"
                    continue
                onset = int(tsx[s])
                sys_id, fid = fac_of[x["assetId"]]
                events.append({"eventId": f"{cat}:{x['assetId']}:{onset}", "category": cat,
                               "assetId": x["assetId"], "facilityId": fid, "systemId": sys_id,
                               "onsetUnix": onset, "confidence": round(float(p[s:t].mean()), 4)})
    events.sort(key=lambda e: (e["category"] != "pump_failure", e["onsetUnix"]))
    return int(out["asOfUnix"]), ds, events


def _find_event(events, event_id=None, asset_id=None):
    if event_id:
        hit = [e for e in events if e["eventId"] == event_id]
        if not hit and event_id.count(":") >= 2:      # same event, onset off by a few minutes
            cat, aid = event_id.split(":")[:2]
            hit = [e for e in events if e["category"] == cat and e["assetId"] == aid]
        if hit:
            return hit[0]
        raise FixesError(f"no ongoing event {event_id!r} at this time")
    if asset_id:
        hit = [e for e in events if asset_id in (e["assetId"], e["facilityId"])]
        if hit:
            return hit[0]
        raise FixesError(f"no ongoing event on {asset_id!r} at this time")
    raise FixesError("give eventId or assetId")


# ------------------------------------------------------------------ pump failures
def _level_at(p, t):
    tr = p["levelTrace"]
    i = int((t - tr["t0"]) // tr["stepSec"])
    vals = tr["values"]
    return vals[max(0, min(i, len(vals) - 1))] if vals else float("nan")


def _sequence(p, m, n_wells, system_id):
    """Chronological "<time> - <what happens>" strings for one facility plan."""
    ev = []
    cap, warn, shut = m["capacityBbl"], m["warningPct"], m["shutdownPct"]
    tr = p["levelTrace"]
    k = p["trucks"]
    for t in sorted(set(p["truckArrivalsUnix"])):
        before = _level_at(p, t)
        removed = min(k * m["truckCapacityBbl"], before / 100 * cap)
        after = before - removed / cap * 100
        ev.append((t, f"{plural(k, 'truck')} arrive{'s' if k == 1 else ''} and remove{'s' if k == 1 else ''} "
                      f"{removed:,.0f} bbl; tank drops from {before:.1f}% to {after:.1f}%"))
    if p["shutInWells"]:
        t = p["shutInStartUnix"]
        water = sum(w["baselineWaterBpd"] for w in m["wells"] if w["id"] in p["shutInWells"])
        ev.append((t, f"{', '.join(p['shutInWells'])} shut in ({water:,.0f} bbl/day of water stops); "
                      f"tank is at {_level_at(p, t):.1f}%"))
    vals = tr["values"]
    if vals and vals[0] >= warn:
        ev.append((tr["t0"], f"Tank is already above the {warn:g}% warning level ({vals[0]:.1f}%)"))
    for i in range(1, len(vals)):
        t_i = tr["t0"] + i * tr["stepSec"]
        if vals[i - 1] < warn <= vals[i] and t_i < p["repairEndUnix"] and (p["tripsAtUnix"] is None or t_i < p["tripsAtUnix"]):
            ev.append((tr["t0"] + i * tr["stepSec"], f"Tank crosses the {warn:g}% warning level (about)"))
    if p["tripsAtUnix"] is not None:
        ev.append((p["tripsAtUnix"], f"Tank reaches the {shut:g}% shutdown limit; all {n_wells} wells shut in "
                                     f"automatically, losing {money(m['facilityRevenuePerHour'])} an hour"))
        ev.append((p["repairEndUnix"], "Repair completes; the pump restarts and the wells resume"))
    else:
        pk = p["peakLevelPct"]
        peak = f"{pk:.2f}%" if shut - pk < 0.1 else f"{pk:.1f}%"   # never print 92.0% "below" 92%
        if p["shutInWells"]:
            wl = ", ".join(p["shutInWells"])
            head = f"Repair completes, the pump restarts and {wl} {'is' if len(p['shutInWells']) == 1 else 'are'} turned back on"
        else:
            head = "Repair completes and the pump restarts"
        ev.append((p["repairEndUnix"], f"{head}; tank peaked at {peak}, below the {shut:g}% shutdown limit"))
    for t in sorted(set(p["truckFreeAtUnix"])):
        ev.append((t, f"{plural(k, 'truck')} back at the yard and free for other jobs in {system_id}"))
    ev.sort(key=lambda e: e[0])
    return [f"{ts(t)} - {txt}" for t, txt in ev]


def _describe(p, label, now):
    parts = []
    if p["trucks"]:
        parts.append(f"send {plural(p['trucks'], 'truck')} to {p['facilityId']} now for "
                     f"{plural(p['tripsPerTruck'], 'trip')}{' each' if p['trucks'] > 1 else ''}")
    if p["shutInWells"]:
        start = p["shutInStartUnix"]
        parts.append(f"shut in {', '.join(p['shutInWells'])} at {hm(start)} UTC "
                     f"({round((start - now) / 60)} min from now) until the repair ends")
    if not parts:
        if p["tripsAtUnix"] is None:
            return "No action needed: the tank stays below the shutdown limit until the repair ends."
        return f"{label}Do nothing and let the tank trip; all wells shut in automatically until the repair ends."
    text = " and ".join(parts)
    return f"{label}{text[0].upper()}{text[1:]}."


def _reasoning(p, m):
    parts = []
    k, n = p["trucks"], p["tripsPerTruck"]
    if k:
        parts.append(f"{plural(k, 'truck')} x {plural(n, 'trip')} x {money(m['costPerTrip'])} per trip = "
                     f"{money(p['truckCost'])}. Each trip removes {m['truckCapacityBbl']:,.0f} bbl; the first "
                     f"arrives {m['responseMin']} min after the call and each truck returns every {m['cycleMin']} min.")
    if p["shutInWells"]:
        wells = [w for w in m["wells"] if w["id"] in p["shutInWells"]]
        rows = [f"{w['id']}: {w['oilBpd']:,.0f} bbl oil x {money(m['oilPerBbl'])} + {w['gasMcfd']:,.0f} mcf gas x "
                f"{money(m['gasPerMcf'])} = {money(w['revenuePerHour'] * 24)} a day = {money(w['revenuePerHour'])} an hour"
                for w in wells]
        start = p["shutInStartUnix"]
        end = p["tripsAtUnix"] if p["tripsAtUnix"] is not None else p["repairEndUnix"]
        h = max(0.0, (end - start) / 3600)
        per_h = sum(w["revenuePerHour"] for w in wells)
        parts.append("; ".join(rows) + f". Off from {hm(start)} to {hm(end)} = {h:.2f} h, so "
                     f"{money(per_h)} x {h:.2f} h = {money(p['shutInCost'])} of lost oil and gas sales. "
                     f"{hm(start)} is the latest start that still keeps the tank under the limit.")
    if p["tripCost"] > 0.005:
        t0, t1 = p["tripsAtUnix"], p["repairEndUnix"]
        h = (t1 - t0) / 3600
        rows = [f"{w['id']} {money(w['revenuePerHour'])}" for w in m["wells"]]
        parts.append(f"Automatic shut-in from {hm(t0)} to {hm(t1)} = {h:.2f} h. Lost revenue per hour is the sum "
                     f"over the facility's wells ({', '.join(rows)}) = {money(m['facilityRevenuePerHour'])}, "
                     f"so {money(m['facilityRevenuePerHour'])} x {h:.2f} h = {money(p['tripCost'])}.")
    if not parts:
        return "No cost: nothing is dispatched or shut in, and the tank never reaches the shutdown limit."
    return " ".join(parts) + f" Total: {money(p['cost'])}."


def _pump_failure_fixes(dataset_dir, as_of, ev, events, overrides, max_fixes):
    failures = [{"eventId": e["eventId"], "facilityId": e["facilityId"], "onsetUnix": e["onsetUnix"]}
                for e in events if e["category"] == "pump_failure" and e["systemId"] == ev["systemId"]]
    r = bridge.call({"op": "plan", "datasetDir": str(Path(dataset_dir).resolve()), "asOfUnix": as_of,
                     "failures": failures, "targetEventId": ev["eventId"], "overrides": overrides or {}})
    m, v, now = r["model"], r["variants"], r["asOfUnix"]
    n_wells = len(m["wells"])

    # tank already at the limit, or never reaches it: only one honest answer
    cd = r["countdown"]
    if cd.get("alreadyTripped"):
        p = v["doNothing"]
        return [{"fixDescription": "The tank is already at the shutdown limit and its wells are shut in. Nothing "
                                   "can bring them back before the repair; wait for the pump repair.",
                 "predictedSequence": [f"{ts(now)} - Tank is at the {m['shutdownPct']:g}% shutdown limit; wells are shut in",
                                       f"{ts(p['repairEndUnix'])} - Repair completes; the pump restarts and the wells resume"],
                 "cost": round(p["cost"], 2), "costReasoning": _reasoning(p, m)}]
    if v["doNothing"]["tripsAtUnix"] is None:
        p = v["doNothing"]
        return [{"fixDescription": _describe(p, "", now), "predictedSequence": _sequence(p, m, n_wells, r["systemId"]),
                 "cost": round(p["cost"], 2), "costReasoning": _reasoning(p, m)}]

    shared = ""
    if len(failures) > 1:
        shared = (f" Planned together with {len(failures) - 1} other failing "
                  f"{'tank' if len(failures) == 2 else 'tanks'} in {r['systemId']}: {r['othersTrucksUsed']} of "
                  f"{r['fleetSize']} trucks go to them.")
    labelled = [("Recommended (cheapest for the whole system): ", v["recommended"], shared),
                ("Trucks only: ", v["trucksOnly"], ""),
                ("Shut in wells only: ", v["shutInOnly"], ""),
                ("", v["doNothing"], "")]
    seen, fixes = set(), []
    for label, p, note in labelled:
        # a "trucks only" plan with no trucks (none free, or trucks can't prevent the trip) or a
        # "shut in only" plan with no shut-in is really "do nothing": let that entry carry it
        if label.startswith("Trucks only") and not p["trucks"]:
            continue
        if label.startswith("Shut in wells only") and not p["shutInWells"]:
            continue
        sig = (p["trucks"], p["tripsPerTruck"], tuple(p["shutInWells"]), p["shutInStartUnix"])
        if sig in seen:
            continue
        seen.add(sig)
        fixes.append({"fixDescription": _describe(p, label, now) + note,
                      "predictedSequence": _sequence(p, m, n_wells, r["systemId"]),
                      "cost": round(p["cost"], 2), "costReasoning": _reasoning(p, m)})
    rec = fixes[0]
    rest = sorted(fixes[1:], key=lambda f: f["cost"])
    return ([rec] + rest)[:max_fixes]


# ------------------------------------------------------------------ leaks and worn pumps
def _trend(ds, fac, onset, now, kind):
    W = ds.wide
    p, pl = fac["pump"]["id"], fac["pipeline"]["id"]
    m = (W.index >= onset) & (W.index <= now) & (W[f"{p}|status"].values == 1)
    if m.sum() < 6:
        return None
    h = (W.index[m].values - onset) / 3600.0
    if kind == "leak":
        y = 1 - W.loc[m, f"{pl}|receive_flow_bpd"].values / W.loc[m, f"{p}|flow_bpd"].values
    else:
        y = W.loc[m, f"{p}|flow_bpd"].values / fac["pump"]["max_flow_bpd"]
    slope, icpt = np.polyfit(h, y, 1)
    return float(slope), float(icpt + slope * (now - onset) / 3600.0)


def _inspection_fixes(ds, ev, now):
    fac = next(f for _, f in ds.facilities() if f["id"] == ev["facilityId"])
    unpriced = ("ops.json has no price for a field inspection and no inspector travel time, so the cost is shown "
                "as 0. That means unpriced, not free.")
    is_leak = ev["category"] == "pipeline_leak"
    what = "pipeline leak" if is_leak else "worn pump"
    inspect = {
        "fixDescription": f"Send an inspector to {ev['assetId']} now ({what}). The pump still moves water, so no "
                          f"trucks or shut-ins are needed.",
        "predictedSequence": [
            f"{ts(now)} - Inspector dispatched to {ev['assetId']} at {ev['facilityId']}",
            "After the repair - " + ("water reaching the disposal site returns to what the pump sends, and pipeline "
                                     "pressure returns to normal" if is_leak else
                                     "pump flow and discharge pressure return to their rated values"),
        ],
        "cost": 0, "costReasoning": unpriced}

    seq = []
    tr = _trend(ds, fac, ev["onsetUnix"], now, "leak" if is_leak else "deg")
    if tr is None:
        seq.append(f"{ts(now)} - Not enough pump running time since the onset to project the trend yet")
    elif is_leak:
        slope, loss_now = tr
        seq.append(f"{ts(now)} - About {loss_now:.1%} of the pumped water is not reaching the disposal site, "
                   f"growing {slope * 100:.2f} points an hour")
        for hrs in (12, 24):
            seq.append(f"{ts(now + hrs * 3600)} - Projected loss about {min(0.9, loss_now + slope * hrs):.1%} of "
                       f"pumped water if the trend holds")
    else:
        slope, frac_now = tr
        inflow_frac = sum(w["baseline_water_bpd"] for w in fac["wells"]) / fac["pump"]["max_flow_bpd"]
        seq.append(f"{ts(now)} - The pump is moving about {frac_now:.1%} of its rated flow, changing "
                   f"{slope * 100:+.2f} points an hour")
        if slope < 0 and frac_now > inflow_frac:
            t_cross = now + (frac_now - inflow_frac) / -slope * 3600
            seq.append(f"{ts(t_cross)} - Projected: pump flow falls below the wells' inflow ({inflow_frac:.1%} of "
                       f"rated); after this the tank fills even while the pump runs, and a shutdown becomes possible")
        seq.append("Risk - a worn pump can go on to fail outright, which would start a shutdown countdown")
    leave = {"fixDescription": f"No action yet: monitor {ev['assetId']} ({what}). The projection extrapolates the "
                               f"trend measured on this asset since the onset.",
             "predictedSequence": seq, "cost": 0,
             "costReasoning": unpriced.replace("a field inspection", "monitoring or an inspection")}
    return [inspect, leave]


# ------------------------------------------------------------------ public entry points
def _clean_overrides(o):
    o = o or {}
    bad = set(o) - ALLOWED_OVERRIDES
    if bad:
        raise FixesError(f"unknown overrides {sorted(bad)}; allowed: {sorted(ALLOWED_OVERRIDES)}")
    return o


def fixes_for(dataset_dir, as_of=None, event_id=None, asset_id=None, overrides=None, max_fixes=4):
    overrides = _clean_overrides(overrides)
    now, ds, events = ongoing_events(dataset_dir, as_of)
    ev = _find_event(events, event_id, asset_id)
    if ev["category"] == "pump_failure":
        fixes = _pump_failure_fixes(dataset_dir, now, ev, events, overrides, max_fixes)
    else:
        fixes = _inspection_fixes(ds, ev, now)[:max_fixes]
    return {"eventId": ev["eventId"], "fixes": fixes}


def fixes_all(dataset_dir, as_of=None, overrides=None, max_fixes=4):
    overrides = _clean_overrides(overrides)
    now, _, events = ongoing_events(dataset_dir, as_of)
    results = [fixes_for(dataset_dir, now, e["eventId"], None, overrides, max_fixes) for e in events]
    return {"asOfUnix": now, "events": events, "results": results}
