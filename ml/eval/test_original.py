"""EVALUATION ONLY: test the trained detector on the original (organizer) data weeks.

Reads answer_key.json to score results. The service never does this.

    python ml/eval/test_original.py                    # every folder under data/eog
    python ml/eval/test_original.py data/eog/full_week --json out/full_week_events.json
    python ml/eval/test_original.py --merge-gap 30     # join runs split by short dips (minutes)

For every folder it prints the EVENTS THE MODEL OUTPUTS: one per run of
probability > --thr lasting at least --min-steps steps, with asset, category, start,
end or "ongoing", and confidence (peak and mean probability over the run).

For folders with an answer key it also marks each detected event as matching a labelled
event (by id) or as a FALSE ALARM, and reports:
  - per labelled event: detected or missed, and how long after onset
  - per row: accuracy, per-class precision/recall and a confusion matrix, one row per
    facility per 5-minute step (the unit the model was trained on)

The thresholds belong to this script; the backend applies its own.
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import detector  # noqa: E402
from features import CLASSES  # noqa: E402

CAT = {"pipeline_leak": ("pipeline", "leak", 1), "pump_degradation": ("pump", "degradation", 2),
       "pump_failure": ("pump", "failure", 3)}
CLASS_TO_CAT = {v[1]: k for k, v in CAT.items()}
STEP = 300


def hhmm(t):
    return datetime.fromtimestamp(int(t), timezone.utc).strftime("%m-%d %H:%M")


def iso(t):
    return datetime.fromtimestamp(int(t), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def runs(mask, merge_gap=0, min_steps=1):
    """(start, end_exclusive) of consecutive True.

    Runs shorter than min_steps are dropped FIRST, then runs separated by a gap of
    <= merge_gap steps are joined. (Merging first would glue short blips together into
    a run long enough to count as an event.)"""
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
        if out and merge_gap and s - out[-1][1] <= merge_gap:
            out[-1] = (out[-1][0], t)
        else:
            out.append((s, t))
    return out


def detected_events(out, thr, min_steps, merge_gap):
    """The events the model outputs, oldest first."""
    ts = np.array(out["assets"][0]["tsUnix"])
    ev = []
    for x in out["assets"]:
        for cname, p in x["probs"].items():
            if cname == "normal":
                continue
            p = np.array(p)
            for s, t in runs(p > thr, merge_gap, min_steps):
                ongoing = t == len(ts)
                ev.append({"assetId": x["assetId"], "assetType": x["assetType"],
                           "category": CLASS_TO_CAT[cname],
                           "onsetUnix": int(ts[s]), "onset": iso(ts[s]),
                           "endUnix": None if ongoing else int(ts[t - 1]) + STEP,
                           "end": None if ongoing else iso(int(ts[t - 1]) + STEP),
                           "status": "ongoing" if ongoing else "resolved",
                           "durationHours": round((t - s) * STEP / 3600, 2),
                           "confidencePeak": round(float(p[s:t].max()), 4),
                           "confidenceMean": round(float(p[s:t].mean()), 4)})
    ev.sort(key=lambda e: (e["onsetUnix"], e["assetId"]))
    for i, e in enumerate(ev, 1):
        e["id"] = f"DET_{i}"
    return ev


def match(det, key, now):
    """Label id a detected event overlaps (same asset and kind, +/- 1 h), else None."""
    for e in key:
        if e["asset"] != det["assetId"] or e["category"] != det["category"]:
            continue
        end_l = e["end_unix"] or now + STEP
        end_d = det["endUnix"] or now + STEP
        if det["onsetUnix"] <= end_l + 3600 and e["onset_unix"] - 3600 <= end_d:
            return e["id"]
    return None


def print_events(events, key, now):
    print(f"  Events the model outputs ({len(events)}):")
    print(f"    {'id':7s} {'category':17s} {'asset':16s} {'start':12s} {'end':12s} {'hours':>6s} "
          f"{'peak':>5s} {'mean':>5s}  {'matches' if key is not None else ''}")
    for e in events:
        end = "ongoing" if e["endUnix"] is None else hhmm(e["endUnix"])
        tag = ""
        if key is not None:
            m = match(e, key, now)
            e["matchesLabel"] = m
            tag = m if m else "FALSE ALARM"
        print(f"    {e['id']:7s} {e['category']:17s} {e['assetId']:16s} {hhmm(e['onsetUnix']):12s} {end:12s} "
              f"{e['durationHours']:6.1f} {e['confidencePeak']:5.2f} {e['confidenceMean']:5.2f}  {tag}")


def facility_probs(out, network):
    """Rebuild the model's 4-class output per facility from the per-asset response."""
    A = {x["assetId"]: x for x in out["assets"]}
    res = {}
    for s in network["systems"]:
        for f in s["facilities"]:
            pump, pipe = A[f["pump"]["id"]], A[f["pipeline"]["id"]]
            leak = np.array(pipe["probs"]["leak"])
            deg, fail = np.array(pump["probs"]["degradation"]), np.array(pump["probs"]["failure"])
            res[f["id"]] = np.column_stack([np.clip(1 - leak - deg - fail, 0, 1), leak, deg, fail])
    return res


def score_folder(folder, a):
    folder = Path(folder)
    network = json.loads((folder / "network.json").read_text())
    out = detector.detect(folder, None, use_cache=False)
    A = {x["assetId"]: x for x in out["assets"]}
    ts = np.array(out["assets"][0]["tsUnix"])
    now = int(ts[-1])
    key_path = folder / "answer_key.json"
    key = None
    if key_path.exists():
        key = [e for e in json.loads(key_path.read_text()) if e["onset_unix"] <= now]
    print(f"\n=== {folder.name}  (now {hhmm(now)}, {len(ts)} steps, model {out['modelVersion']})")

    events = detected_events(out, a.thr, a.min_steps, a.merge_gap // 5)
    print_events(events, key, now)
    if a.json:
        p = Path(a.json)
        if len(a.folders_resolved) > 1:
            p = p.with_name(f"{p.stem}_{folder.name}{p.suffix}")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"dataset": folder.name, "nowUnix": now, "modelVersion": out["modelVersion"],
                                 "threshold": a.thr, "minSteps": a.min_steps, "events": events}, indent=1))
        print(f"  wrote {p}")
    if key is None:
        print("  (no answer key: nothing to score)")
        return None

    # ---- per labelled event
    hits, delays = 0, {c: [] for c in CAT}
    rows = []
    for e in key:
        cname = CAT[e["category"]][1]
        p = np.array(A[e["asset"]]["probs"][cname])
        end = e["end_unix"] or now + 1
        inside = (ts >= e["onset_unix"]) & (ts < end)
        hit = next((ts[s] for s, t in runs((p > a.thr) & inside) if t - s >= a.min_steps), None)
        if hit is not None:
            hits += 1
            delays[e["category"]].append((hit - e["onset_unix"]) / 3600)
        rows.append((e, hit))
    if not a.quiet:
        print(f"  Labelled events ({len(key)}):")
        print(f"    {'label':9s} {'category':17s} {'asset':16s} {'onset':12s} {'first alarm':12s} delay")
        for e, hit in rows:
            d = "" if hit is None else f"{(hit - e['onset_unix']) / 3600:.1f} h"
            print(f"    {e['id']:9s} {e['category']:17s} {e['asset']:16s} {hhmm(e['onset_unix']):12s} "
                  f"{'MISSED' if hit is None else hhmm(hit):12s} {d}")

    fa = [e for e in events if not e.get("matchesLabel")]
    dup = len(events) - len(fa) - len({e["matchesLabel"] for e in events if e.get("matchesLabel")})

    # ---- per row (facility x step), argmax of the 4 classes
    P = facility_probs(out, network)
    y_true, y_pred = [], []
    for fid, p in P.items():
        lab = np.zeros(len(ts), int)
        for e in key:
            if e["facility"] == fid:
                end = e["end_unix"] or now + 1
                lab[(ts >= e["onset_unix"]) & (ts < end)] = CAT[e["category"]][2]
        y_true.append(lab)
        y_pred.append(p.argmax(1))
    y_true, y_pred = np.concatenate(y_true), np.concatenate(y_pred)
    cm = np.zeros((4, 4), int)
    np.add.at(cm, (y_true, y_pred), 1)
    acc = np.trace(cm) / cm.sum()

    print(f"  labelled events detected {hits}/{len(key)}   false alarms {len(fa)}   "
          f"extra detections of an already-matched label {dup}")
    for c, d in delays.items():
        if d:
            print(f"    {c:17s} delay median {np.median(d):.1f} h, max {np.max(d):.1f} h  ({len(d)} events)")
    print(f"  per-row accuracy {acc:.4f}  ({np.trace(cm):,}/{cm.sum():,} facility-steps)")
    print(f"    {'class':17s} {'precision':>9s} {'recall':>7s} {'rows':>7s}")
    for i, c in enumerate(CLASSES):
        pr = cm[i, i] / cm[:, i].sum() if cm[:, i].sum() else float("nan")
        rc = cm[i, i] / cm[i, :].sum() if cm[i, :].sum() else float("nan")
        print(f"    {c:17s} {pr:9.3f} {rc:7.3f} {cm[i, :].sum():7d}")
    print("    confusion (rows = true, cols = predicted; normal, leak, degradation, failure):")
    for i in range(4):
        print("     ", " ".join(f"{v:7d}" for v in cm[i]))
    return {"folder": folder.name, "events": len(key), "hits": hits, "fa": len(fa), "dup": dup,
            "detected": len(events), "acc": acc}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folders", nargs="*")
    ap.add_argument("--data-root", default="data/eog")
    ap.add_argument("--thr", type=float, default=0.5)
    ap.add_argument("--min-steps", type=int, default=3)
    ap.add_argument("--merge-gap", type=int, default=0, help="join runs split by dips of up to this many minutes")
    ap.add_argument("--json", help="write detected events to this JSON file (one file per folder)")
    ap.add_argument("--quiet", action="store_true", help="skip the labelled-event table")
    a = ap.parse_args()
    a.folders_resolved = a.folders or sorted(str(p.parent) for p in Path(a.data_root).glob("*/telemetry.csv"))
    if not a.folders_resolved:
        sys.exit(f"no dataset folders found under {a.data_root}")
    results = [r for r in (score_folder(f, a) for f in a.folders_resolved) if r]
    if results:
        print("\n=== summary")
        print(f"  {'folder':28s} {'model events':>12s} {'labels hit':>11s} {'false alarms':>13s} "
              f"{'duplicates':>11s} {'row accuracy':>13s}")
        for r in results:
            print(f"  {r['folder']:28s} {r['detected']:>12d} {r['hits']:>5d}/{r['events']:<5d} {r['fa']:>13d} "
                  f"{r['dup']:>11d} {r['acc']:>13.4f}")
        print("  Note: the snapshots are the same week cut early, so they repeat the same events.")


if __name__ == "__main__":
    main()
