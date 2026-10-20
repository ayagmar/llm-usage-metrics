| Block                             | Source | Models              | Events | Input | Output | Reasoning | Cache Read | Cache Write |  Total |  Cost |
| :-------------------------------- | :----- | :------------------ | -----: | ----: | -----: | --------: | ---------: | ----------: | -----: | ----: |
| 2026-06-15 08:00-13:00            | codex  | • gpt-5             |      2 | 6,500 |  1,300 |         0 |      2,000 |           0 |  9,800 | $0.02 |
| 2026-06-15 09:00-14:00            | claude | • claude-sonnet-4-5 |      4 | 4,900 |  1,250 |         0 |     10,000 |           0 | 16,150 | $0.04 |
| 2026-06-15 13:00-18:00            | codex  | • gpt-5             |      2 | 2,700 |    400 |         0 |          0 |           0 |  3,100 | $0.01 |
| 2026-06-15 18:00-23:00            | claude | • claude-sonnet-4-5 |      1 | 3,000 |    900 |         0 |          0 |           0 |  3,900 | $0.02 |
| 2026-06-15 21:00-02:00 \(+1d\)    | codex  | • gpt-5             |      1 |   700 |     90 |         0 |          0 |           0 |    790 | $0.00 |
| 2026-06-20 22:00-03:00 \(+1d\)    | claude | • claude-sonnet-4-5 |      2 | 3,200 |    650 |         0 |          0 |           0 |  3,850 | $0.02 |
| 2026-06-21 10:00-15:00 \(active\) | claude | • claude-sonnet-4-5 |      1 | 5,000 |  1,200 |         0 |     20,000 |           0 | 26,200 | $0.04 |
| 2026-06-21 10:00-15:00 \(active\) | codex  | • gpt-5             |      2 | 4,500 |    800 |         0 |          0 |           0 |  5,300 | $0.01 |

Blocks are estimated: each starts on the whole UTC hour at or before a source's first event after the previous block and lasts 5 hours, across machines. Times are in UTC. A block that overlaps the start of the window counts in full.

Active block \(estimated\), claude: ends 2026-06-21 15:00, 3h 0m left, burn rate $0.02/h, 13.1K tokens/h.

Active block \(estimated\), codex: ends 2026-06-21 15:00, 3h 0m left, burn rate $0.01/h, 2.65K tokens/h.
