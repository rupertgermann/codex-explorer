# Usage performance validation

Comparison: v0.8.0 (`8243bc8`) against the usage performance changes for issues #39–#42. Measurements use Node 24 on a busy shared 12-core host. Each comparison has five pairs with alternating implementation order, validates complete output equality apart from generation time, and checks token totals and skipped-record counts. Profiles run separately from timed comparisons. No private report contents are included here.

## Repository generation

These measurements time `readUsageData`, including catalog preparation and global accounting. They exclude report persistence, HTTP transfer and browser rendering. “Cold” means invalidated parsed evidence and headers with filesystem pages potentially warm, not an empty OS disk cache.

The transcript fixture has ten files with 35,000 ordinary transcript records each and a small number of semantic accounting records. After the append runs, evidence replay contains 350,055 records in v0.8.0 versus 65 compacted records; estimated retained evidence falls from 58,815,985 to 17,505 bytes. This is serialized evidence accounting with overhead, not a process-RAM measurement.

| Transcript-heavy generation | v0.8.0 median (range), ms | Revised median (range), ms | Content streams, old → revised |
| --- | --- | --- | --- |
| Warm, unchanged | 652 (456–995) | 4.9 (2.2–7.5) | 0 → 0 |
| One file appended | 611 (278–1,344) | 153 (44–228) | 2 → 2 |

Cold timing is noisy. Mixed-process pairs gave overlapping ranges of 752–2,124 ms versus 891–5,395 ms, with medians 1,277 versus 2,328 ms. To check allocation/GC interference, five additional alternating pairs ran each implementation in a separate process, warmed it, invalidated all file revisions, then timed the complete reparse. Those medians were 802 versus 523 ms, ranges 539–1,175 versus 484–767 ms; every revised pair was lower. The apparent cold regression was not reproduced in isolation, but no cold speedup is claimed.

The semantic-heavy fixture has four files with 60,000 contexts each. Its 69,607,507 estimated evidence bytes still exceed the 64 MiB budget after timestamp compaction, and every file is individually cacheable. It therefore tests admission independently of compaction.

| Semantic-heavy generation | v0.8.0 median (range), ms | Revised median (range), ms | Content streams, old → revised |
| --- | --- | --- | --- |
| Cold | 746 (643–840) | 599 (581–991) | 8 → 8 |
| Warm, unchanged | 780 (697–1,494) | 491 (425–553) | 4 → 2 |
| One file appended | 658 (587–2,204) | 473 (439–657) | 5 → 3 |

Every warm semantic sweep reopens approximately half the original source bytes: about 15.1 MB versus 30.2 MB. Established residents survive, while new admissions still enter the cache. A separate profile identifies JSONL parsing, normalization and context accounting as the remaining work on uncached sources. The compacted transcript fixture has too little warm CPU work for a useful sampled hotspot.

The committed over-budget test generates semantic records, checks its actual normalized size exceeds the budget, verifies partial reuse for five sweeps, checks changed-file invalidation and deletion, and confirms full reuse once the remaining set fits. A separate five-sweep control covers two individually cacheable sources when only one fits: admission bypass preserves the final resident, and source-set pruning permits a changed working set. Other tests cover date/root changes, inherited activity, malformed timestamps, original semantic line numbers and cancellation.

## Quota calculation

Five alternating `analyzeQuota` pairs used the same local saved report: 93,026 events, 12,452 activity intervals and 98,633 quota snapshots overall, including 98,580 reliable weekly-bucket snapshots. Complete results remain deeply equal. Median time is 350 → 132 ms; ranges are 297–434 versus 109–208 ms. Ownership comparisons use typed fields directly; public serialized dimension keys remain unchanged.

This is pure Node calculation time. It does not establish browser latency or total archive-generation speedup. Browser tests exercise bucket and minimum-duration controls for correctness.

## Large sessions

Event-only, interval-heavy and mixed session tests exceed 150,000 timestamp inputs while preserving exact bounds and totals. The browser test restores, filters and regenerates a 150,000-event session without a page error or truncated totals. Session bounds use bounded-argument extrema calculations.

## v0.9.0 follow-up: quota, daily buckets and session exports

These comparisons use the v0.9.0 code at `bfbabab` and the changes for #45–#47. Each side receives the same synthetic report. Timed runs alternate order. Node calculations and downloaded CSVs are checked for complete output equality; browser controls are checked against fixture totals. They ran on a shared 12-core host; load was variable. The browser measurements use isolated production builds, Chrome, and a mocked `/api/usage` response. They exclude archive scanning and network transfer.

| Work measured | Baseline median (range), ms | Revised median (range), ms | Runs |
| --- | --- | --- | --- |
| Quota calculation in Node | 895 (824–1,109) | 97 (77–223) | 5 pairs |
| Daily buckets in Node, GC before each run | 71.7 (70.4–76.9) | 43.8 (43.0–83.0) | 7 pairs |
| Whole report calculation in Node | 378 (289–461) | 308 (287–385) | 5 pairs |
| Minimum quota duration control in Chrome | 1,385 (1,368–1,465) | 541 (514–626) | 5 pairs |
| Effort filter in Chrome | 879 (817–885) | 821 (779–875) | 5 pairs |
| Session-hourly CSV download in Chrome | 3,821 (3,809–4,136) | 138 (76–399) | 5 pairs |

The daily-only run explicitly invoked garbage collection before, but not during, each measurement. Its GC schedule is not representative of normal app use. The whole-report and browser-filter ranges overlap, so those measurements do not establish a reliable end-to-end daily-bucket gain. Browser control times run from the change event through two animation frames; download times include Playwright's button lookup and the download event.

The quota fixture contains 93,026 reliable snapshots across 1,752 five-hour reset cycles and 12,452 intervals. Before the change, every cycle filtered the full snapshot list. Separate instrumentation and browser CPU profiles identified the repeated cycle filtering as the main cost. After grouping snapshots once, the sampled browser work was led by number formatting and rendering. The fixture construction is documented in [#45](https://github.com/rupertgermann/codex-explorer/issues/45).

The daily fixture spans 365 days in `Europe/Berlin`, including partial endpoints and daylight-saving changes, with 93,026 events, 12,452 intervals and 256 sessions. A separate profile of full report construction sampled bucket aggregation heavily; grouping, model calculations and chart rendering remain. The fixture construction is documented in [#46](https://github.com/rupertgermann/codex-explorer/issues/46).

The CSV fixture contains 1,000 short sessions across a one-year report. Every hourly download returned 1,000 rows; complete baseline and revised CSV bytes matched in every pair. A six-hour download also matched byte for byte. The baseline browser profile sampled `emptyTokens` and `usageBuckets` heavily while constructing report-wide buckets for every session. Afterward, the separate profile was dominated by Playwright's accessible-button lookup and browser work. These timings include that automation overhead. The fixture construction is documented in [#47](https://github.com/rupertgermann/codex-explorer/issues/47).

Focused tests additionally cover reset tolerance and tie ordering, nonchronological quota cycles, local-day boundaries in both daylight-saving transitions, fractional grid origins, duplicate session IDs, filtered reports, empty buckets, zero-duration sessions and complete CSV serialization. Browser tests exercise the quota controls and both session export kinds. No private archives or saved reports were used.
