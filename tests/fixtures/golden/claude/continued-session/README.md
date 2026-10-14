# Claude session continued in a new file

Imitates a Claude Desktop session that was continued in a new session. Claude Code writes a second transcript with a new `sessionId` (`cont-b`) and repeats the rows of the first one (`cont-a`) verbatim: same `message.id`, `requestId`, `timestamp` and `usage`. It then adds two new rows.

`session-a.jsonl` holds 3 assistant rows. `session-b.jsonl` holds those 3 rows under `cont-b` plus 2 new ones.

Freezes KI-4. The adapter returns 3 and 5 events because it parses each file on its own. A report counts 5 events because `countCopiedSessionEventsOnce` drops the copies, so KI-4 is not reproduced at report level. Test: `tests/sources/claude/claude-continued-session-fixture.test.ts`.
