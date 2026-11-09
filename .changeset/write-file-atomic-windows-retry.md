---
'@ayagmar/agent-sessions': patch
---

`writeFileAtomic` now retries the final rename for about a second when it fails with EPERM, EACCES or EBUSY, which Windows returns while another process (a reader, an antivirus scan) briefly holds the file open. Before, such a write failed at once.
