"""EVALUATION ONLY. The only ml/ script that reads answer_key.json (the service never does).

Scores the detector's raw probabilities on a real folder: per-event hit and detection delay,
and false-alarm runs. The thresholding below is a stand-in for the backend's own.

    python ml/eval/eval_real.py Resources/full_week [--thr 0.5] [--min-steps 3]
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import detector  # noqa: E402

CLS = {"pump_failure": ("pump", "failure"), "pump_degradation": ("pump", "degradation"),
       "pipeline_leak": ("pipeline", "leak")}


def runs(mask):
    """(start, end_exclusive) index pairs of consecutive True."""
    out, i, n = [], 0, len(mask)
    while i < n:
        if mask[i]:
            j = i
            while j < n and mask[j]:
                j += 1
            out.append((i, j)); i = j
        else:
            i += 1
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--thr", type=float, default=0.5)
    ap.add_argument("--min-steps", type=int, default=3)
    ap.add_argument("--asof", type=int, default=None)
    a = ap.parse_args()
    key = json.loads((Path(a.folder) / "answer_key.json").read_text())
    out = detector.detect(a.folder, a.asof, use_cache=False)
    A = {x["assetId"]: x for x in out["assets"]}
    ts = np.array(next(iter(A.values()))["tsUnix"])
    now = ts[-1]
    print(f"{'event':9s} {'category':17s} {'asset':16s} {'onset':11s} {'first alarm':12s} {'delay h':>8s}")
    hits, delays = 0, []
    for e in key:
        if e["onset_unix"] > now:
            continue
        atype, cname = CLS[e["category"]]
        x = A[e["asset"]]
        p = np.array(x["probs"][cname])
        end = e["end_unix"] if e["end_unix"] else now + 1
        inside = (ts >= e["onset_unix"]) & (ts < end)
        hit = None
        for s, t in runs((p > a.thr) & inside):
            if t - s >= a.min_steps:
                hit = ts[s]; break
        if hit is not None:
            hits += 1; delays.append((hit - e["onset_unix"]) / 3600)
        print(f"{e['id']:9s} {e['category']:17s} {e['asset']:16s} {e['onset'][5:16]:11s} "
              f"{('MISSED' if hit is None else __import__('datetime').datetime.utcfromtimestamp(int(hit)).strftime('%m-%dT%H:%M')):12s} "
              f"{('' if hit is None else f'{(hit - e['onset_unix']) / 3600:8.1f}')}")
    total = sum(1 for e in key if e["onset_unix"] <= now)
    print(f"\nevents detected {hits}/{total}; detection delay median {np.median(delays):.1f} h, max {np.max(delays):.1f} h")

    # false alarms: confident runs on an asset with no labelled event of that kind (+/- 1 h margin)
    fa = 0
    for aid, x in A.items():
        for cname in [c for c in x["probs"] if c != "normal"]:
            p = np.array(x["probs"][cname])
            for s, t in runs(p > a.thr):
                if t - s < a.min_steps:
                    continue
                ok = any(e["asset"] == aid and CLS[e["category"]][1] == cname
                         and e["onset_unix"] - 3600 <= ts[t - 1] and ts[s] <= (e["end_unix"] or now) + 3600
                         for e in key)
                if not ok:
                    fa += 1
                    print(f"  false alarm: {aid} {cname} from {ts[s]} for {t - s} steps")
    print(f"false-alarm runs: {fa}")


if __name__ == "__main__":
    main()
