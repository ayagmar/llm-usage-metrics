# Changelog

## [0.8.0](https://github.com/ayagmar/llm-usage-metrics/compare/v0.7.2...v0.8.0) (2026-07-13)

### ⚠ BREAKING CHANGES

* **render:** --json output is now wrapped in the schemaVersion 1
envelope; former payloads live under .data. compare --json no longer
includes diagnostics.
* **reports:** --json field renames: savingsPct -> savingsRatio
(optimize), deltaPercent -> deltaRatio (compare), totalCostUsd ->
costUsd (wrapped).
* **config:** retire the tuning env vars in favor of config keys
* **config:** read user config from TOML
* **cli:** replace the parse cache with the sqlite event store

### Features

* **cli:** add --history to serve departed-file usage from the event store ([26eeb64](https://github.com/ayagmar/llm-usage-metrics/commit/26eeb642e5f084b2556e3f8aaed4dd247998de41))
* **cli:** add --openclaw-dir override flag ([1095f69](https://github.com/ayagmar/llm-usage-metrics/commit/1095f692ef9724b5f5d23da667714518781529f2))
* **cli:** add a parse-worker entry branch to the CLI bundle ([99733eb](https://github.com/ayagmar/llm-usage-metrics/commit/99733eb5a4c50bb7468409da92b9be56c9ed4597))
* **cli:** add compare command with period-vs-period deltas ([f1c6fab](https://github.com/ayagmar/llm-usage-metrics/commit/f1c6fabe431b62279d7b0ecbf9938faa20226468))
* **cli:** add config init with a commented default template ([12e30e3](https://github.com/ayagmar/llm-usage-metrics/commit/12e30e3da339b21f64471fe08cd7fb0c6af614dd))
* **cli:** add doctor command for source discovery health ([e529f64](https://github.com/ayagmar/llm-usage-metrics/commit/e529f6443f10887e7c23de44ba2c6b97bf960797))
* **cli:** add events export command (jsonl, csv) ([627fded](https://github.com/ayagmar/llm-usage-metrics/commit/627fdedf7f30e631d88077fa81b9223b20ed6288))
* **cli:** add logLevel config and a --quiet flag ([aab0fb0](https://github.com/ayagmar/llm-usage-metrics/commit/aab0fb08d17574eea689593353afa45691c33fee))
* **cli:** add provider and model filters to wrapped ([b2c5476](https://github.com/ayagmar/llm-usage-metrics/commit/b2c54767b207261447245c6a4e0db140baa6658b))
* **cli:** add prune for explicit event-store maintenance ([528a16d](https://github.com/ayagmar/llm-usage-metrics/commit/528a16d181fc801b21014d01e87ad55619cdf2ce))
* **cli:** add schema command exposing bundled report schemas ([4f2b6e7](https://github.com/ayagmar/llm-usage-metrics/commit/4f2b6e7408d1b48273d3feee1b718d1435f2a05a))
* **cli:** add session report command ([ed25850](https://github.com/ayagmar/llm-usage-metrics/commit/ed25850944d6f51f432fb8762c9ae743039ecc0a))
* **cli:** add wrapped command with share SVG ([1e13b63](https://github.com/ayagmar/llm-usage-metrics/commit/1e13b637709e45e1d36347614fc1b093896a5c44))
* **cli:** give wrapped a styled terminal recap ([54caaae](https://github.com/ayagmar/llm-usage-metrics/commit/54caaae4813a468f51f1d26679b4f64ac1d1ff74))
* **cli:** ingest parsed events into the store behind LLM_USAGE_EVENT_STORE ([3ce234e](https://github.com/ayagmar/llm-usage-metrics/commit/3ce234ed7e724f60ad974bc96bbf99fd3d31049f))
* **cli:** level-gate the shared logger ([96cb516](https://github.com/ayagmar/llm-usage-metrics/commit/96cb51627e0a9efccfd4dcccc03d2b6c989952f8))
* **cli:** parse large jsonl sources on the worker pool ([8753845](https://github.com/ayagmar/llm-usage-metrics/commit/8753845b1e8b08b42d5bac5b9777772a4d14a747))
* **cli:** replace the parse cache with the sqlite event store ([54879db](https://github.com/ayagmar/llm-usage-metrics/commit/54879db97dbb0a34cf9d7397a1bc8247695d4b75))
* **cli:** resolve compare windows and build compare data ([08eb8b2](https://github.com/ayagmar/llm-usage-metrics/commit/08eb8b247d83d1c92c2d23a7f4a735a95876cda5))
* **cli:** serve unchanged files from the event store ([8e1ed60](https://github.com/ayagmar/llm-usage-metrics/commit/8e1ed60bbb86ae4476049aba7e5906cf8375a673))
* **cli:** session default top 20, slimmer table, and limit diagnostics ([7e65ca3](https://github.com/ayagmar/llm-usage-metrics/commit/7e65ca32aae83d97276ba035d1cacda5b1e2eee3))
* **compare:** add share svg export ([127666b](https://github.com/ayagmar/llm-usage-metrics/commit/127666b79880806fdc5013b94975bf03e77b74e2))
* **config:** add config show and config path subcommands ([1cf98f6](https://github.com/ayagmar/llm-usage-metrics/commit/1cf98f6b4e00dfa52a3ee6d60493c978005d8066))
* **config:** add parseWorkers and parseWorkerMinBytes settings ([033b6ff](https://github.com/ayagmar/llm-usage-metrics/commit/033b6ffd81640b9127fa493fe82271b0919c321e))
* **config:** apply config below flags and env across the CLI ([1d80875](https://github.com/ayagmar/llm-usage-metrics/commit/1d808756886093e2da0e17a3cdafa75dc58255c5))
* **config:** load a user config file with a published JSON schema ([434539d](https://github.com/ayagmar/llm-usage-metrics/commit/434539d540aad8ddc685997edee93dc26c3fcbc5))
* **config:** read user config from TOML ([83cfe7b](https://github.com/ayagmar/llm-usage-metrics/commit/83cfe7b5706290271912642871e13010cb1aef54))
* **config:** retire the tuning env vars in favor of config keys ([a2dcd08](https://github.com/ayagmar/llm-usage-metrics/commit/a2dcd087fc7d2fd168c702cd0ac32e3fe4198025))
* **efficiency:** aggregate per-source rows behind --by-source ([b7ed718](https://github.com/ayagmar/llm-usage-metrics/commit/b7ed71854b98b72a3bb5acd398b0fac230471e70))
* **efficiency:** render the by-source view ([ba04c3b](https://github.com/ayagmar/llm-usage-metrics/commit/ba04c3bcd8344de5a7c185929f88c92f358d2bf1))
* **persistence:** add sqlite event store with per-file replace ingest ([941b1dc](https://github.com/ayagmar/llm-usage-metrics/commit/941b1dc01d746b79a125ce8ddbf7387ce7a45e81))
* **persistence:** expose departed-file classification, deletion, and vacuum ([367c25c](https://github.com/ayagmar/llm-usage-metrics/commit/367c25c55b863a2691d4ff31bf0ae1a636f99b4b))
* **persistence:** migrate the event store to a ledger with content hashes ([55d44e1](https://github.com/ayagmar/llm-usage-metrics/commit/55d44e1bfd7b6bdc64e22dd638e0897a7c6d8ba3))
* **pricing:** add a generated LiteLLM pricing snapshot ([ed4fcda](https://github.com/ayagmar/llm-usage-metrics/commit/ed4fcda378218b5b569b4f05be5c7d7d25332e9a))
* **pricing:** fall back to the bundled snapshot when cache and network fail ([ecb1570](https://github.com/ayagmar/llm-usage-metrics/commit/ecb1570d78e40b76b2afb47cc7f7fdd75291cacb))
* **render:** consistent empty-state message for usage and compare ([f905dd6](https://github.com/ayagmar/llm-usage-metrics/commit/f905dd6fcac2bf9d86e55f0f9e18670d4da7fd1f))
* **render:** wrap report json output in a versioned envelope ([c61a567](https://github.com/ayagmar/llm-usage-metrics/commit/c61a567c13fd54010e716ac86de81ca8d0162d56))
* **reports:** refresh output and product presentation ([f351c8a](https://github.com/ayagmar/llm-usage-metrics/commit/f351c8aa50b2e94b59ebc85e956bec3cac7b69d8))
* **session:** add repo attribution, --id filter, and --by-repo grouping ([ba7f48a](https://github.com/ayagmar/llm-usage-metrics/commit/ba7f48a6ae616c82340c02b1ae4a220315bbe542))
* **session:** add session aggregation ([3beba6a](https://github.com/ayagmar/llm-usage-metrics/commit/3beba6a5b446f63c5e5b4c701a21e65ca963e29c))
* **session:** compute session duration and gap-capped active time ([e048515](https://github.com/ayagmar/llm-usage-metrics/commit/e048515a294f746cd53e020cb3a5e35d41026043))
* **session:** show session duration column ([2ff8efa](https://github.com/ayagmar/llm-usage-metrics/commit/2ff8efac8d0120c3b7b44642ada566b070617d29))
* **site:** animate the landing page and use real report output ([923cfaa](https://github.com/ayagmar/llm-usage-metrics/commit/923cfaa918cf4acb237a400248e7ce4d067c08b7))
* **site:** refine landing theme and performance ([e763909](https://github.com/ayagmar/llm-usage-metrics/commit/e7639095699585bcdf3eea0eab172c5d20cf296f))
* **site:** refresh brand mark and add DeepWiki ([f0fe212](https://github.com/ayagmar/llm-usage-metrics/commit/f0fe21234a11224dcd604ff896a447c2d8197a1a))
* **source:** add amp adapter ([0aa4e22](https://github.com/ayagmar/llm-usage-metrics/commit/0aa4e222a53e351d2820e8b1f7221c2e35cfb327))
* **source:** add antigravity adapter ([cf13c10](https://github.com/ayagmar/llm-usage-metrics/commit/cf13c107bd76ebb28bbbdbf2398b76664cac345e))
* **source:** add antigravity protobuf reader ([b75b913](https://github.com/ayagmar/llm-usage-metrics/commit/b75b9134f6766ba045b149bda39f0f62d5b19478))
* **source:** add cline-family task parser and cline adapter ([5811177](https://github.com/ayagmar/llm-usage-metrics/commit/58111772c799bb8cb27c3eafa48aa9778de62637))
* **source:** add GitHub Copilot CLI adapter ([7d4292b](https://github.com/ayagmar/llm-usage-metrics/commit/7d4292bf53b6bbfbdf516027547249fa0a3fc8bf))
* **source:** add goose adapter ([fde72f7](https://github.com/ayagmar/llm-usage-metrics/commit/fde72f73f6f638d4de3128d5d23ab404a4583fdb))
* **source:** add kimi adapter ([1d39df4](https://github.com/ayagmar/llm-usage-metrics/commit/1d39df4700898269376ad45924e8dd24fdaea2ee))
* **source:** add parse diagnostics to codex adapter ([cce2863](https://github.com/ayagmar/llm-usage-metrics/commit/cce28639a91c89213716c5e7270a6fb12672fb47))
* **source:** add parse diagnostics to pi adapter ([c5e1b3f](https://github.com/ayagmar/llm-usage-metrics/commit/c5e1b3ffc76e0d0c753bf9f40128d9c2deb79379))
* **source:** add qwen adapter ([de0a125](https://github.com/ayagmar/llm-usage-metrics/commit/de0a125376455e010e71cb309ae8cf335c2f1a9f))
* **source:** register roocode and kilocode adapters ([669f1a3](https://github.com/ayagmar/llm-usage-metrics/commit/669f1a30c8d2928b2575990f29eb4c7c92e48f25))
* **sources:** register moonshot provider root and kimi fixed roots ([62f0a73](https://github.com/ayagmar/llm-usage-metrics/commit/62f0a733abad9d4823365a8b35a5355c967cb372))
* **sources:** scan claude transcripts, oh-my-pi, and legacy openclaw homes by default ([d8c7ae3](https://github.com/ayagmar/llm-usage-metrics/commit/d8c7ae3008544b43128b24d069aa5582186e332a))
* **sources:** support opencode channel databases and GEMINI_CLI_HOME ([34b3afd](https://github.com/ayagmar/llm-usage-metrics/commit/34b3afd42c48e7813c5bc001c7c30dd87041f6ac))
* **trends:** add --share SVG export ([f5c36a2](https://github.com/ayagmar/llm-usage-metrics/commit/f5c36a27fff384632b5ea073da64920c1866ba5a))
* **trends:** add active-hours metric ([10efd05](https://github.com/ayagmar/llm-usage-metrics/commit/10efd057de4532b7134a2e62ba93f8297d650bd8))
* **trends:** add markdown output ([40b2d5b](https://github.com/ayagmar/llm-usage-metrics/commit/40b2d5b33d80cdacf2a242833217d0a8255a3771))
* **wrapped:** add markdown output ([634656e](https://github.com/ayagmar/llm-usage-metrics/commit/634656e25e953713b8da7094d6b909e3c69cdbf2))
* **wrapped:** add yearly recap aggregation ([c9d9d68](https://github.com/ayagmar/llm-usage-metrics/commit/c9d9d68a7630c288c20f00b167b344211827f628))
* **wrapped:** aggregate active time and time-pattern stats ([d7bbdb2](https://github.com/ayagmar/llm-usage-metrics/commit/d7bbdb26997e6024a04b00bc4de7c5504fc697e6))
* **wrapped:** estimate cache savings ([d13d736](https://github.com/ayagmar/llm-usage-metrics/commit/d13d736b53b8ce3fc5e865c9806741cbc06fd437))
* **wrapped:** surface hours, time patterns, and cache savings ([bb8dcf4](https://github.com/ayagmar/llm-usage-metrics/commit/bb8dcf48e176ab2667a83df9ac0f8f2a53218167))

### Bug Fixes

* **cli:** apply user config to doctor and surface it on prune ([b101d71](https://github.com/ayagmar/llm-usage-metrics/commit/b101d714987923102001e068a6fa0d1a3c44de8f))
* **cli:** event-store review cleanups ([066babe](https://github.com/ayagmar/llm-usage-metrics/commit/066babe60385b4db1b06ef562d34ba6e4f549e2e))
* **cli:** keep a source's events when a single file fails to parse ([c40b943](https://github.com/ayagmar/llm-usage-metrics/commit/c40b9434601b65768d3913e0442714c7fd3f4626))
* **cli:** recover parse workers that exit or reply malformed ([66d7a79](https://github.com/ayagmar/llm-usage-metrics/commit/66d7a79fb8e1eb92a2bc2e256562d998df41d8fc))
* **cli:** report event-store env overrides in diagnostics again ([f8b7374](https://github.com/ayagmar/llm-usage-metrics/commit/f8b73744d365dfdd7bc798868edd384142552752))
* **cli:** report how the event store was disabled ([357f910](https://github.com/ayagmar/llm-usage-metrics/commit/357f910dab54fe36bb63630a60a56ebed59c0bff))
* **cli:** restrict --history to successfully parsed sources ([a27c10a](https://github.com/ayagmar/llm-usage-metrics/commit/a27c10a579f34fa0cb6c51a41f344f5ebd22135c))
* **cli:** show the real default store path in the config template ([28f0aa3](https://github.com/ayagmar/llm-usage-metrics/commit/28f0aa3be77130f1502a539a1363a79b73e29206))
* **cli:** unblock help on malformed config and polish config visibility ([c03a4e9](https://github.com/ayagmar/llm-usage-metrics/commit/c03a4e9a93a539d35ff2fa99684a6de3722e8721))
* **docs:** generate cli reference sections for all config subcommands ([5bae099](https://github.com/ayagmar/llm-usage-metrics/commit/5bae099bd4561183141ff66945097b41dd4649da))
* **efficiency:** skip malformed git commit boundaries ([2702d22](https://github.com/ayagmar/llm-usage-metrics/commit/2702d2208fd47dc6e0cd18d0a10d07175d014a42))
* **events:** neutralize spreadsheet formula triggers in csv export ([9dd8e26](https://github.com/ayagmar/llm-usage-metrics/commit/9dd8e26215a9f9e8ec7daa17e6c9aeb6e0105cfd))
* **perf:** isolate the report baseline from user state ([a0ccf4a](https://github.com/ayagmar/llm-usage-metrics/commit/a0ccf4a2c5b76a97d296bd46b7e03d7dddd36faf))
* **persistence:** busy timeout, WAL, and read-only doctor access ([0775a40](https://github.com/ayagmar/llm-usage-metrics/commit/0775a405eb772fba4ac4057613509d048f19d410))
* **persistence:** keep ledger reads non-mutating and migration poison-safe ([63344f0](https://github.com/ayagmar/llm-usage-metrics/commit/63344f00ea9b50f3c972a67e932534acd9d8eb93))
* **pricing:** alias gemini-3-flash-a family to priced keys ([1c2d398](https://github.com/ayagmar/llm-usage-metrics/commit/1c2d398fd580ced10b8a689bd88198e868c7a81f))
* **pricing:** bound model names before fuzzy matching ([f356377](https://github.com/ayagmar/llm-usage-metrics/commit/f35637710d5c9530837c4bc6b75b17a157adf5cd))
* **pricing:** let the model map veto fuzzy matching for listed models ([b6e0b86](https://github.com/ayagmar/llm-usage-metrics/commit/b6e0b862557786d0ab17c0ccd4686f86f7813909))
* **pricing:** reject negative override rates ([448dcf1](https://github.com/ayagmar/llm-usage-metrics/commit/448dcf1e754532b60da1b570a3113148ffa7efe8))
* **render:** sort efficiency share periods by code point ([1f12294](https://github.com/ayagmar/llm-usage-metrics/commit/1f122948459778365d09075415e44b36f44d6a98))
* **render:** wrap usage share source pills across rows ([0d0053b](https://github.com/ayagmar/llm-usage-metrics/commit/0d0053b0b7543e158b0b79d52d8798a7b3565834))
* **security:** cap LiteLLM pricing response size ([efa540f](https://github.com/ayagmar/llm-usage-metrics/commit/efa540f40a7c9aee87a722c013b72cb8b99a0ead))
* **security:** restrict event-store file permissions ([66e3926](https://github.com/ayagmar/llm-usage-metrics/commit/66e392670bf8fb60af1e0e980dbd7c4286b8a341))
* **security:** strip control characters from session-derived strings ([c365ba6](https://github.com/ayagmar/llm-usage-metrics/commit/c365ba6fdd7a55eb5b4697d6d69e27d4200bdb2e))
* **source:** cap json transcript file size before parse ([632e541](https://github.com/ayagmar/llm-usage-metrics/commit/632e541c35ff737c35662152a2d9006ca0f0ed01))
* **source:** count claude retries separately via requestId dedup ([a4195ac](https://github.com/ayagmar/llm-usage-metrics/commit/a4195ac3aaef316234a9cd7a917439f9026d62f1))
* **source:** keep same-priority copilot spans sharing a trace ([b49667b](https://github.com/ayagmar/llm-usage-metrics/commit/b49667b0978148983fe1e580c3707768bc30f306))
* **source:** report malformed jsonl rows ([94e8b68](https://github.com/ayagmar/llm-usage-metrics/commit/94e8b6869779f5af93d24b812c8ef904be2b5f36))
* **source:** resolve kimi model from config with timestamp fallback ([8ff5846](https://github.com/ayagmar/llm-usage-metrics/commit/8ff5846e53736e8cbf406d98d3ad8ecf3e6b9ddb))
* **store:** check schema version before switching journal mode ([d1e5f4f](https://github.com/ayagmar/llm-usage-metrics/commit/d1e5f4fc92607483c38cc2974ab0c64db3200c24))
* **store:** include session id in event content hashes ([666f721](https://github.com/ayagmar/llm-usage-metrics/commit/666f721ae56bf0e43ee00e9aebc7f3d58bf03a0d))
* **store:** page migration rehash in batches ([a35181b](https://github.com/ayagmar/llm-usage-metrics/commit/a35181bef95a5ffc98850aabfff2fef55762ff9e))
* **test:** keep the event store out of real user state during tests ([ef17eec](https://github.com/ayagmar/llm-usage-metrics/commit/ef17eecaeb9174c6536a25d4342d91fc75bda4c8))

### Performance Improvements

* **cli:** dispatch worker misses in one pass ([f972fc5](https://github.com/ayagmar/llm-usage-metrics/commit/f972fc513e5607be39ba4c9aef2543bbf50478bc))
* **cli:** skip date bucketing when no date filters are set ([5b33f0f](https://github.com/ayagmar/llm-usage-metrics/commit/5b33f0f882ff4fb20e4fce90b06f6a7469ebfdc3))
* **persistence:** fast-path stored event materialization ([5eb97a8](https://github.com/ayagmar/llm-usage-metrics/commit/5eb97a8f9d8ed04a7e7cb6d2b7428eeb18e18d2f))
* **persistence:** prepare hot event-store statements once per connection ([12e06a9](https://github.com/ayagmar/llm-usage-metrics/commit/12e06a9c6c4ad2b64a82e18d6c683d5a07f004d6))
* **source:** skip non-usage jsonl lines before utf8 decode ([3aa8e91](https://github.com/ayagmar/llm-usage-metrics/commit/3aa8e9126162b4265eff6bc64d1cf4be4a37a8a1))
* **source:** snapshot gemini project mapping per run ([555d3f8](https://github.com/ayagmar/llm-usage-metrics/commit/555d3f824cf8cddf8949cc330e54105b8c3bf658))
* **store:** batch history event selection ([40c7e75](https://github.com/ayagmar/llm-usage-metrics/commit/40c7e7502592da438820d0e7d9242e417eab1eae))
* **update:** bound notifier latency at cli exit ([860d40a](https://github.com/ayagmar/llm-usage-metrics/commit/860d40a74485714b799c4dacbc1c4ec5bdfd15a2))
* **utils:** cache local-date windows in time bucketing ([672a2f7](https://github.com/ayagmar/llm-usage-metrics/commit/672a2f78c12587c21b2737248d73cd1bd5ff8b10))
* **utils:** scan jsonl lines from binary chunks instead of readline ([fccba83](https://github.com/ayagmar/llm-usage-metrics/commit/fccba83c4c8fd14fba63dbd399578aeb98e3751c))

### Code Refactoring

* **reports:** rename ratio and wrapped cost fields ([dd17a44](https://github.com/ayagmar/llm-usage-metrics/commit/dd17a44617c2e8fc8fa85f9d4ed0e729fdeb62af))

## [0.7.2](https://github.com/ayagmar/llm-usage-metrics/compare/v0.7.1...v0.7.2) (2026-07-03)

### Features

* **source:** add OpenClaw adapter ([#123](https://github.com/ayagmar/llm-usage-metrics/issues/123)) ([6fd69cb](https://github.com/ayagmar/llm-usage-metrics/commit/6fd69cb9c9c5542fda86a965380440314d987d70))

## [0.7.1](https://github.com/ayagmar/llm-usage-metrics/compare/v0.7.0...v0.7.1) (2026-06-25)

### Features

* **pricing:** per-model pricing overrides and claude dedup hardening ([191fe0d](https://github.com/ayagmar/llm-usage-metrics/commit/191fe0dd3eaa4026158a779087342d6fb599d635))

### Bug Fixes

* **pricing:** report bad --pricing-overrides path accurately ([ace9184](https://github.com/ayagmar/llm-usage-metrics/commit/ace9184dd9a8a531359659e0a565d6b3760b1da5))
* **security:** bump vite override to 8.1.0 for astro 7 ([b13ef53](https://github.com/ayagmar/llm-usage-metrics/commit/b13ef53ede00b53c4d463fda0edb655ebaf7a55e))
* **update:** prompt consistently on stale cache across commands ([8557946](https://github.com/ayagmar/llm-usage-metrics/commit/8557946b18c6a824d94fd8f8a70b23c657a0631a))

## [0.7.0](https://github.com/ayagmar/llm-usage-metrics/compare/v0.6.0...v0.7.0) (2026-06-25)

### Features

* enhance CLI reference generation and improve Mermaid validation logic ([fdb3947](https://github.com/ayagmar/llm-usage-metrics/commit/fdb3947938a42d9f67bf7f3a221bde6a4d1a8b20))
* integrate claude ([d77ed4d](https://github.com/ayagmar/llm-usage-metrics/commit/d77ed4d0ccab2c325537ac7e32d13b63564bdefa))
* update CLI reference formatting for improved readability ([f410c4d](https://github.com/ayagmar/llm-usage-metrics/commit/f410c4d1b670d8b984e14d88c649f986f7745503))

### Bug Fixes

* **cli:** harden opener resolution and CLI reference escaping ([1e8184f](https://github.com/ayagmar/llm-usage-metrics/commit/1e8184f26e6d4db4ec2ef3e07c4fbd6810e57b0e))
* **repo:** patch audit issues and harden markdown output ([9f19fdc](https://github.com/ayagmar/llm-usage-metrics/commit/9f19fdc0901b77044aec24b1d477c51a6f82f416))
* **security:** patch transitive dev-dependency vulnerabilities ([99053d6](https://github.com/ayagmar/llm-usage-metrics/commit/99053d64d504ba254bc4ac79efd2e1e182105182))

## [0.6.0](https://github.com/ayagmar/llm-usage-metrics/compare/v0.5.2...v0.6.0) (2026-03-11)

### Bug Fixes

* **render:** close remaining codecov gaps ([4d0b77f](https://github.com/ayagmar/llm-usage-metrics/commit/4d0b77f62eb8b0caca27b1c7f14552dea4324e5d))
* **render:** enhance terminal and Markdown table output for better readability and model ranking ([bdf973d](https://github.com/ayagmar/llm-usage-metrics/commit/bdf973deba185937c33be4cb73dfc6e947b1ffef))
* **render:** escape bare markdown autolinks ([7f33772](https://github.com/ayagmar/llm-usage-metrics/commit/7f3377246487941ad392dc35682484faf48a765a))
* **render:** harden markdown escaping and model styling ([d1e0fa1](https://github.com/ayagmar/llm-usage-metrics/commit/d1e0fa1b22701b82e746bb929dd7dae5af6d02a9))
* **render:** improve terminal usage table readability ([d177c4b](https://github.com/ayagmar/llm-usage-metrics/commit/d177c4ba3829aefc83b95b25bb5ea11c2d2f96db))
* **security:** generate and enforce canonical docs ([9817130](https://github.com/ayagmar/llm-usage-metrics/commit/9817130c592786f1c94ccb93506b0e184df586bd))

## [0.5.2](https://github.com/ayagmar/llm-usage-metrics/compare/v0.5.1...v0.5.2) (2026-03-07)

### Bug Fixes

* **reports:** preserve bucket-only and merged usage ([d363649](https://github.com/ayagmar/llm-usage-metrics/commit/d36364941fa56be5ea9fa8eb48667eb4257f0a8f))
* **sources:** harden timestamp and discovery parsing ([3cd9c31](https://github.com/ayagmar/llm-usage-metrics/commit/3cd9c31d21503623f9a4dcf9d21602c6e5e5106f))
* update token handling and enhance file discovery logic ([8bd7e6d](https://github.com/ayagmar/llm-usage-metrics/commit/8bd7e6d1bbf78675bc35574f0323579352c2c43f))

## [0.5.1](https://github.com/ayagmar/llm-usage-metrics/compare/v0.5.0...v0.5.1) (2026-03-07)

### Features

* **cli:** add runtime profiling diagnostics ([ee53c36](https://github.com/ayagmar/llm-usage-metrics/commit/ee53c3694339663919ba3d3c5cc5623c91ff58c8))

### Bug Fixes

* **cache:** make parse cache dependency-aware ([700b0f0](https://github.com/ayagmar/llm-usage-metrics/commit/700b0f0345c14f1a481bf6a65c3dd42d99562539))
* **cli:** address remaining review follow-ups ([8953c1a](https://github.com/ayagmar/llm-usage-metrics/commit/8953c1a1689e918ed14cbebfd6f1a846c1809920))
* **cli:** address review feedback ([be3d244](https://github.com/ayagmar/llm-usage-metrics/commit/be3d244c5c6b0258d3864ff69eae38dc8ddf5bc9))
* **cli:** prune incompatible sources earlier ([69e6c08](https://github.com/ayagmar/llm-usage-metrics/commit/69e6c083c05cdc036374b730f0c71f8e0be9d6fb))
* **cli:** reject incompatible explicit sources ([fde6b83](https://github.com/ayagmar/llm-usage-metrics/commit/fde6b832f407c376d23608b675d5711cd4404455))
* **cli:** reject invalid parse cache dependencies ([9c5cc4a](https://github.com/ayagmar/llm-usage-metrics/commit/9c5cc4a9fbed83f31e7fe4fb79e9ab7f11f0ec6d))
* **cli:** reuse usage event dataset in efficiency ([83701ef](https://github.com/ayagmar/llm-usage-metrics/commit/83701efd4cda6550d2c3c67739efe04f2455b61d))
* **cli:** tighten review follow-up behavior ([0c1414a](https://github.com/ayagmar/llm-usage-metrics/commit/0c1414a276fcb4abf17ed4e53b6e4433d14560ef))
* **index:** update command descriptions and add trends command ([c16fc6b](https://github.com/ayagmar/llm-usage-metrics/commit/c16fc6b8cf07c1377e6d7f0abf0076bcd5815e0f))
* **pricing:** align optimize and usage semantics ([af5850f](https://github.com/ayagmar/llm-usage-metrics/commit/af5850fc67ad660f0ea38468c71626238bd1ef04))
* **pricing:** enhance cost estimation logic and add alias resolution in tests ([0185402](https://github.com/ayagmar/llm-usage-metrics/commit/01854026a6745925fbb05e52d29afedb1a3ada58))
* **render:** compress empty edges in trends charts ([795f4e5](https://github.com/ayagmar/llm-usage-metrics/commit/795f4e59fdfcb4f4e3fd14f465428dc61b508851))
* **render:** preserve visible activity in trends charts ([03e0e4a](https://github.com/ayagmar/llm-usage-metrics/commit/03e0e4a5ff13edc6f6a7db79cf199ef60cc74319))
* **tests:** enhance error handling and add tests for cache and adapter functionality ([154b440](https://github.com/ayagmar/llm-usage-metrics/commit/154b4404b6bfc49dc6b97f1489c21626394c26cd))
* **update:** refresh stale checks in background ([e5cac9b](https://github.com/ayagmar/llm-usage-metrics/commit/e5cac9b506c2e62f2736bc0158dc054a2549d24d))

## [0.5.0](https://github.com/ayagmar/llm-usage-metrics/compare/v0.4.3...v0.5.0) (2026-03-06)

### Features

* **cli:** rewrite report runtime and add trends ([54a7e7a](https://github.com/ayagmar/llm-usage-metrics/commit/54a7e7af3ef39ce2b0ad27dc253f1faffc39b9d3))

### Bug Fixes

* **trends:** address review feedback and coverage gaps ([f641461](https://github.com/ayagmar/llm-usage-metrics/commit/f6414613141bcf9955806344f470c3f4b63cd1a4))

## [0.4.3](https://github.com/ayagmar/llm-usage-metrics/compare/v0.4.2...v0.4.3) (2026-03-06)

### Bug Fixes

* **cli:** open share svgs with default app ([792d498](https://github.com/ayagmar/llm-usage-metrics/commit/792d49884d9baa240e86e132d90ee4c39fe9b02b))
* **cli:** reject share opener on non-zero exit ([bdcadd1](https://github.com/ayagmar/llm-usage-metrics/commit/bdcadd16dc5234ccbe27286e16b16ae349802de4))
* **cli:** stop waiting on detached share opener ([7b8e0ab](https://github.com/ayagmar/llm-usage-metrics/commit/7b8e0ab48c96cf7ac6361f23bdf2f66c1c5869f0))
* **render:** prevent share svg stat and pill overlap ([efd48c1](https://github.com/ayagmar/llm-usage-metrics/commit/efd48c1985836fd29ee238cb52752c37fdeddc16))
* **test:** disable share opener in automated environments ([262ca9f](https://github.com/ayagmar/llm-usage-metrics/commit/262ca9f777fc56351f996b7773719aec456dff84))
* **test:** stub share write/open helper in report suites ([ddda321](https://github.com/ayagmar/llm-usage-metrics/commit/ddda321e76f9377428ec5c510a51166dc01797a2))
* **test:** use regexp exec in share svg regression test ([58a2303](https://github.com/ayagmar/llm-usage-metrics/commit/58a2303341a83c82cd1c6adf35f3bf60065c2743))
* update stale efficiency SVG description and improve test coverage ([90678d2](https://github.com/ayagmar/llm-usage-metrics/commit/90678d2eda3b386bd663616e048f6e5daa02925a))

## [0.4.2](https://github.com/ayagmar/llm-usage-metrics/compare/v0.4.1...v0.4.2) (2026-03-02)

### Bug Fixes

* **render:** consolidate defs block and add missing escapeSvg ([d27fbb9](https://github.com/ayagmar/llm-usage-metrics/commit/d27fbb916d46d7e14770cba3c9bb4a2a93269b1c))

## [0.4.1](https://github.com/ayagmar/llm-usage-metrics/compare/v0.4.0...v0.4.1) (2026-03-02)

### Features

* **cli:** add --share to usage commands with stacked area chart ([91a13b4](https://github.com/ayagmar/llm-usage-metrics/commit/91a13b497228a6d155999fb3332eb3e24f999355))
* **cli:** wire efficiency and optimize share to restyled renderers ([3c35e5d](https://github.com/ayagmar/llm-usage-metrics/commit/3c35e5d3f6ae368fcb80f97d9ee1ee91bf5199d9))
* **render:** add shared dark-theme SVG design system ([d174214](https://github.com/ayagmar/llm-usage-metrics/commit/d1742142bf3491e3b136c5c273c8920d80d42440)), closes [#0d1117](https://github.com/ayagmar/llm-usage-metrics/issues/0d1117)
* **site:** redesign landing page with modern layout and animations ([e4d4018](https://github.com/ayagmar/llm-usage-metrics/commit/e4d401873e342e12586093b9b1073a7a8bf811db))

### Bug Fixes

* **efficiency:** use non-cache tokens for Tokens/Commit metric ([38650d7](https://github.com/ayagmar/llm-usage-metrics/commit/38650d789755b772fe9e26e6f0b88d638140e25f))
* **render:** show actual max on axis label when all values are zero ([fffebe9](https://github.com/ayagmar/llm-usage-metrics/commit/fffebe9cdf479c417b4286336b387c73392d4355))

## [0.4.0](https://github.com/ayagmar/llm-usage-metrics/compare/v0.3.7...v0.4.0) (2026-03-01)

### Bug Fixes

* **codex:** avoid duplicate token_count double counting ([60d96b3](https://github.com/ayagmar/llm-usage-metrics/commit/60d96b3ea81b0e95351caaf6334749eb084be50a))

## [0.3.7](https://github.com/ayagmar/llm-usage-metrics/compare/v0.3.6...v0.3.7) (2026-03-01)

### Features

* **cache:** update parse file cache version to 3 and normalize provider handling ([dc6cd3e](https://github.com/ayagmar/llm-usage-metrics/commit/dc6cd3e6144409fa117a300fbf4cb60844defbc5))
* **optimize:** add optimize report command pipeline ([3adc137](https://github.com/ayagmar/llm-usage-metrics/commit/3adc1371ddcd9e473503b5e732d51754a1734df7))
* **provider:** add error handling for unmatched optimize providers and improve test event structure ([ac27044](https://github.com/ayagmar/llm-usage-metrics/commit/ac270445cd66ab2e0eed14177768539d553652bd))
* **render:** add optimize context and hide empty notes column ([e1da80a](https://github.com/ayagmar/llm-usage-metrics/commit/e1da80aba570148ac6f9e0e75ed4a6b763584b52))
* **render:** colorize efficiency terminal table ([4900602](https://github.com/ayagmar/llm-usage-metrics/commit/490060214372c583cd263c90fd326c6483630212))

### Bug Fixes

* **optimize:** allow provider variants and highlight deltas ([ef35183](https://github.com/ayagmar/llm-usage-metrics/commit/ef35183cc6c42a3549ec609a828f22ad1b7e8cf0))
* **optimize:** tighten renderer paths and runner coverage ([4e80b21](https://github.com/ayagmar/llm-usage-metrics/commit/4e80b21d420a430a247a1f6b326075d0ac81467b))
* **optimize:** update candidatesWithMissingPricing to use input candidateModels ([4fedb2a](https://github.com/ayagmar/llm-usage-metrics/commit/4fedb2acfb479b8a5fe31598f29c13f1d7607cbe))
* **provider:** normalize billing entities and disambiguate optimize scope ([eb1dbb4](https://github.com/ayagmar/llm-usage-metrics/commit/eb1dbb42d5b5288bcad422128dfe0e0f7bf33a07))

## [0.3.6](https://github.com/ayagmar/llm-usage-metrics/compare/v0.3.5...v0.3.6) (2026-02-27)

### Bug Fixes

* **droid:** use billable totals and resilient fallback timestamps ([d6ececf](https://github.com/ayagmar/llm-usage-metrics/commit/d6ececf97713b13dc321f2f403c5e02781d06063))
* **pricing:** support cache-write priority fallback ([3edfecc](https://github.com/ayagmar/llm-usage-metrics/commit/3edfecc6868e9a18339090b68cc13ceb59cc4de2))
* **render:** address PR feedback on fitting loop and test cleanup ([6d85c23](https://github.com/ayagmar/llm-usage-metrics/commit/6d85c23f95191134623a88613a7f070af9dff60a))
* **render:** allow efficiency table fitting on 80-col tty ([37b204f](https://github.com/ayagmar/llm-usage-metrics/commit/37b204f952c591b8573da6f3477832d92d2eb825))
* **render:** fit efficiency table to terminal width ([1881937](https://github.com/ayagmar/llm-usage-metrics/commit/188193710016ec6d921bf1c085a7be5865f0666a))
* **render:** harden wrapping guard and simplify test teardown ([52cbee5](https://github.com/ayagmar/llm-usage-metrics/commit/52cbee5428f2fe5c571d391e1e1bcf6293e02398))

### Performance Improvements

* **cli:** shard and harden parse file cache ([417e3c3](https://github.com/ayagmar/llm-usage-metrics/commit/417e3c3fd85fc00e1d36d368984b7a8034f934bd))

## [0.3.5](https://github.com/ayagmar/llm-usage-metrics/compare/v0.3.4...v0.3.5) (2026-02-27)

### Features

* add 'droid' as a selectable data source in bug report template ([e094c6d](https://github.com/ayagmar/llm-usage-metrics/commit/e094c6d33d5224e20a211688807c82f3ad363acf))
* **benchmark:** add source-scoped openai comparisons ([7c714b4](https://github.com/ayagmar/llm-usage-metrics/commit/7c714b4822011b48cbf5b41cf8bf56db36b851a6))
* **sources:** add droid adapter and cli integration ([7d9ad47](https://github.com/ayagmar/llm-usage-metrics/commit/7d9ad470f7596cc3a3ff5b20f08283c97cf01e8b))
* update CLI usage instructions to use latest version in documentation and templates ([232db27](https://github.com/ayagmar/llm-usage-metrics/commit/232db277485a3f5aaa5ebfb1bf3a472f12adb275))
* update metrics and descriptions to include Droid support ([06b4706](https://github.com/ayagmar/llm-usage-metrics/commit/06b47062b343630a5e4378d9bc91af02c2e52b70))

## [0.3.4](https://github.com/ayagmar/llm-usage-metrics/compare/v0.3.3...v0.3.4) (2026-02-26)

### Features

* **pricing:** add direct pricing for gpt-5.3-codex and gemini models ([312700f](https://github.com/ayagmar/llm-usage-metrics/commit/312700fe42229178da3e5f4f319981cf5191cda6))
* **pricing:** add minimax model aliases and pricing details ([e55584c](https://github.com/ayagmar/llm-usage-metrics/commit/e55584c46279bb2065780804a164e0d4adcd4a2b))
* **sources:** add gemini adapter and CLI support ([b463914](https://github.com/ayagmar/llm-usage-metrics/commit/b4639140075bf16312e4deb0948ae175ae231716))
* **utils:** add generic recursive file discovery ([eb870e8](https://github.com/ayagmar/llm-usage-metrics/commit/eb870e873832ff90c212b84ca93b5e45087571c2))

### Bug Fixes

* **gemini:** ignore non-numeric token payload types ([8f04423](https://github.com/ayagmar/llm-usage-metrics/commit/8f044230f6d831f9bb2f98a08d37a55efc783d01))
* **review:** address PR [#25](https://github.com/ayagmar/llm-usage-metrics/issues/25) review feedback ([1d164c9](https://github.com/ayagmar/llm-usage-metrics/commit/1d164c90c5bb3277c98d9fcc8b41dd8174334a6b))

## [0.3.3](https://github.com/ayagmar/llm-usage-metrics/compare/v0.3.2...v0.3.3) (2026-02-25)

### Features

* **ci:** streamline CI workflows by separating performance baseline into its own file and updating dependencies ([50cd769](https://github.com/ayagmar/llm-usage-metrics/commit/50cd7693cccf303ce5bfcc0a0ca852bfc29774ae))
* **cli:** wire efficiency command execution ([4e5682c](https://github.com/ayagmar/llm-usage-metrics/commit/4e5682c5712379f49d8a3153206e6db4468b6d61))
* **efficiency:** add repo attribution and outcome aggregation ([c4f15d4](https://github.com/ayagmar/llm-usage-metrics/commit/c4f15d47ecea9fa9a2fa006d3cefa7b83240412a))
* **efficiency:** count commits only on AI-active repo days ([d36d844](https://github.com/ayagmar/llm-usage-metrics/commit/d36d84499081c3ee0ebf2c8ad509b0fce116ebb6))
* **perf:** add production benchmark runner and docs ([281aaf7](https://github.com/ayagmar/llm-usage-metrics/commit/281aaf74f33a64d25f16a87162cad9ab1f004da8))
* **render:** add efficiency report formatters ([025acd3](https://github.com/ayagmar/llm-usage-metrics/commit/025acd3326f69fda9bbcc0ceca83492144cac014))
* **sources:** capture repo roots in usage events ([66e6358](https://github.com/ayagmar/llm-usage-metrics/commit/66e6358730f42494cbbc8b43e1e72deabf09bc4b))

### Bug Fixes

* **ci:** skip opencode smoke when sqlite is unavailable ([7c583d9](https://github.com/ayagmar/llm-usage-metrics/commit/7c583d982db22421a97cdacdc873cfbc837b6c02))
* **cli:** continue when pricing load fails ([8e7957a](https://github.com/ayagmar/llm-usage-metrics/commit/8e7957aae44752c896ff59d2702f3c8e849a200e))
* **cli:** harden timezone fallback and update-check env parsing ([eea483b](https://github.com/ayagmar/llm-usage-metrics/commit/eea483bb5a2b4f30c20975a747d5c4917d5b27d6))
* **cli:** resolve remaining PR [#24](https://github.com/ayagmar/llm-usage-metrics/issues/24) review findings ([7d269b1](https://github.com/ayagmar/llm-usage-metrics/commit/7d269b19e6f48ad3ffa0be743860060b33ba4e21))
* **core:** use code-point sorting for deterministic ordering ([9db6761](https://github.com/ayagmar/llm-usage-metrics/commit/9db6761310c9ff566edd1de1275715908a82c43e))
* **efficiency:** clarify all-tokens metric and edge-case tests ([a0bb818](https://github.com/ayagmar/llm-usage-metrics/commit/a0bb818bf769ecc79355aa982a141965917d0b41))
* **efficiency:** handle empty repos and invalid repo-dir paths ([8b5c2ba](https://github.com/ayagmar/llm-usage-metrics/commit/8b5c2ba5241072eec24e4cfc142a9f310f7bb4d4))
* **efficiency:** harden repo attribution and reporting semantics ([706aa05](https://github.com/ayagmar/llm-usage-metrics/commit/706aa0599100dc568ce6f1639977942385a65be6))
* **efficiency:** harden repo-dir and review regressions ([82b129d](https://github.com/ayagmar/llm-usage-metrics/commit/82b129de3c6df6257f6ea5986455ebe4f5e7360b))
* **efficiency:** ignore zero-signal events in active-day attribution ([ed34f63](https://github.com/ayagmar/llm-usage-metrics/commit/ed34f63f85ddf51a0a67d53a1fa4bd9fe5ca1363))
* **efficiency:** require repo-local git author identity ([acfc228](https://github.com/ayagmar/llm-usage-metrics/commit/acfc2287f9cfbc1075002cab57f2b2e542b41423))
* **efficiency:** resolve author email across layered git configs ([a1c43d4](https://github.com/ayagmar/llm-usage-metrics/commit/a1c43d4a79f7fda65dd690c3540343f809e2d212))
* **efficiency:** skip git scan when usage-day set is empty ([61cc76a](https://github.com/ayagmar/llm-usage-metrics/commit/61cc76abe77091d6535d04f1df00a25238ba14da))
* **efficiency:** validate git repo and resolve effective user email ([69475cc](https://github.com/ayagmar/llm-usage-metrics/commit/69475cc5b4877c2076f498a1f27b33197e323885))
* **review:** address remaining CodeRabbit feedback ([da1be12](https://github.com/ayagmar/llm-usage-metrics/commit/da1be127f679112b8457a3e2e75def1ad8b651be))
* **sources:** validate explicit session dirs and drop zero-signal pi rows ([449ecbd](https://github.com/ayagmar/llm-usage-metrics/commit/449ecbd2a24737fc811b326a24cc4534e603ba7c))
* **sources:** validate explicit source paths and JSONL extension ([fc0c85f](https://github.com/ayagmar/llm-usage-metrics/commit/fc0c85fc4c0916003703292a59b54b70609059db))
* **update:** compare prerelease identifiers by code point ([6f6f56b](https://github.com/ayagmar/llm-usage-metrics/commit/6f6f56b77a3f068f317f39d7adc48dbce88b9903))

### Performance Improvements

* **cli:** reduce filtering allocations in parsing path ([dd2357f](https://github.com/ayagmar/llm-usage-metrics/commit/dd2357f2923159f1f345d69166bb55ea1824637b))
* **efficiency:** bound git log by usage-day window ([643ed86](https://github.com/ayagmar/llm-usage-metrics/commit/643ed8669aa978cb5c6d77dd987c5b107c28c769))

## [0.3.2](https://github.com/ayagmar/llm-usage-metrics/compare/v0.3.1...v0.3.2) (2026-02-23)

### Features

* add DeepWiki badge and auto-deploy site on changes ([bf37e4a](https://github.com/ayagmar/llm-usage-metrics/commit/bf37e4abad18febd7d3831be9b07f1c9d0952497))
* **ci:** restructure workflow with parallel jobs and add site linting ([5ee8894](https://github.com/ayagmar/llm-usage-metrics/commit/5ee889453d4894d787d9f0eee5afef9e26b99e3e))
* **docs:** add Mermaid diagram validation script and integrate into CI workflow ([d665152](https://github.com/ayagmar/llm-usage-metrics/commit/d665152ef9b9f3441274d08397a0d014f03c661e))
* **docs:** update homepage URL and enhance footer with links and branding ([7cb6509](https://github.com/ayagmar/llm-usage-metrics/commit/7cb6509a66f338e9dd4d69a1639e78741b48dcf6))
* enhance styling for docs page ([05ddb6e](https://github.com/ayagmar/llm-usage-metrics/commit/05ddb6ec64c4d0eba0d3d12784b2bf7e62bb3b1d))

### Bug Fixes

* **ci:** add main-mermaid to status check and fix coverage upload permissions ([0a81f73](https://github.com/ayagmar/llm-usage-metrics/commit/0a81f7312b227f7344dd551330dbc42ef5b5ddb9))

## [0.3.1](https://github.com/ayagmar/llm-usage-metrics/compare/v0.3.0...v0.3.1) (2026-02-23)

### Bug Fixes

* **docs:** update CLI version in reference to 0.3.0 ([8d5b88a](https://github.com/ayagmar/llm-usage-metrics/commit/8d5b88a80da9b2f398eb79b5a70d40b50936abb8))

## [](https://github.com/ayagmar/llm-usage-metrics/compare/v0.2.1...vnull) (2026-02-23)

### Features

* **site:** refine landing page layout and interactions ([f0b3447](https://github.com/ayagmar/llm-usage-metrics/commit/f0b344792e567385aa9775160791411f88853b0a))
* **site:** T1 foundation scaffold - Astro + Starlight setup ([4ed5503](https://github.com/ayagmar/llm-usage-metrics/commit/4ed5503fb184b7205b37852cf5750706f997c2a2))
* **site:** T2 design system - tokens, typography, responsive foundations ([9983b9e](https://github.com/ayagmar/llm-usage-metrics/commit/9983b9ec0e07b1ca4bfcb142898ec2768d1285a2))
* **site:** T3 landing page - hero, bento, tabs, lightbox, isolated interactivity ([ebbba4b](https://github.com/ayagmar/llm-usage-metrics/commit/ebbba4ba2acef5f01daeaa5b5d77a1feb60e2c1f))
* **site:** T4 docs IA - comprehensive content for all sections, architecture nav ([75cb63a](https://github.com/ayagmar/llm-usage-metrics/commit/75cb63a7a5e902319107450d2f7a6df65afff080))
* **site:** T6 docs automation - CLI reference generator script ([b6ef01a](https://github.com/ayagmar/llm-usage-metrics/commit/b6ef01afafe4d93bb68d5c443ccbc02fdfafce7d))

### Bug Fixes

* **ci:** force fresh CLI build for docs generation ([23893e5](https://github.com/ayagmar/llm-usage-metrics/commit/23893e5798fc61bd523aca4186d1f0de8e1e1841))
* **docs:** include all command options in CLI reference ([bdf3629](https://github.com/ayagmar/llm-usage-metrics/commit/bdf3629f39005475b51dcbc248eaff7fab2256cc))
* **site:** align docs config and canonical links ([e8466e6](https://github.com/ayagmar/llm-usage-metrics/commit/e8466e6fa9a5b9c48009cb4865e04a5113c9ecb8))

## [](https://github.com/ayagmar/llm-usage-metrics/compare/v0.2.0...vnull) (2026-02-22)

### Bug Fixes

* **cli:** restore local pnpm source execution ([6482500](https://github.com/ayagmar/llm-usage-metrics/commit/64825000dd11baa1efabea70c49f3312d591a7f1))
* **lint:** enforce safe assertions in runtime code ([12900ff](https://github.com/ayagmar/llm-usage-metrics/commit/12900ff6d30a0f6d247b12102e5ab21830db0a90))
* **parsing:** close cache bugs and raise test coverage ([9f644f9](https://github.com/ayagmar/llm-usage-metrics/commit/9f644f9422f7dece9bf120b2045673a32e93ccbe))
* **parsing:** harden and simplify parse cache loading ([b4c621c](https://github.com/ayagmar/llm-usage-metrics/commit/b4c621cdc30b98c354900fdf9c7bda405c744871))
* **parsing:** improve cache resilience and trim payload ([2275d18](https://github.com/ayagmar/llm-usage-metrics/commit/2275d18afb841c850819556967173300eb7cc594))
* **parsing:** keep precise mtimes and optimize cache trimming ([443f4b6](https://github.com/ayagmar/llm-usage-metrics/commit/443f4b66388d00dcd4fed25cf93ee35d6b12afa8))

### Performance Improvements

* **parsing:** add bounded parse cache and jsonl prefilters ([9a76986](https://github.com/ayagmar/llm-usage-metrics/commit/9a76986ce623eca3f21a2e56511e62133df586a7))

## [](https://github.com/ayagmar/llm-usage-metrics/compare/v0.1.11...vnull) (2026-02-22)

### Features

* add initial GitHub Pages deployment workflow and site structure ([e96f1c0](https://github.com/ayagmar/llm-usage-metrics/commit/e96f1c000d822e68e1ed6e05df52449dafa164a1))
* add pricing URL validation and normalization; enhance discoverJsonlFiles to skip unreadable directories ([6e32e7c](https://github.com/ayagmar/llm-usage-metrics/commit/6e32e7cf6486172ed2c4786d34e91cdb6f8dd417))
* **diagnostics:** include structured skipped-row reasons ([aa5c983](https://github.com/ayagmar/llm-usage-metrics/commit/aa5c983b3a31b18ca1ac0b214190781ff4a3ab34))
* enhance clipboard copy functionality and improve accessibility ([c5e2783](https://github.com/ayagmar/llm-usage-metrics/commit/c5e2783442d572bffcd2b7c51b4ad69bb97cdd8c))
* enhance cost handling and formatting; add support for streaming query results ([6308e2f](https://github.com/ayagmar/llm-usage-metrics/commit/6308e2fbfb1d41d572f472c466551b78d8d86619))
* enhance navigation links with improved accessibility and styling ([4f333a4](https://github.com/ayagmar/llm-usage-metrics/commit/4f333a43b31376ae2be8c8ef69e3a1bc46f48e79))
* replace terminal visual with screenshot and implement lightbox functionality ([ddae57e](https://github.com/ayagmar/llm-usage-metrics/commit/ddae57e71f78030ffc241baeb3005112db6c7bba))

### Bug Fixes

* **aggregate:** preserve unknown cost semantics and true code-point sort ([286ab95](https://github.com/ayagmar/llm-usage-metrics/commit/286ab95a209052f182fdc4216a03aa11c92c99c6))
* **ci:** setup pnpm before node cache initialization ([ebe0de8](https://github.com/ayagmar/llm-usage-metrics/commit/ebe0de89f427873f039afb88dc40f57e6ea2bdd6))
* **cli:** avoid false terminal overflow hints ([b29c06d](https://github.com/ayagmar/llm-usage-metrics/commit/b29c06dcb4e2cf0b59623947da7210a4ca062fec))
* **eslint:** update file ignores and enhance TypeScript file handling ([648de7e](https://github.com/ayagmar/llm-usage-metrics/commit/648de7ec8b5a1fcc4c08845e16e0d8908f421496))
* **opencode:** close patch coverage gaps ([348a6a5](https://github.com/ayagmar/llm-usage-metrics/commit/348a6a5b48ccd110dc1ac3b7852adc8df46e5c15))
* **output:** improve terminal fit and suppress sqlite warning ([8c7f6bb](https://github.com/ayagmar/llm-usage-metrics/commit/8c7f6bb5c5f521f3e15d7bc0411375d4eec07469))
* **pricing:** retry transient LiteLLM fetch failures ([8d9f16c](https://github.com/ayagmar/llm-usage-metrics/commit/8d9f16c879af45d9ef507301f589bd7b7d301ea8))
* **render:** enforce explicit terminal width constraints ([d83d1e1](https://github.com/ayagmar/llm-usage-metrics/commit/d83d1e16800e463414b04468fb50419823f7076b))
* **render:** normalize row groups before separator rendering ([5d4453e](https://github.com/ayagmar/llm-usage-metrics/commit/5d4453ee2b9dc62b7eedd2d9365e6ef8b08be355))
* **render:** unify column count handling in renderUnicodeTable ([4bdb237](https://github.com/ayagmar/llm-usage-metrics/commit/4bdb23739f0eb816c5d0d140f3f99de2b24d32a9))
* **render:** unify tty width checks and harden sqlite guards ([3b8c38a](https://github.com/ayagmar/llm-usage-metrics/commit/3b8c38a6e5a11946e2c1ced0e16b44617ddec739))
* **report:** preserve unknown costs and harden opencode parsing ([2a1c679](https://github.com/ayagmar/llm-usage-metrics/commit/2a1c6795ab62878ea9f5086248c9da83b4ca7fbb))
* **review:** address PR [#19](https://github.com/ayagmar/llm-usage-metrics/issues/19) inline feedback ([2469d54](https://github.com/ayagmar/llm-usage-metrics/commit/2469d54070740c1fbb5e283b8e1aecbe96ff7ac1))
* **review:** address remaining PR [#19](https://github.com/ayagmar/llm-usage-metrics/issues/19) feedback ([18f622c](https://github.com/ayagmar/llm-usage-metrics/commit/18f622c00157cd4e0dfbf0bb032aabce3f9dfa2a))
* **update:** retry transient checks without refreshing stale cache ([cb0b21a](https://github.com/ayagmar/llm-usage-metrics/commit/cb0b21a843eb6d5ec9618ecf0f00da5deedc6c5d))
* **update:** skip checks for local source execution ([2f8d30c](https://github.com/ayagmar/llm-usage-metrics/commit/2f8d30ce8f5b857facdeba349751190a55486d47))

## [0.1.11](https://github.com/ayagmar/llm-usage-metrics/compare/v0.1.10...v0.1.11) (2026-02-20)

### Bug Fixes

* **pricing:** add temporary alias for gpt-5.3-codex to fallback on gpt-5.2-codex pricing ([d0982b4](https://github.com/ayagmar/llm-usage-metrics/commit/d0982b4e14ed6def16083e0433352cb63949d00a))

## [0.1.10](https://github.com/ayagmar/llm-usage-metrics/compare/v0.1.9...v0.1.10) (2026-02-20)

### Features

* **render:** add normalization for line breaks and enhance emoji grapheme handling ([1d6d3aa](https://github.com/ayagmar/llm-usage-metrics/commit/1d6d3aa7fe8e242746bd229433aa1f70d0415e80))
* **render:** enhance emoji grapheme handling in width calculations ([6c42114](https://github.com/ayagmar/llm-usage-metrics/commit/6c42114119b5ca2c00fdc427e57d5bed10d68961))

### Bug Fixes

* **render:** enhance zero-width code point handling in width calculations ([b73af96](https://github.com/ayagmar/llm-usage-metrics/commit/b73af96dbaba329afa521bd5ad33059d364e8751))
* **render:** handle grapheme-aware table width and wrapping ([abc8d68](https://github.com/ayagmar/llm-usage-metrics/commit/abc8d68915ff6e5d4bc311c4b39112aafc69b3a3))

## [0.1.9](https://github.com/ayagmar/llm-usage-metrics/compare/v0.1.8...v0.1.9) (2026-02-19)

### Features

* **cli:** show supported sources in help output ([8fd338e](https://github.com/ayagmar/llm-usage-metrics/commit/8fd338eca31a4bdb314c73cb32beb2a772a195fb))

### Bug Fixes

* **cli:** align filters and diagnostics behavior ([a52aa61](https://github.com/ayagmar/llm-usage-metrics/commit/a52aa61d9e662ba57522dab821f243a3c5c9265b))
* **cli:** align model-filter semantics and docs ([3d73880](https://github.com/ayagmar/llm-usage-metrics/commit/3d7388019e69497770806a497427fdc8a779f4de))
* **opencode:** continue default db fallback discovery ([e697fcb](https://github.com/ayagmar/llm-usage-metrics/commit/e697fcb807ea6c8df61c4ca519e2b1f028a38743))
* **pricing:** skip needless loads and resolve alias chains ([4e0020f](https://github.com/ayagmar/llm-usage-metrics/commit/4e0020f65b135af20da651b1840bdaa0c7b1f554))
* **release:** restore changelog plugin and drop changelog formatting hooks ([3b72dd5](https://github.com/ayagmar/llm-usage-metrics/commit/3b72dd5849cc0d5830441bba1b0f3f56654ed48d))
* **render:** normalize markdown cells with CRLF lines ([f5f9bd4](https://github.com/ayagmar/llm-usage-metrics/commit/f5f9bd4fe0d156c4ba514d552a9df5d5885f689c))
* **render:** use row type for summary styling ([3f74120](https://github.com/ayagmar/llm-usage-metrics/commit/3f74120da1aa248bcd25f63246bde1b2028dd4b9))
* **update:** detect help and version in wrapped argv ([4dfa511](https://github.com/ayagmar/llm-usage-metrics/commit/4dfa511beb02fda4078af3783f6cd2f568fedaed))

## [0.1.8](https://github.com/ayagmar/llm-usage-metrics/compare/v0.1.7...v0.1.8) (2026-02-19)

### Features

- **cli:** surface source parse diagnostics and explicit failures ([d60fff7](https://github.com/ayagmar/llm-usage-metrics/commit/d60fff7a17af4a52e7f6e802fa6df6983389fd57))
- **opencode:** add e2e coverage and skipped-row diagnostics ([1abae0b](https://github.com/ayagmar/llm-usage-metrics/commit/1abae0b7a974ac71a01c70dcb72e3301f83af45e))
- **opencode:** add pathExists check and corresponding error handling in OpenCodeSourceAdapter ([751471e](https://github.com/ayagmar/llm-usage-metrics/commit/751471e9246ad1ef3c65273918a0acd7bfea3ac3))
- **opencode:** add sqlite adapter with deterministic path resolution ([9c4f5f6](https://github.com/ayagmar/llm-usage-metrics/commit/9c4f5f6a2690f5654b4d9eabe8db736e0f9122b7))
- **opencode:** integrate provider into default reporting pipeline ([7fbddfe](https://github.com/ayagmar/llm-usage-metrics/commit/7fbddfe0658f6a035a3e06c3a9280212c347746a))
- **sources:** reserve opencode db override and enforce validation ([7b36998](https://github.com/ayagmar/llm-usage-metrics/commit/7b369984ca4a150ce0ad03797cd1d37a247f72b4))
- **update:** add session-scoped cache and shorten update ttl ([2c40c94](https://github.com/ayagmar/llm-usage-metrics/commit/2c40c94f64eb08338e55717263b5dcdf64af711f))

### Bug Fixes

- **cli:** tighten model matching and pricing load conditions ([8f13cee](https://github.com/ayagmar/llm-usage-metrics/commit/8f13cee31e429cab443a9d2a444a0cd3992a12a3))
- **opencode:** harden dist sqlite runtime path ([379f8dc](https://github.com/ayagmar/llm-usage-metrics/commit/379f8dc4f9ed86a3ab0e5ba7874efef09b202da5))
- **opencode:** ignore zero-usage rows and harden skip stats ([9e0c6c7](https://github.com/ayagmar/llm-usage-metrics/commit/9e0c6c70de2a482d6e1a1cfb8242aa87a13d6451))
- **release:** correct hook name for git release process ([d3f0338](https://github.com/ayagmar/llm-usage-metrics/commit/d3f0338ea0360caf4623cb977c7064f0c3c785ca))
- **release:** run changelog prettier before git staging ([1161ec4](https://github.com/ayagmar/llm-usage-metrics/commit/1161ec4a6b77ff72e3e8d1b6fb2aa93ca0b2e9bf))

## [0.1.7](https://github.com/ayagmar/llm-usage-metrics/compare/v0.1.6...v0.1.7) (2026-02-19)

### Features

- **report:** add per-model token and cost breakdown ([d292400](https://github.com/ayagmar/llm-usage-metrics/commit/d29240040b3be7d54227738746d648e3c320d6ca))
- **timestamps:** add normalization for timestamp candidates and improve fallback logic in parsing ([4a3d967](https://github.com/ayagmar/llm-usage-metrics/commit/4a3d9671d1fc143f0cbf7b2eab4c773e1931f928))
- **timestamps:** add support for unix-second timestamps and improve handling of millisecond timestamps ([45081b6](https://github.com/ayagmar/llm-usage-metrics/commit/45081b62d07de79b4c8b8323d2f5e63c490ec33a))

### Bug Fixes

- **sources:** harden source-dir and parse concurrency guards ([2ffd385](https://github.com/ayagmar/llm-usage-metrics/commit/2ffd385fbd5ea0195a8d3c3ebea5db4f9734bdd6))

## [0.1.6](https://github.com/ayagmar/llm-usage-metrics/compare/v0.1.5...v0.1.6) (2026-02-18)

### Features

- **cli:** integrate session logging, env var display, and report header into usage report ([4d82523](https://github.com/ayagmar/llm-usage-metrics/commit/4d8252387afec5ec344c5846683f9327c4ff9a87))
- **pricing:** return cache status from load() to indicate data source ([c843b09](https://github.com/ayagmar/llm-usage-metrics/commit/c843b09c507f479b30b53a76cda8ac3541556d53))
- **ui:** add enhanced terminal output with logger, report header, and bullet-point models ([86bc0e2](https://github.com/ayagmar/llm-usage-metrics/commit/86bc0e28292c3cc4c2a6f5cc16c3e7bac96f4b61))

### Bug Fixes

- **markdown:** render multiline model cells safely ([06e8c72](https://github.com/ayagmar/llm-usage-metrics/commit/06e8c72afddfaf189213f7dac8469157bfa2560a))
- **render:** keep terminal separators stable with color ([663485f](https://github.com/ayagmar/llm-usage-metrics/commit/663485fed927fea7061809c6f406fa5fbb25496f))
- **report:** address review feedback and edge cases ([2cf39fa](https://github.com/ayagmar/llm-usage-metrics/commit/2cf39fa224f5185e6a64bc71460c6656785ad71f))

## [0.1.5](https://github.com/ayagmar/llm-usage-metrics/compare/v0.1.4...v0.1.5) (2026-02-18)

### Features

- **cli:** add root --version option ([dba3005](https://github.com/ayagmar/llm-usage-metrics/commit/dba300541acca8d4ed38031a392ec3f305d8f1bf))
- **config:** add env runtime overrides for ops knobs ([b406d0d](https://github.com/ayagmar/llm-usage-metrics/commit/b406d0de6dece6c535e1aa2ca5b3142d353ac2fe))

### Bug Fixes

- **cli:** clarify root help for subcommand options ([771c349](https://github.com/ayagmar/llm-usage-metrics/commit/771c34973a061f0155032b54575979f19dd55eed))
- **release:** format changelog before git release step ([294736c](https://github.com/ayagmar/llm-usage-metrics/commit/294736c4868aa777c5d8539d3d58f7e1c766d5c8))
- **runtime:** tighten update, cache, and env edge handling ([020700a](https://github.com/ayagmar/llm-usage-metrics/commit/020700a3be2c69f1fd97fc09a1e8417ac701a7e0))

## [0.1.4](https://github.com/ayagmar/llm-usage-metrics/compare/v0.1.3...v0.1.4) (2026-02-18)

### Features

- **update:** add cached npm update notifier flow ([f9f93bf](https://github.com/ayagmar/llm-usage-metrics/commit/f9f93bffb4f02404ce42dfcf838adf7bc4bbc77e))

### Bug Fixes

- **update:** harden cache validation and skip logic ([6f752cd](https://github.com/ayagmar/llm-usage-metrics/commit/6f752cd7bc2e65e58548bce1a94ba8825f16bbf5))
- **update:** reuse stale cache when refresh fails ([525da2a](https://github.com/ayagmar/llm-usage-metrics/commit/525da2a4c18e591e7b460ac3775174649eacc369))

## [0.1.3](https://github.com/ayagmar/llm-usage-metrics/compare/v0.1.2...v0.1.3) (2026-02-18)

### Features

- **cli:** improve help text and source option hints ([0d2461d](https://github.com/ayagmar/llm-usage-metrics/commit/0d2461d17f33b51d507f55d1be94f100717cfdac))

### Bug Fixes

- **aggregate:** stabilize usd totals for many events ([e8296fa](https://github.com/ayagmar/llm-usage-metrics/commit/e8296fa14fddfebe4486a268c3be22f1d25417d1))
- **cli:** validate sources and skip needless pricing fetch ([1572b17](https://github.com/ayagmar/llm-usage-metrics/commit/1572b17dacf274ac904595740b6ee5bd1f31182f))
- **sources:** guard invalid numeric pi timestamps ([7d76ef5](https://github.com/ayagmar/llm-usage-metrics/commit/7d76ef5d8da1c4c685c05e36f47403296a607d92))

### Performance Improvements

- **pricing:** reduce allocations in prefix alias matching ([7d51487](https://github.com/ayagmar/llm-usage-metrics/commit/7d51487c7ea8eb3035430f66f79782a87116952b))

All notable changes to this project are documented in this file.

## [0.1.2](https://github.com/ayagmar/llm-usage-metrics/compare/v0.1.1...v0.1.2) (2026-02-17)

### Bug Fixes

- configure Git identity in the GitHub release workflow so `release-it` can create the release commit in CI.

### Chores

- sync repository version/tag state after the partial `0.1.1` publish.

## [0.1.1](https://github.com/ayagmar/llm-usage-metrics/compare/a0ac68f...v0.1.1) (2026-02-17)

### ⚠ Breaking Changes

- rename CLI executable from `usage` to `llm-usage`.

### Features

- add `--source` filtering (repeatable or comma-separated) to report commands.
- add release automation with `release-it` and a dedicated GitHub `release.yml` workflow.
- add coverage reporting in CI (single test execution path, summary generation, PR visibility support).

### Bug Fixes

- enforce default provider filtering consistently across `.pi` and `.codex` inputs.
- improve LiteLLM pricing cache behavior (best-effort cache writes after successful remote loads).
- fix USD normalization for blank/whitespace values.
- fix Codex token delta transitions (`last_token_usage`/totals handling).
- fix `.pi` usage fallback from malformed `line.usage` to `message.usage`.
- reject invalid source adapter ids that are empty/whitespace.

### Documentation

- add contributor guide (`CONTRIBUTING.md`) and expand architecture/CLI/development docs.
- document source filtering and updated command usage.

### Chores

- remove bootstrap token publish workflow after initial package bootstrap.
- add npm provenance metadata in `package.json` (`repository`, `bugs`, `homepage`).

## 0.1.0 (2026-02-17)

### Features

- initial public release of `llm-usage-metrics`.
- add CLI reporting commands for `daily`, `weekly`, and `monthly` usage aggregation.
- parse local `.pi` and `.codex` session JSONL logs through source adapters.
- implement normalization and aggregation pipelines producing per-source/per-period totals plus grand totals.
- add terminal table, markdown table, and JSON output formats.
- add pricing engine with model mapping, cost estimation, and explicit-vs-estimated cost handling.
- add LiteLLM pricing support with cache/offline behavior and custom pricing URL override.
- add test coverage across adapters, aggregation, rendering, pricing, and end-to-end report generation.

### Bug Fixes & Improvements

- improve report readability and totals behavior in terminal/markdown rendering.
- refine Codex token accounting and monthly reporting behavior.
- harden CI/release bootstrap workflow for first npm publish.
- improve documentation structure and usage guidance for first-time users.
