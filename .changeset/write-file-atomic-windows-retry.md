---
'@ayagmar/agent-sessions': patch
---

`writeFileAtomic` now retries the final rename for about 0.4 s when it fails with EPERM, EACCES or EBUSY, which Windows returns while another process (a reader, an antivirus scan) briefly holds the file open. Before, such a write failed at once.

`isShortLivedWindowsRefusal` (internal) names those codes once, for `writeFileAtomic` and the CLI file lock.
