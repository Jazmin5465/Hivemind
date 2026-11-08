# History

`full_week/` is the whole dataset from start to finish: one week of a network (systems S1 to S5), Mon 2026-10-05 00:00 to Sun 2026-10-11 23:55 UTC, with all 23 events. Every other folder is that same week stopped at an earlier "now": its `telemetry.csv` is the first part of `full_week/telemetry.csv`, so you can practise on problems that are still in progress.

## Every folder is a dataset

Each folder holds the three files your app loads. At judging, the `test/` folder has only these three.

| File | What it holds |
|---|---|
| `network.json` | The network: systems, facilities, wells, tanks, pumps, pipelines, disposal sites. The same in every folder |
| `ops.json` | Prices, repair times and trucks. The same in every folder |
| `telemetry.csv` | Sensor readings up to that folder's "now", which is its last `ts_unix` |

Load every folder the same way, with no code changes.

Most folders also have an **`answer_key.json`**: the correct answers, so you can check your app. **Don't load it into your app.** In real operation, and at judging, there is no answer key: your app finds every problem in the sensor readings.

## The folders

| Folder | "Now" (UTC) | Answer key | What's going on at "now" |
|---|---|---|---|
| `full_week/` | Sun 10-11 23:55 | Yes | The whole week. All 23 events have ended. Build and check your detection here |
| `snapshot_2026-10-08T1200/` | Thu 10-08 12:00 | Yes | Three S2 pump failures within an hour: three tanks filling, two trucks. Also a leak and two pumps wearing out |
| `snapshot_2026-10-09T0330/` | Fri 10-09 03:30 | Yes | S4_PUMP_C failure, a leak |
| `snapshot_2026-10-10T0900/` | Sat 10-10 09:00 | Yes | Three S4 pump failures within an hour: three tanks filling, two trucks |
| `mock_test_2026-10-10T1530/` | Sat 10-10 15:30 | **No** | A dress rehearsal. It looks exactly like the `test/` folder you get at judging |

Because the snapshots and the mock test are the full week cut short, the full week's answer key gives away which events are happening at each cut and when they end. Try them before you look. Its recommendations won't match, though: they are planned at each event's start, while at a cut the right plan starts from "now", with the tank level, repair time left and trucks at that moment.

## Reading the answer key

`answer_key.json` lists every event that has started by "now", in onset order.

- `status`: `resolved` or `ongoing`. Every event in `full_week/` is `resolved`. An ongoing event has a null `end`, because the operator doesn't know yet when the repair will finish.
- `reference_action`: the cheapest plan (see [SPEC.md](../SPEC.md#plans)).
- Pump failures: `trips_at` is when the tank reached, or will reach, its shutdown limit if nobody acts. In a snapshot, ongoing ones also give `level_final_pct` and `hours_to_limit_final`, the tank level and countdown at "now", and their `reference_action` is planned from "now".
- When several pumps in one system fail together, each is its own event with its own countdown. Their `reference_action`s are planned together, because they share the system's trucks, and a note says which events they share with.
- Snapshots only: each ongoing pump failure has an `order`, its place in the alerts view ([SPEC.md](../SPEC.md#alerts-view)): soonest `hours_to_limit_final` first, with `lost_revenue_per_hour` as the tie-break. Leaks and worn pumps have no `order`; they follow the pump failures in any order.

Events that started just before "now" may not be detectable yet, for example a slow problem that is still too small to stand out from normal readings.
