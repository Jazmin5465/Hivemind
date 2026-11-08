"""Tests for POST /fixes and /fixes/all (EVALUATION: reads answer keys to check costs).

    python ml/tests/test_fixes.py [--data-root data/eog] [--show]

1. Every response matches the fixes JSON Schema exactly (additionalProperties: false).
2. Every ongoing pump failure in each snapshot gets a recommended (first) fix whose cost
   equals the answer key's reference_action cost (planned from "now", shared trucks).
3. Fixes are sorted: recommended first, the rest by cost.
4. Pump-failure costs: each fix's cost reasoning ends with the same total as its cost.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml"))

from fastapi.testclient import TestClient  # noqa: E402
import jsonschema  # noqa: E402

import fixes_service  # noqa: E402
import serve  # noqa: E402

SCHEMA = {
    "type": "object",
    "properties": {
        "eventId": {"type": "string"},
        "fixes": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "fixDescription": {"type": "string"},
                "predictedSequence": {"type": "array", "items": {"type": "string"}},
                "cost": {"type": "number"},
                "costReasoning": {"type": "string"},
            },
            "required": ["fixDescription", "predictedSequence", "cost", "costReasoning"],
            "additionalProperties": False}},
    },
    "required": ["eventId", "fixes"],
    "additionalProperties": False,
}


def ref_cost(text):
    m = re.search(r"~\$([\d,]+)", text or "")
    return float(m.group(1).replace(",", "")) if m else None


def run(data_root, show):
    c = TestClient(serve.app)
    folders = sorted(p.parent for p in Path(data_root).glob("snapshot_*/telemetry.csv"))
    ok = True
    for folder in folders:
        r = c.post("/fixes/all", json={"datasetDir": str(folder.resolve())})
        assert r.status_code == 200, r.text
        body = r.json()
        key = {e["asset"]: e for e in json.loads((folder / "answer_key.json").read_text()) if e["status"] == "ongoing"}
        print(f"\n=== {folder.name}: {len(body['results'])} ongoing events")
        for res, ev in zip(body["results"], body["events"]):
            jsonschema.validate(res, SCHEMA)
            fixes = res["fixes"]
            costs = [f["cost"] for f in fixes]
            assert costs[1:] == sorted(costs[1:]), f"{res['eventId']}: alternatives not sorted by cost"
            line = f"  {ev['category']:17s} {ev['assetId']:15s} {len(fixes)} fixes, first ${costs[0]:,.2f}"
            if ev["category"] == "pump_failure":
                for f in fixes:
                    m = re.search(r"Total: \$([\d,.]+)\.$", f["costReasoning"])
                    if m and abs(float(m.group(1).replace(",", "")) - f["cost"]) > 0.01:
                        ok = False
                        print(f"    MISMATCH reasoning total {m.group(1)} vs cost {f['cost']}")
                k = key.get(ev["assetId"])
                want = ref_cost(k["reference_action"]) if k else None
                if want is not None:
                    good = abs(round(costs[0]) - want) <= 1
                    ok &= good
                    line += f" | answer key ~${want:,.0f} {'OK' if good else 'MISMATCH'}"
            print(line)
            if show:
                for f in fixes:
                    print(f"      ${f['cost']:>9,.2f}  {f['fixDescription']}")
                    for s in f["predictedSequence"]:
                        print(f"                   {s}")
    print("\nALL CHECKS PASSED" if ok else "\nSOME CHECKS FAILED")
    return ok


def test_fixes():
    assert run(ROOT / "data" / "eog", False)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-root", default=str(ROOT / "data" / "eog"))
    ap.add_argument("--show", action="store_true")
    a = ap.parse_args()
    try:
        sys.exit(0 if run(a.data_root, a.show) else 1)
    finally:
        fixes_service.bridge.close()
