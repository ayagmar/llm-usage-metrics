# Changelog

## [0.14.0](https://github.com/ayagmar/llm-usage-metrics/compare/v0.13.0...v0.14.0) (2026-10-23)

### Features

* **cli:** accept --last N on session, efficiency and optimize ([55f01ee](https://github.com/ayagmar/llm-usage-metrics/commit/55f01ee3d7ff84c9b6bd05e33ec43fc7d5ecd32d))
* **doctor:** color doctor output with the shared color roles ([c651ac2](https://github.com/ayagmar/llm-usage-metrics/commit/c651ac2aaa98d0814f7e38e3f3c7b4887e851053))
* **projects:** count git worktree usage under its repository ([7ae341d](https://github.com/ayagmar/llm-usage-metrics/commit/7ae341dfa4a4665739e6243e8e0cfb6373692424))
* **projects:** count usage after a cd under the directory its session started in ([0833cf8](https://github.com/ayagmar/llm-usage-metrics/commit/0833cf8241b97a3835b3b1a0815b485eff53b7b3))

### Bug Fixes

* **deps:** pin ip-address 10.7.4 for GHSA-rxp7-6hxx-x8q5 ([35702cd](https://github.com/ayagmar/llm-usage-metrics/commit/35702cd8133adddb7e0cd6777b1912e44c511d00))
* **projects:** let the nearest recorded git root win over the disk ([47dbfa6](https://github.com/ayagmar/llm-usage-metrics/commit/47dbfa6525d0bd82f2b08fc4fcea343357062d51))
* **projects:** match the share session root, say which roots a run knows ([2e59a0d](https://github.com/ayagmar/llm-usage-metrics/commit/2e59a0d61c6ac72f2bcfde758a5eac0e508b5215))
* **projects:** walk up for .git, keep other machines and repo folders out of name matches ([d67fcc9](https://github.com/ayagmar/llm-usage-metrics/commit/d67fcc9dd35ece68402a8a8de55ee1f3c6ec7bfc))

## [0.13.0](https://github.com/ayagmar/llm-usage-metrics/compare/v0.12.1...v0.13.0) (2026-10-21)

### Features

* **cli:** list the top 10 projects in projects and value ([fa8cc36](https://github.com/ayagmar/llm-usage-metrics/commit/fa8cc365f7091673a6ef781059f8f70e8f44fc49))
* **cli:** one --top grammar with default limits and capped --by-repo rows ([f98f442](https://github.com/ayagmar/llm-usage-metrics/commit/f98f44267c37d3d658a7fdaf396877e824f2b95e))
* **core:** publish ./pricing with lazily read bundled data ([23c7380](https://github.com/ayagmar/llm-usage-metrics/commit/23c7380178e99daff4243020d53317a2ce8b9902))
* **doctor:** fold not-installed sources into one line and label machine list columns ([e81fa91](https://github.com/ayagmar/llm-usage-metrics/commit/e81fa91a730c14c000b6e6a2c392e7882f66f40e))
* **projects:** count Claude Code worktrees as their repository ([5dfed0d](https://github.com/ayagmar/llm-usage-metrics/commit/5dfed0d2632d60b041f58fc8d84851be85f57c98))
* **render:** add color roles, bold table headers, and distinct source hues ([d72f95d](https://github.com/ayagmar/llm-usage-metrics/commit/d72f95d87a392d1043114554faded6a8eb5fcca1))
* **render:** fit compare tables to the terminal and color cost changes by direction ([c5e133b](https://github.com/ayagmar/llm-usage-metrics/commit/c5e133b5c30e96631035453f06d0c4b1748ea9ae))
* **render:** fit ladder for the shared table, rules only between groups ([a29cb96](https://github.com/ayagmar/llm-usage-metrics/commit/a29cb968407d7313ea3ae780c8c8e9a477a8f2b8))
* **render:** fit session, timeline and context tables to the terminal ([61eeaf0](https://github.com/ayagmar/llm-usage-metrics/commit/61eeaf04405ce8a7e27b0d78aab36507545be479))
* **render:** fit summary and wrapped to the terminal ([ef77ed3](https://github.com/ayagmar/llm-usage-metrics/commit/ef77ed3052e6fcfa3f2ff338e64a27f559e05995))
* **render:** fit the blocks table to the terminal ([0596cb8](https://github.com/ayagmar/llm-usage-metrics/commit/0596cb8d161a7a52e0d34b4c3600e92070cf19a7))
* **render:** fit the optimize table and use role colors ([af38992](https://github.com/ayagmar/llm-usage-metrics/commit/af389929a6671b02f16605d2fa0c19cb97d5d653))
* **render:** fit the prune table to the terminal ([9363bcd](https://github.com/ayagmar/llm-usage-metrics/commit/9363bcd703ad297e264423c59e889bc4f84a4220))
* **render:** fit the tools table before listing rows ([5c374c1](https://github.com/ayagmar/llm-usage-metrics/commit/5c374c1a5405d7f4f2e83d2e6241178e9c164e8b))
* **render:** say on stderr how a narrow terminal changed every report's tables ([d9e9c6f](https://github.com/ayagmar/llm-usage-metrics/commit/d9e9c6f78806817671a6c848d6e5149d7b44688e))
* **render:** wrap and color the pricing report ([35c52e3](https://github.com/ayagmar/llm-usage-metrics/commit/35c52e34dccdb65c289c024b6111f039eac9d048))
* **session:** add files, cost split and tool call counts to --json rows ([cf39d08](https://github.com/ayagmar/llm-usage-metrics/commit/cf39d080205dc0de1c9f90d463d18944451ee376))
* **session:** add rowCount to session --json ([e8fa3d0](https://github.com/ayagmar/llm-usage-metrics/commit/e8fa3d039bb98178c0976767cdfa477dff702c16))
* **skills:** ship the llm-usage-metrics agent skill ([3e5333f](https://github.com/ayagmar/llm-usage-metrics/commit/3e5333fd566dc5be4d9790e92f2f530c45c53b4d))
* **source:** read Cline-family tasks from Cursor storage ([33ed87e](https://github.com/ayagmar/llm-usage-metrics/commit/33ed87e0c39e5f87ff17520e89d4abd43c73851f))
* **trends:** cap the spike list, add years across a year boundary, sort sources by total ([3600419](https://github.com/ayagmar/llm-usage-metrics/commit/360041942972e2e58847768ea057fedba0d14ef2))

### Bug Fixes

* **claude:** count id-less copies against request slots, not reused keys ([7a8a87e](https://github.com/ayagmar/llm-usage-metrics/commit/7a8a87ed467c09b7747d960aa65c9851728eaa2f))
* **claude:** count requests with different ids in different sessions ([76d0996](https://github.com/ayagmar/llm-usage-metrics/commit/76d099695d40b65ba2742f0e11e72f6dfc55119d))
* **claude:** keep request-only ids and spare held keys for id-less copies ([1df95a3](https://github.com/ayagmar/llm-usage-metrics/commit/1df95a31e096692123fd3513f821f932cfe4ed38))
* **claude:** match id-less copies one key each and resync machine ids ([e6622ba](https://github.com/ayagmar/llm-usage-metrics/commit/e6622bac28a295ff59e83d65c3e61a327aac56f8))
* **claude:** pair machine events by request ids before legacy hash matches ([155f2d4](https://github.com/ayagmar/llm-usage-metrics/commit/155f2d4f2d7816946b95832ce0b3f0a03f5854d1))
* **cli:** keep long words whole when wrapping stderr diagnostics ([fe9335f](https://github.com/ayagmar/llm-usage-metrics/commit/fe9335f63a0f091b87eb985fbd2822952777a7eb))
* **cli:** move routine stderr notes behind --verbose ([4812edc](https://github.com/ayagmar/llm-usage-metrics/commit/4812edcdbfbeb2025aeb51e21e45814adc3f37bf))
* **cli:** note a never-synced machine by default and align logging docs ([d77bb22](https://github.com/ayagmar/llm-usage-metrics/commit/d77bb22c668865923a04731af5af43ab5bf5d80b))
* **cli:** wrap stderr diagnostics to a terminal's width ([d9c5396](https://github.com/ayagmar/llm-usage-metrics/commit/d9c53967535af3781da52dd4414d643f69f983a3))
* **codex:** fail a compressed rollout with data after its first frame ([d999a51](https://github.com/ayagmar/llm-usage-metrics/commit/d999a51adbc3441e09aa321fad2b37f71a789ace))
* **codex:** read compressed .jsonl.zst rollouts ([d6f35b7](https://github.com/ayagmar/llm-usage-metrics/commit/d6f35b7a9e51b5f2c6fd6509b8da416aa2de6646))
* **core:** retry failed pricing data reads and validate library inputs ([6b7920c](https://github.com/ayagmar/llm-usage-metrics/commit/6b7920c1894134a0d7a454aba9b73cd803c37607))
* **deps:** raise the vite override to 8.1.6 for GHSA-698v-4r3x-3vcv ([7bf2ea4](https://github.com/ayagmar/llm-usage-metrics/commit/7bf2ea4891b854e43ebb59971672f1ee315e09ca))
* **docs:** render screenshot captures at a 120-column terminal width ([59c793d](https://github.com/ayagmar/llm-usage-metrics/commit/59c793d3462441d48396ea039f309d7f756c1913))
* **doctor:** point empty-state hints at doctor --verbose ([f98bd56](https://github.com/ayagmar/llm-usage-metrics/commit/f98bd56291c575ab7e5041b69be225d76aecd979))
* **efficiency:** format ratios and line counts per the style contract, name the missing half when empty ([9f7d7dd](https://github.com/ayagmar/llm-usage-metrics/commit/9f7d7ddc9d2685eb2bdccb52836eab4342aae642))
* **efficiency:** key the empty message on days with usage, not attributed events ([60df677](https://github.com/ayagmar/llm-usage-metrics/commit/60df67786fa8285afcb2f709f14f059948f16ee1))
* **optimize:** infer the provider from the candidate models ([546497e](https://github.com/ayagmar/llm-usage-metrics/commit/546497e3901e7903dbd8e2bd0ba8f599ea451e33))
* **prune:** count what each selector would pick when run without one ([369bfc0](https://github.com/ayagmar/llm-usage-metrics/commit/369bfc00e5422d57343acc58265d584c291664d6))
* **render:** bold the boxed table headers in value, projects and efficiency ([0d86fd3](https://github.com/ayagmar/llm-usage-metrics/commit/0d86fd3ea339f7fe003a123d4af679cac82fa2df))
* **render:** color costs in projects and value ([4b9fa47](https://github.com/ayagmar/llm-usage-metrics/commit/4b9fa478792555b5430af237cb183ca7856cc90c))
* **render:** color only pi, codex and claude so source hues stay distinct ([1cb412d](https://github.com/ayagmar/llm-usage-metrics/commit/1cb412d52fa389d5be7e650b9e596e2eee8f53fb))
* **render:** keep listed session text whole and note only real abbreviation ([dc641f9](https://github.com/ayagmar/llm-usage-metrics/commit/dc641f9222b0d479bf2d0568fbfbf4ac748a58d9))
* **render:** keep optimize notes and exact hypothetical costs when fitting ([d895d9e](https://github.com/ayagmar/llm-usage-metrics/commit/d895d9eca0f2335712746e03956e99e116813e6c))
* **render:** keep the pricing URL whole and drop the empty prune summary ([c7fca29](https://github.com/ayagmar/llm-usage-metrics/commit/c7fca29360f2c87463778559c925f558cb4e2128))
* **render:** list per-model usage rows on narrow terminals ([060d373](https://github.com/ayagmar/llm-usage-metrics/commit/060d373e6c853c452deeb369ef379a1cce54a345))
* **render:** print whole-hour durations as 2h, not 2h 0m ([f3d94b6](https://github.com/ayagmar/llm-usage-metrics/commit/f3d94b6cf92c0661b163c4d794da762e2121da34))
* **render:** wire the fit note into value and say when only some tables hid a column ([ef7ae49](https://github.com/ayagmar/llm-usage-metrics/commit/ef7ae49acdb2090144a3c62d188c14095fda21fe))
* **render:** wrap an unboxed report title to the terminal width ([3e65f22](https://github.com/ayagmar/llm-usage-metrics/commit/3e65f2240d99d5d1cc0a37d733e369b15111315f))
* **render:** wrap only the stacked lines that do not fit, without their padding ([d87dfa6](https://github.com/ayagmar/llm-usage-metrics/commit/d87dfa6ac5de0cfbeb4a243b75571add37e4450c))
* **render:** wrap overflowing list titles and dim list labels ([d2244e8](https://github.com/ayagmar/llm-usage-metrics/commit/d2244e87f4b9824e0be5993b8745c9c333374354))
* **render:** wrap summary best day and wrapped date line on narrow terminals ([1232385](https://github.com/ayagmar/llm-usage-metrics/commit/1232385539ff3e1a4aa990e6fdb75b2520e01132))
* **render:** wrap the value report's API cost note ([6af06ce](https://github.com/ayagmar/llm-usage-metrics/commit/6af06ce4c024d03a2fd9bacc27ff6e0fcd170542))
* **session:** omit tool call counts a failed read leaves unknown ([3ef3d3f](https://github.com/ayagmar/llm-usage-metrics/commit/3ef3d3fcc781972de2d6bc598e3257970dd4c7f3))
* **share:** keep folded projects out of compare's biggest changes ([2958520](https://github.com/ayagmar/llm-usage-metrics/commit/295852062a95b3657149a6f6c517471e4df37170))
* **source:** read a codex rollout from its other form when Codex swaps it mid-run ([0efa1dc](https://github.com/ayagmar/llm-usage-metrics/commit/0efa1dc2b5e79ca1552477147c51132ff42b3254))
* **update:** refresh a stale update-check cache in a detached process ([a9ddd7f](https://github.com/ayagmar/llm-usage-metrics/commit/a9ddd7f0631f9d23bd5b0144d29ea71765f5b892))
* **update:** skip the background refresh at a zero TTL and run it outside the cwd ([80da571](https://github.com/ayagmar/llm-usage-metrics/commit/80da5715427ba039c7ab58b421d8887b35031304))

### Performance Improvements

* **claude:** compare copy ids after usage and read message-only rows as one literal ([97ebe4e](https://github.com/ayagmar/llm-usage-metrics/commit/97ebe4e7e325dda82f8253bc3740a57fd073c267))
* **cli:** size compressed parse-worker misses by their decoded bytes ([a886eb4](https://github.com/ayagmar/llm-usage-metrics/commit/a886eb4d7f62b81a9d488fea1c835cba2b5b8c6f))
* **cli:** skip the size stat when a .zst header declares its size ([71e49f1](https://github.com/ayagmar/llm-usage-metrics/commit/71e49f17564cf2141af21a31af72e90265167944))
* **store:** read stored claude rows with both ids as one literal ([9cafb5c](https://github.com/ayagmar/llm-usage-metrics/commit/9cafb5c5be0b932ff48cbabaa5cbf095c9dee55a))

## [0.12.1](https://github.com/ayagmar/llm-usage-metrics/compare/v0.12.0...v0.12.1) (2026-10-18)

### Features

* **cli:** accept --last N days on events ([22a54bc](https://github.com/ayagmar/llm-usage-metrics/commit/22a54bc6e6075b339f949c39ab5f4d1da0ee50a1))

### Bug Fixes

* **aggregate:** count a directory inside node_modules as its project ([e450b82](https://github.com/ayagmar/llm-usage-metrics/commit/e450b829d74a1bf9b590bafbaea9256886f85eef))
* **aggregate:** find node_modules past a directory that only starts with it ([47ac22c](https://github.com/ayagmar/llm-usage-metrics/commit/47ac22ca804d96d293391c677db7ecca71661073))
* **aggregate:** keep the root of a node_modules directory at a filesystem root ([cf8993c](https://github.com/ayagmar/llm-usage-metrics/commit/cf8993c7d4d9d6ce7b28c3f8eaeea7f2eb013b6e))
* **cli:** list schema names when schema gets no name ([6ca1a79](https://github.com/ayagmar/llm-usage-metrics/commit/6ca1a79a13ce66280a34e314aeb4e10f1c5a9aee))
* **cli:** prefix command failures with error: like option errors ([11d266f](https://github.com/ayagmar/llm-usage-metrics/commit/11d266ff7182f4fe18348bcd085d583e472f1ad7))
* **core:** fold vendor-reselling providers into their billing vendor ([78d52c6](https://github.com/ayagmar/llm-usage-metrics/commit/78d52c6701d3e79c0534560207f859484e23672f))
* **efficiency:** fail early outside a git repository ([56dae55](https://github.com/ayagmar/llm-usage-metrics/commit/56dae5509c2ecc05018d1d520c76adbcae7cdd23))
* **efficiency:** reject a bare repository as the repo directory ([43f2525](https://github.com/ayagmar/llm-usage-metrics/commit/43f252516255de5e7035afd350d74043a339f821))
* **machines:** print a failed sync on stderr ([7f2d451](https://github.com/ayagmar/llm-usage-metrics/commit/7f2d4519cf68e290671d5052e09e60580b4a449f))
* **machines:** skip the machines note when every machine was left out ([341219c](https://github.com/ayagmar/llm-usage-metrics/commit/341219cb97d25db2b14a36d93ae495c50a20eb93))
* **render:** put the sign before the ~ mark on approximate compare deltas ([cea1c3f](https://github.com/ayagmar/llm-usage-metrics/commit/cea1c3fd7d6f6f88adeeaaefeb13061ec747889d))
* **render:** reword the blocks note so the UTC hour start and local times don't read as contradictory ([776b85e](https://github.com/ayagmar/llm-usage-metrics/commit/776b85e97b279116f15948f202ea5ca8c3f3e51b))
* **render:** show - for an unknown context limit instead of a blank cell ([aca8269](https://github.com/ayagmar/llm-usage-metrics/commit/aca8269604a4af259f66b7239dee1c446b289e86))
* **store:** drop pre-release tool call and message tables when migrating to v5 ([d498f94](https://github.com/ayagmar/llm-usage-metrics/commit/d498f941c1b080563b99ebcd840fefc1217717a1))
* **store:** migrate a v4-layout store a pre-release build stamped v5 ([edb8950](https://github.com/ayagmar/llm-usage-metrics/commit/edb895030c6e87b1a715f39ab6dcc4a96ffa8e8f))
* **tools:** group tool names that differ only in case ([c264680](https://github.com/ayagmar/llm-usage-metrics/commit/c2646808e71300de2046df4bb6cfbdf94edb0a40))
* **trends:** count parallel sessions once in active-hours, sharing the wrapped union helper ([4e7c6cc](https://github.com/ayagmar/llm-usage-metrics/commit/4e7c6cc6a06bcb48ac8e0c0b125363addcfd64e5))
* **wrapped:** count overlapping session time once in Hours ([bdca3dd](https://github.com/ayagmar/llm-usage-metrics/commit/bdca3ddf391d3fada2b11c5b338c0d19f7c68631))

## [0.12.0](https://github.com/ayagmar/llm-usage-metrics/compare/v0.11.0...v0.12.0) (2026-10-18)

### ⚠ BREAKING CHANGES

* **core:** make read the only adapter read path
* **core:** move CLI-shaped names off the root entry

### Features

* **aggregate:** add project keys and unique project labels ([c880a9f](https://github.com/ayagmar/llm-usage-metrics/commit/c880a9f7038c9f860204b77560eeb155d4381498))
* **aggregate:** split usage rows by project and add per-project rows ([0b38cd7](https://github.com/ayagmar/llm-usage-metrics/commit/0b38cd7007766dfb79ac3f2781e7b3dc08350508))
* **bench:** add a statusline-aged scenario with files past the activity window ([259caa8](https://github.com/ayagmar/llm-usage-metrics/commit/259caa80e62bff7c5c7fe7ac902615cd8970e9c5))
* **blocks:** report estimated 5-hour usage blocks per source ([8713f2f](https://github.com/ayagmar/llm-usage-metrics/commit/8713f2f801f427d7a0486e7862f6f93bacf16e54))
* **cli:** accept --all on every report that reads usage ([096dc44](https://github.com/ayagmar/llm-usage-metrics/commit/096dc4432b32a394cb9d7a2bc2df60d201346003))
* **cli:** add --cost-mode and note logged $0 events that were estimated ([4442e40](https://github.com/ayagmar/llm-usage-metrics/commit/4442e408ebb168ba197397a4f3601373706e2958))
* **cli:** add --quiet to pricing ([c629297](https://github.com/ayagmar/llm-usage-metrics/commit/c629297f224ce3dec73f17bb846d22671df51db4))
* **cli:** add --redact and describe --share as an interactive HTML report ([d043a27](https://github.com/ayagmar/llm-usage-metrics/commit/d043a27cefc64534a6d088f08c8b504d361b6dcf))
* **cli:** add the context report ([ca8cdea](https://github.com/ayagmar/llm-usage-metrics/commit/ca8cdea1757320098cc014437979d3de4230f1b9))
* **cli:** add the pricing report ([bba68e8](https://github.com/ayagmar/llm-usage-metrics/commit/bba68e855d9db56c730f096c62c738ddc0282ba7))
* **cli:** add the projects report ([c56f4b7](https://github.com/ayagmar/llm-usage-metrics/commit/c56f4b7a2cdb70fe58ff624c10a51c6ef9954fa1))
* **cli:** add the tools report ([95d86bc](https://github.com/ayagmar/llm-usage-metrics/commit/95d86bc66162deed219b4ce4b44d26c6d881d556))
* **cli:** append the new lines of a grown claude or pi file ([1a206b8](https://github.com/ayagmar/llm-usage-metrics/commit/1a206b8168ef45cc65b6ba5c948bc90cece86905))
* **cli:** build the share report data from the command's window ([e54784f](https://github.com/ayagmar/llm-usage-metrics/commit/e54784fd93bc3d3a262c5d90bda0059fa72cdfdf))
* **cli:** compare monthly API cost with subscription plans in value ([cdf5622](https://github.com/ayagmar/llm-usage-metrics/commit/cdf56220c2ee578865679a9114f66210e0442f6a))
* **cli:** events --format otlp-metrics ([3833f6b](https://github.com/ayagmar/llm-usage-metrics/commit/3833f6b8b7611f75d0888a1351fc3477bc5fd651))
* **cli:** events --otlp-endpoint pushes the OTLP export over HTTP ([ac323bd](https://github.com/ayagmar/llm-usage-metrics/commit/ac323bdc4b6df7e01fc5c77379d457717efb74e6))
* **cli:** filter usage by project with --repo ([f716214](https://github.com/ayagmar/llm-usage-metrics/commit/f7162142b4c4eba63975f9f646e99736147ce024))
* **cli:** hourly usage report ([16197e9](https://github.com/ayagmar/llm-usage-metrics/commit/16197e9105067426746d616effdeebb8d3371212))
* **cli:** mark a DST fall-back hour's rows with repeatedHour ([9091b52](https://github.com/ayagmar/llm-usage-metrics/commit/9091b526cdf06c41626222396c75bbc2eaf5b1ce))
* **cli:** parse claude and pi files on the worker pool ([dedb9b8](https://github.com/ayagmar/llm-usage-metrics/commit/dedb9b8bbc1bfbe581077f3f9e98de442cc44b44))
* **cli:** read tools and timeline events from the event store ([3cfa0b6](https://github.com/ayagmar/llm-usage-metrics/commit/3cfa0b6bd0b3b38317206195576dba1c1c2a0713))
* **cli:** register hourly, projects, blocks, value and pricing ([0713eba](https://github.com/ayagmar/llm-usage-metrics/commit/0713eba375e60c741f7648523cf2f819f95164f9))
* **cli:** split daily, weekly and monthly by project with --by-repo ([19d5955](https://github.com/ayagmar/llm-usage-metrics/commit/19d59556bb410e0b393a82bbd911fe8bb0f2c399))
* **cli:** split trends and compare by project with --by-repo ([512f9da](https://github.com/ayagmar/llm-usage-metrics/commit/512f9daacf0d20ea16ea8ca8c98ecd74af2eca03))
* **cli:** store tool calls and messages with each parsed file ([e5b2ad4](https://github.com/ayagmar/llm-usage-metrics/commit/e5b2ad402519ce36c5f17990c6a6c6539aa385fa))
* **cli:** summary --repo, dropping the monthly budget when it narrows the run ([64ba55e](https://github.com/ayagmar/llm-usage-metrics/commit/64ba55e305ad191d45de9e5d79dd570b399ece44))
* **config:** config show reports the effective setup with origins ([5d1b206](https://github.com/ayagmar/llm-usage-metrics/commit/5d1b206188f3826d535150d664c4ad45d4c56665))
* **core:** add a resumable JSONL read cursor and make qwen incremental ([bf49e12](https://github.com/ayagmar/llm-usage-metrics/commit/bf49e124b710eed09b5530c9b6c3b9ccfc72e43c))
* **core:** add dedupeToolCalls and use it for tools and the session timeline ([a57c0e0](https://github.com/ayagmar/llm-usage-metrics/commit/a57c0e0d1479ee4449363a7d9e1c591037f979e7))
* **core:** add experimental ./otel GenAI attribute helpers ([5df26f5](https://github.com/ayagmar/llm-usage-metrics/commit/5df26f59d83fe045f446bc004d914055cd7d5ff8))
* **core:** add pipe for async-iterable stages ([33de062](https://github.com/ayagmar/llm-usage-metrics/commit/33de0623f5bcfd90919ea4e07ea79ddd3052ef7e))
* **core:** add readEvents with a read fallback and the kinds() stage ([84147fd](https://github.com/ayagmar/llm-usage-metrics/commit/84147fdb591d4620d7261dd3876dc3cc9070f019))
* **core:** add readSources to ./registry ([c615389](https://github.com/ayagmar/llm-usage-metrics/commit/c6153891ec9d80bf402f65a9cac203fd15c2c19e))
* **core:** add repeatedAcrossFiles and copiedSessions stages ([2f8bb3f](https://github.com/ayagmar/llm-usage-metrics/commit/2f8bb3f58d966403da9a19202613a6e52c766831))
* **core:** add since, until and bySession stages ([5ed3bfa](https://github.com/ayagmar/llm-usage-metrics/commit/5ed3bfa787ba9682a0e1f8181c8ac58c0ef4ef56))
* **core:** add the session event kinds and their constructors ([f142a07](https://github.com/ayagmar/llm-usage-metrics/commit/f142a07ddbe292f45497427e40310ae22604ed1a))
* **core:** add the shared helpers for adapters that read session events ([144207a](https://github.com/ayagmar/llm-usage-metrics/commit/144207a8e8e77f07278a93249f63dbb4c260e696))
* **core:** add the streaming read contract with collect and collectFile ([a4a2732](https://github.com/ayagmar/llm-usage-metrics/commit/a4a27326bb6593ed4e5b99dd8c9a891094fffb14))
* **core:** classify usage lines and pass malformed lines on in jsonl reads ([ba60881](https://github.com/ayagmar/llm-usage-metrics/commit/ba60881049c1759d5df6752696bf08bf9094547f))
* **core:** let readJsonlObjects start at an offset and report line ends ([8f73bdd](https://github.com/ayagmar/llm-usage-metrics/commit/8f73bdd21aff926a3efb50163aef4b6f0d7c05b3))
* **core:** mark failed and unknown tool calls in the OTel attributes ([ac3af91](https://github.com/ayagmar/llm-usage-metrics/commit/ac3af9139468aa2148d3a5878767f877d1ace880))
* **core:** pass non-usage kinds through the dedup stages ([a9c3b79](https://github.com/ayagmar/llm-usage-metrics/commit/a9c3b79194fca7636da77d097a3a48a783ab226a))
* **core:** read codex messages, tool calls and session meta as events ([15594f3](https://github.com/ayagmar/llm-usage-metrics/commit/15594f39710c70df794996adc0dfeeb5249fb911))
* **core:** read JSON array transcripts one element at a time ([160f5ca](https://github.com/ayagmar/llm-usage-metrics/commit/160f5cadf6c260b10db9a99e3fc94f8a6167effb))
* **core:** read message, tool_call and session_meta events from pi sessions ([5fbc573](https://github.com/ayagmar/llm-usage-metrics/commit/5fbc57334b948152658e7ed693dc84f2a213f5b5))
* **core:** read messages, tool calls and session facts from claude transcripts ([e4fd773](https://github.com/ayagmar/llm-usage-metrics/commit/e4fd773579fb7456949c3d2d817706db96de6379))
* **core:** resume claude and pi reads from a stateful cursor ([fa1cd06](https://github.com/ayagmar/llm-usage-metrics/commit/fa1cd06984aaad3a77823a1d1c874a436a5a5748))
* **core:** type capabilities.kinds and declare usage on every adapter ([7f9dab6](https://github.com/ayagmar/llm-usage-metrics/commit/7f9dab6631d67496515dc786cf333aafce5eaedd))
* **events:** export sessions as OTLP/JSON traces with --format otlp-traces ([338b9e7](https://github.com/ayagmar/llm-usage-metrics/commit/338b9e7a7c031a9a32731a55008278dfa298a320))
* **machines:** send tool calls and messages in machine bundles ([6dc2dfb](https://github.com/ayagmar/llm-usage-metrics/commit/6dc2dfb65c9770bf2f7037d349a9c3d2abb6b9f1))
* **otel-export:** token histograms and tool durations in otlp-metrics ([4d6a876](https://github.com/ayagmar/llm-usage-metrics/commit/4d6a876922fd3d14f24977afd2301b1736e09738))
* **otel:** follow semantic-conventions-genai f49da22 ([38c0a76](https://github.com/ayagmar/llm-usage-metrics/commit/38c0a763db6b8480401a29b9571b136108442340))
* **pricing:** decide long-context tiers per event with singleRequest ([9586d85](https://github.com/ayagmar/llm-usage-metrics/commit/9586d85c0f203134008c26c359142a26ee396aa2))
* **pricing:** explain how a model name resolves to its prices ([cbbcd19](https://github.com/ayagmar/llm-usage-metrics/commit/cbbcd19aac17a8eaf8ac3df04e24d29f14123794))
* **pricing:** keep LiteLLM context limits per pricing key ([ba29cce](https://github.com/ayagmar/llm-usage-metrics/commit/ba29cce2b61ac34d9e16c8f4d89ab124fff9d886))
* **render:** align table columns by declared kind ([eb63d17](https://github.com/ayagmar/llm-usage-metrics/commit/eb63d176c133b96970a238ab0dac3ed73f5cb168))
* **render:** label session projects as the projects report does ([aded4d0](https://github.com/ayagmar/llm-usage-metrics/commit/aded4d0dcf7eac77afdce9b62695ab953dd94158))
* **render:** one no-usage message for every report ([fdb41c6](https://github.com/ayagmar/llm-usage-metrics/commit/fdb41c6c6364b6e743c366407c39b3ec8080e57e))
* **render:** one sparkline module for trends and the wrapped strip ([a17fd1f](https://github.com/ayagmar/llm-usage-metrics/commit/a17fd1fe98d97dd7271c18dd63add68bcdd6ab60))
* **schema:** add the share report payload schema and types ([2ad149f](https://github.com/ayagmar/llm-usage-metrics/commit/2ad149fd116729ba556e13290b6dd44b1a1f19e9))
* **session:** add --timeline for one session's requests in time order ([0450532](https://github.com/ayagmar/llm-usage-metrics/commit/0450532640cb5cda4bc865376059b721ea876112))
* **session:** interleave tool calls and turns in --timeline ([de899e2](https://github.com/ayagmar/llm-usage-metrics/commit/de899e2d68775045a00ddbe872d4bce7301e889f))
* **share:** add the interactive report shell ([9c663e5](https://github.com/ayagmar/llm-usage-metrics/commit/9c663e53c685319c21411901345e2433b7091a04))
* **share:** add the share report client core ([642f708](https://github.com/ayagmar/llm-usage-metrics/commit/642f7088a1029a667a982f9c792e2907b4fdc6ea))
* **share:** add the share report HTML document, CSP and chart export ([38eb942](https://github.com/ayagmar/llm-usage-metrics/commit/38eb942299f7b868d5c04f212ee98f124cc57db0))
* **share:** add the wrapped recap and the compare, efficiency and optimize panels ([1ff6c22](https://github.com/ayagmar/llm-usage-metrics/commit/1ff6c22481d97557a0da75ad96c032966e2ef090))
* **share:** build the share payload cube, sessions and blocks ([b07115e](https://github.com/ayagmar/llm-usage-metrics/commit/b07115ea5e989cbd09ce8e63c164e90f0dce4dd8))
* **share:** draw the report charts ([40b8c9d](https://github.com/ayagmar/llm-usage-metrics/commit/40b8c9d13f913590eefa9cedb129e31ffd8855ca))
* **share:** embed the summary and trends envelopes ([a077669](https://github.com/ayagmar/llm-usage-metrics/commit/a0776692c421b7ef893dd8eca723968b44e1ef69))
* **share:** give the summary calendar a table of its days with usage ([ce0f81d](https://github.com/ayagmar/llm-usage-metrics/commit/ce0f81d2f718c027e01d26106728a471e27d94ff))
* **share:** give the wrapped calendar a table of its days with usage ([0d0196d](https://github.com/ayagmar/llm-usage-metrics/commit/0d0196da58e58d7cc48472238df3832e7c37280d))
* **share:** label, redact and scrub paths for the share report ([548e07a](https://github.com/ayagmar/llm-usage-metrics/commit/548e07abbc04163ad8dc9fab88de1335211d82f3))
* **share:** lead every page with its command's own result ([db9475c](https://github.com/ayagmar/llm-usage-metrics/commit/db9475c4ac9366040ace3c87c9b2be410fa0314d))
* **share:** leave a margin around exported charts ([aaf718d](https://github.com/ayagmar/llm-usage-metrics/commit/aaf718d347f36a90f7ac0becff76c2c1da919a6d))
* **share:** name the window each summary period is set against ([6fc8632](https://github.com/ayagmar/llm-usage-metrics/commit/6fc86325410396f030617b5790a51c957fab6223))
* **share:** set each summary period against the days before it ([d8608e4](https://github.com/ayagmar/llm-usage-metrics/commit/d8608e47ac0c838393f62960ab25666d7422fe15))
* **share:** write the interactive HTML report from every share command ([755aa06](https://github.com/ayagmar/llm-usage-metrics/commit/755aa0605b0201c8b9e24d2c141db78c609b7daf))
* **source:** read OpenCode V2 databases ([93f07bc](https://github.com/ayagmar/llm-usage-metrics/commit/93f07bc885f3a49c18cccc820e7ca9c5db41eb68))
* **spikes:** compare a day with the median active day before it ([adfb5b4](https://github.com/ayagmar/llm-usage-metrics/commit/adfb5b495ca6a1f0e58b3e27073c53938640a20d))
* **statusline:** parse a cold store once across overlapping ticks ([7d567f2](https://github.com/ayagmar/llm-usage-metrics/commit/7d567f2fe8f825c624f21f0ab7d53f9283b40e94))
* **store:** keep tool calls and messages in schema v5 ([f69be9b](https://github.com/ayagmar/llm-usage-metrics/commit/f69be9b0c1801dd85305469d1507d62ba41ad16c))
* **summary:** add each period's previous same-length window to --json ([dc7f69e](https://github.com/ayagmar/llm-usage-metrics/commit/dc7f69ea3378759b937846b6a2b29707bca536ea))
* **summary:** note a spend spike in the last 7 days ([a694b52](https://github.com/ayagmar/llm-usage-metrics/commit/a694b52e64a03860f1b13fcd6601536298ecdf31))
* **tools:** include other machines' tool calls and turns ([3267303](https://github.com/ayagmar/llm-usage-metrics/commit/3267303e94ffe077864a71bee878aaedcfa88e34))
* **trends:** mark spend spike days in cost trends ([bedcde2](https://github.com/ayagmar/llm-usage-metrics/commit/bedcde26e60bbb3204c068e7ec667f8ffc3f8efb))

### Bug Fixes

* **aggregate:** label a rootless (unattributed) key ./(unattributed) ([8a3c204](https://github.com/ayagmar/llm-usage-metrics/commit/8a3c204c41ed9a5a675cbb23fe3f9d54ed010513))
* **aggregate:** never give a project label that is already taken ([0c5aabf](https://github.com/ayagmar/llm-usage-metrics/commit/0c5aabf353058d70c66b7706d3c945063c399a75)), references [#2](https://github.com/ayagmar/llm-usage-metrics/issues/2) [#3](https://github.com/ayagmar/llm-usage-metrics/issues/3)
* **aggregate:** reserve the (unattributed) label from real projects ([b3f41ca](https://github.com/ayagmar/llm-usage-metrics/commit/b3f41ca6da60b5d0b552571ff50c54525e41cca5))
* **blocks:** chain narrowed runs over the whole source stream ([1c121c9](https://github.com/ayagmar/llm-usage-metrics/commit/1c121c90701543d979c2f9f38cd042f949da2468))
* **blocks:** place --machine blocks from every machine with a custom source dir ([8568733](https://github.com/ayagmar/llm-usage-metrics/commit/8568733093ade40d6ec49989d5d81c949b639538))
* **blocks:** warn when the account-window read under --machine falls short ([a309c79](https://github.com/ayagmar/llm-usage-metrics/commit/a309c7903c60f161a394bffe8c7ffde6bcdae2a9))
* **cli:** --repo ignores drive-letter case, keeps UNC roots apart and resolves .. ([649523c](https://github.com/ayagmar/llm-usage-metrics/commit/649523c6e0f7806c7a8f439bde433aad2b193be7))
* **cli:** accept --all on wrapped as a no-op ([8ec7ac3](https://github.com/ayagmar/llm-usage-metrics/commit/8ec7ac3095a5ed045bb492c586483377f98cef62))
* **cli:** accept --help-all on config init like the report commands ([03814bb](https://github.com/ayagmar/llm-usage-metrics/commit/03814bbd56cadaf88421eb5164a99ce811d97298))
* **cli:** attribute a resumed session's copied tool calls as tools does in --timeline ([a930919](https://github.com/ayagmar/llm-usage-metrics/commit/a9309196febfdd114464b6aba333946a49a962a0))
* **cli:** canonicalize absolute repo roots before --repo compares them ([68871df](https://github.com/ayagmar/llm-usage-metrics/commit/68871dfbc4e98baa1fb955b3b763e9a0b914b3fa))
* **cli:** check the Node version before enabling the compile cache ([e472978](https://github.com/ayagmar/llm-usage-metrics/commit/e4729786893d6b585fbf93ef5de04c0c551a0963))
* **cli:** complete --cost-mode choices in bash, zsh and fish ([234fcaf](https://github.com/ayagmar/llm-usage-metrics/commit/234fcafb272f80a66efcbe39a528ce7230978e43))
* **cli:** count tool calls and messages toward the store write batch ([a8423de](https://github.com/ayagmar/llm-usage-metrics/commit/a8423de68227e2e7f3e2cf3aadd7d387de6d73c0))
* **cli:** describe tools --by-repo with the shared project wording ([c1d783b](https://github.com/ayagmar/llm-usage-metrics/commit/c1d783b5a4436b87856971c065443be4a3edb791))
* **cli:** end hourly's default window today ([27fb297](https://github.com/ayagmar/llm-usage-metrics/commit/27fb2978855ea67f0d44d29618ab793a126ba3f0))
* **cli:** export cacheWrite1hTokens as the last events CSV column ([10f1d17](https://github.com/ayagmar/llm-usage-metrics/commit/10f1d175ae30883dfd12bb6eb871571cbeaa57a1))
* **cli:** find a grown file in its sorted stored fingerprint ([690dffe](https://github.com/ayagmar/llm-usage-metrics/commit/690dffea13d64ec0c439728f10dad614ed8df387))
* **cli:** format both counts in the machine cache mismatch error ([5be2baf](https://github.com/ayagmar/llm-usage-metrics/commit/5be2baf85c8d0b82457931d85dfc62e5decb2c5f))
* **cli:** label the per-source worker figure in the runtime profile as a limit ([c7ce8a2](https://github.com/ayagmar/llm-usage-metrics/commit/c7ce8a21062a2360b08bfb08dbbdaad7fb7fa088))
* **cli:** let one statusline tick reclaim a stale lock ([0610786](https://github.com/ayagmar/llm-usage-metrics/commit/0610786a4de613538f8dc5521cec6a8dd38cd48e))
* **cli:** name an override the pricing report reaches by the normalized name ([bbfd5f0](https://github.com/ayagmar/llm-usage-metrics/commit/bbfd5f024ab378b21b560008ae9a6e06af2224e8))
* **cli:** name departed files in the tool-call note only when history served some ([0532014](https://github.com/ayagmar/llm-usage-metrics/commit/0532014b485f2ad17ff0c73ff2fcbcf45e7dc98a))
* **cli:** name the config show report config-show, as llm-usage schema takes it ([28255f7](https://github.com/ayagmar/llm-usage-metrics/commit/28255f76c7a8069dc3f5ffab0ffd8579ba72117d))
* **cli:** pluralize event and file counts in history, doctor and machine messages ([8e94006](https://github.com/ayagmar/llm-usage-metrics/commit/8e940069e29593d45d233397ab41238329151d6d))
* **cli:** read a file whose stored fingerprint does not parse in full ([b8d86e5](https://github.com/ayagmar/llm-usage-metrics/commit/b8d86e59bf2225db85e9b2d55016e2014975ef04))
* **cli:** read a grown file's stored version in one snapshot ([cf08147](https://github.com/ayagmar/llm-usage-metrics/commit/cf0814787fe7b0b74a1ed388af5e1a8f6ffdb189))
* **cli:** release the statusline lock without renaming it ([719d9e1](https://github.com/ayagmar/llm-usage-metrics/commit/719d9e16e5439b08536d5d50c50e9f2b78b66d83))
* **cli:** resolve blocks and --share filters over the window, not the lookback week ([67629c2](https://github.com/ayagmar/llm-usage-metrics/commit/67629c2ffb0ba423a8352ca22844abdd97ec6d6b))
* **cli:** resolve trends --model over the chart, not the spike lookback ([fc66e3c](https://github.com/ayagmar/llm-usage-metrics/commit/fc66e3c36346ed0bb033b689d69d92111178d905))
* **cli:** say that --pricing-offline falls back to the bundled snapshot ([29a741b](https://github.com/ayagmar/llm-usage-metrics/commit/29a741b2ec7f91b781269f357ea65b5a2fef8455))
* **cli:** take the exact --id match in session --timeline ([21c9b92](https://github.com/ayagmar/llm-usage-metrics/commit/21c9b92f17136399fe1acadf9aaeb1e5934dcbbf))
* **cli:** wrap long help examples between flags; root --help-all prints the root help ([6d60720](https://github.com/ayagmar/llm-usage-metrics/commit/6d6072024f40e1c95866613aefd25a60623a27ac))
* **codex:** skip the parent's lines copied into a forked rollout ([4a380eb](https://github.com/ayagmar/llm-usage-metrics/commit/4a380eb05fbd5eb466eefb3d9836e6cfb36ae7ac))
* **codex:** take a referenced fork's first early token_count as its baseline ([dcbbb47](https://github.com/ayagmar/llm-usage-metrics/commit/dcbbb47771232ebb6bf89d76881b99b2562d9d8d))
* **core:** accept a String(date) window bound ([3bcde03](https://github.com/ayagmar/llm-usage-metrics/commit/3bcde0337352c0a70d6aa6e9f4143acd19fc71e7))
* **core:** close the JSONL stream before an early return resolves ([5bed86b](https://github.com/ayagmar/llm-usage-metrics/commit/5bed86bcdd504b47ddb348c10fb5c10ccba0d88c))
* **core:** count an untimed pi title only when the read yields text ([580a7ac](https://github.com/ayagmar/llm-usage-metrics/commit/580a7ac97fb0239fd42f2966d528bac226bdee62))
* **core:** drop results for claude calls replayed from a fork's parent ([12f7643](https://github.com/ayagmar/llm-usage-metrics/commit/12f7643b7d28526bfcb1b3252447792043a44e0e))
* **core:** freeze EVENT_KINDS ([501a61b](https://github.com/ayagmar/llm-usage-metrics/commit/501a61b8ad2cf902411d79475468bfa1355bf4d0))
* **core:** hash an event without a cost mode as the CLI derives it ([f1936ea](https://github.com/ayagmar/llm-usage-metrics/commit/f1936eab7161510bca8da6807783d378aa1a7b0a))
* **core:** hash every byte a read cursor covers ([03dcbe5](https://github.com/ayagmar/llm-usage-metrics/commit/03dcbe59cc7968e8d28d51ec4348b94a2f788bb7))
* **core:** hold no claude title action when the read has no text ([3e8096b](https://github.com/ayagmar/llm-usage-metrics/commit/3e8096b9abdc0e30828b0fb6831c4814ff5f501f))
* **core:** keep a caller-owned handle open after a positioned read ([9237a76](https://github.com/ayagmar/llm-usage-metrics/commit/9237a7698901333fab3d5e06537938489d6a89e4))
* **core:** keep a whole chunk inside a line that spans several chunks in the prefix hash ([0085291](https://github.com/ayagmar/llm-usage-metrics/commit/0085291e38e3fa54d327772ba52eb19bf1754d87))
* **core:** keep one cached version per claude fork parent ([c9bd063](https://github.com/ayagmar/llm-usage-metrics/commit/c9bd06338f38326f541f88f7d95eaa621f1883cd))
* **core:** name the source in node:sqlite load errors ([e48ae26](https://github.com/ayagmar/llm-usage-metrics/commit/e48ae26f0a900f5ce43a8f57ec26e7807d3333de))
* **core:** parse a JSONL chunk's lines as the consumer reaches them ([9965322](https://github.com/ayagmar/llm-usage-metrics/commit/99653224c4da7e01871ed851fbc361de2b04b021))
* **core:** read timestamps with no offset as UTC ([fdc5443](https://github.com/ayagmar/llm-usage-metrics/commit/fdc5443fe603146ad0abb858ce8d7ca03d5c336b))
* **core:** reject date-only window bounds in a non-ISO form ([57c38ab](https://github.com/ayagmar/llm-usage-metrics/commit/57c38ab6d48c8ea7089f9e2d51aad0e218d4d4e0))
* **core:** reject empty and surplus readSources roots before reading ([fa54636](https://github.com/ayagmar/llm-usage-metrics/commit/fa54636feed205f408603da0dcc62fbcc40145db))
* **core:** reject message roles and tool-call statuses outside their unions ([7272586](https://github.com/ayagmar/llm-usage-metrics/commit/72725866238820bf32f1af40a20e067985eecee4))
* **core:** reject readSources roots for unselected sources ([4cebb11](https://github.com/ayagmar/llm-usage-metrics/commit/4cebb11689bc3b1dc97c3337f17868c3036fd465))
* **core:** reject window bounds with a time but no UTC offset ([49e4468](https://github.com/ayagmar/llm-usage-metrics/commit/49e4468cd3c95e3ad2190b6ab1bac46cfb774a7b))
* **core:** resolve codex completedAt like claude and pi; keep records only with raw ([bfb8e1a](https://github.com/ayagmar/llm-usage-metrics/commit/bfb8e1ac976bf67427e2b2db68d588aee458bb56))
* **core:** retry a busy Antigravity database before the first event ([a708d85](https://github.com/ayagmar/llm-usage-metrics/commit/a708d855588e1c8205f87bea828608d2506b4ae8))
* **core:** retry a busy Goose database before the first event ([968bc4a](https://github.com/ayagmar/llm-usage-metrics/commit/968bc4ada063c2a878d718083eddb91c898515f0))
* **core:** share tool-call reason codes across claude, codex and pi ([1aaa586](https://github.com/ayagmar/llm-usage-metrics/commit/1aaa586a93a5de065da00dc2791483d7fabf92d6))
* **core:** skip the parent call a claude fork re-logs under a new uuid ([4a4052b](https://github.com/ayagmar/llm-usage-metrics/commit/4a4052b9108780c0f532278df61299b578afaa68))
* **core:** skip usage rows with a token count above 1e12 ([9d0c844](https://github.com/ayagmar/llm-usage-metrics/commit/9d0c844feba45beace2514562981335c53779d09))
* **core:** stop naming OpenCode in the default sqlite loader label ([38d057e](https://github.com/ayagmar/llm-usage-metrics/commit/38d057e7269d00fd4411257d7182efc8d98c6557))
* **core:** track session_meta changes per session id in every adapter ([5a88264](https://github.com/ayagmar/llm-usage-metrics/commit/5a882643b54cf23e0669b5646f5915ec129fe9ab))
* **core:** validate maxBusyRetries in the SQLite adapters ([69fdda0](https://github.com/ayagmar/llm-usage-metrics/commit/69fdda0a907ecff81d0d6dc6ceca692ef456beb4))
* **domain:** export the boundary event factory from the domain shims ([cb66b93](https://github.com/ayagmar/llm-usage-metrics/commit/cb66b9346a984c2cc04f7d817c93ae38cf89f125))
* **dsh:** read a time logged in epoch seconds as seconds ([fcba4ae](https://github.com/ayagmar/llm-usage-metrics/commit/fcba4ae9e9dbda216c2c1d8c3106200ee6e3ac1f))
* **machines:** allow parserVersions in the machine export schema header ([b952805](https://github.com/ayagmar/llm-usage-metrics/commit/b952805ca39770aee46e7ffc9346b309e9876fc1))
* **machines:** count timestamp-matched events in the Machines note ([5865240](https://github.com/ayagmar/llm-usage-metrics/commit/58652402e9437bf718009cc926c0c51a7cbe5131))
* **machines:** drop a bundle tool call or turn with an unknown status or role ([465ddae](https://github.com/ayagmar/llm-usage-metrics/commit/465ddaedeb5ff58f1182e90189183cb716afb70e))
* **machines:** find the old-remote hint anywhere in a failed export's stderr ([42c3bd8](https://github.com/ayagmar/llm-usage-metrics/commit/42c3bd8202f050ed1008ef93535f1c185adde264))
* **machines:** ignore shell text after a bundle's end line ([df61651](https://github.com/ayagmar/llm-usage-metrics/commit/df61651b0e51fa213285f33d248ec919e2d526fe))
* **machines:** let machine-export v1 headers carry fields a reader does not know ([2401f23](https://github.com/ayagmar/llm-usage-metrics/commit/2401f23e294b419a5026544a56b58c5f076b5f6e))
* **machines:** match differently parsed shared sessions by timestamp (KI-3) ([0d62bfb](https://github.com/ayagmar/llm-usage-metrics/commit/0d62bfb3d8ee5e5da1491bf2ad45434dfb9725f1))
* **machines:** resend every file once to a cache an older version synced ([5ecc3e4](https://github.com/ayagmar/llm-usage-metrics/commit/5ecc3e48997d5b589ec28d116082f1bca1d8d3a2))
* **machines:** skip the parser-version note for a machine never synced ([d33fe30](https://github.com/ayagmar/llm-usage-metrics/commit/d33fe3044faa1b49cfb9f3a3a961790b0191f6a9))
* **machines:** treat unrecorded parser versions as skew and prefer the same model ([b6baaab](https://github.com/ayagmar/llm-usage-metrics/commit/b6baaab671c150942bbaebccfb163d1705d13123))
* **opencode:** rewrite an error from closing the database like a read error ([4306de2](https://github.com/ayagmar/llm-usage-metrics/commit/4306de29721e511e5331c1841163ec98e74e68ee))
* **optimize:** keep the report for logged spend without token counts ([5830ef1](https://github.com/ayagmar/llm-usage-metrics/commit/5830ef1188222e71a5c6e34d2dc63ae92b1f6b87))
* **optimize:** price the baseline at base rates like the candidates ([6b5e698](https://github.com/ayagmar/llm-usage-metrics/commit/6b5e698047023e435c1bae0415b1017f06158339))
* **otel-export:** fail on a redirect from the OTLP receiver instead of following it ([dfdcebc](https://github.com/ayagmar/llm-usage-metrics/commit/dfdcebc4be1eaafb58484c736e5957e06fe28417))
* **otel-export:** key chat and id-less tool spans on the event, not its slice position ([ec67017](https://github.com/ayagmar/llm-usage-metrics/commit/ec67017f8619af4105e19ed3d578077166ed1746))
* **otel-export:** leave the endpoint query string out of the push summary and errors ([87bb4fb](https://github.com/ayagmar/llm-usage-metrics/commit/87bb4fb13ece4805f3acd518ca4fc49fcf0c2ba7))
* **otel:** drop gen_ai.request.model from usage records and map cloud provider ids ([25d4023](https://github.com/ayagmar/llm-usage-metrics/commit/25d40233520fcc669ce5d85087fd32dbeacebc17))
* **otel:** end the open day's metric points at the run time ([50fc8be](https://github.com/ayagmar/llm-usage-metrics/commit/50fc8be0143b6dda63f14f555d3ee43fd0384de1))
* **otel:** hash path-shaped session ids in traces unless --otel-include-paths ([5a4d77f](https://github.com/ayagmar/llm-usage-metrics/commit/5a4d77fe8de50219642ad3a5062ab49b89231e25))
* **otel:** key chat span ids on provider too, so a provider filter keeps them ([df91c87](https://github.com/ayagmar/llm-usage-metrics/commit/df91c87042b099564a6ee5a172444a4ed6b70602))
* **otel:** never print a configured header value from receiver text ([e81dfd6](https://github.com/ayagmar/llm-usage-metrics/commit/e81dfd61855abd058b83f5ee074a37d7475599ae))
* **otel:** redact only header values and words of 8 or more characters ([cb3ed2e](https://github.com/ayagmar/llm-usage-metrics/commit/cb3ed2eaf34052cb25ea0c9e8bf07b99b0cbbaea))
* **otel:** size push requests by their serialized body ([6aa8361](https://github.com/ayagmar/llm-usage-metrics/commit/6aa8361706cfba3fe8143ed1b8e47985ca5c5b53))
* **otel:** split large sessions, retry 429/502/503/504 and redact echoed headers on push ([efb3e04](https://github.com/ayagmar/llm-usage-metrics/commit/efb3e049d2a7383af53fe766c146748eb385fcdf))
* **persistence:** append a resumed read only onto the cursor it resumed from ([ec8c4a5](https://github.com/ayagmar/llm-usage-metrics/commit/ec8c4a59914eed08dcc90f7ec77f22ca3a6f9a0e))
* pluralize the last counted (s) messages; pluralize moves to core internal ([1819eda](https://github.com/ayagmar/llm-usage-metrics/commit/1819edae1a6e10e1010bf99e5f6bbbb58060ae01))
* **pricing:** apply LiteLLM long-context tiers per request ([e270705](https://github.com/ayagmar/llm-usage-metrics/commit/e2707052db86f98bbae18d8e961185c7bb110c47))
* **pricing:** count only events that use a priority-fallback bucket ([3ef191c](https://github.com/ayagmar/llm-usage-metrics/commit/3ef191cb00c481195ab62ef6a22d709ee368e861))
* **pricing:** count only flat-rate priority buckets in the priority note ([5f93bd9](https://github.com/ayagmar/llm-usage-metrics/commit/5f93bd9b215e2887470f5617370818d45cdec5da))
* **pricing:** drop retired prices that live keys already resolve to ([9d00655](https://github.com/ayagmar/llm-usage-metrics/commit/9d00655aedbc6fab5d9ea16650efb073048c3e74))
* **pricing:** flag models priced at LiteLLM priority rates ([22af088](https://github.com/ayagmar/llm-usage-metrics/commit/22af08891b9310813d6195b5fea24691633519c8))
* **pricing:** keep OpenRouter rates for explicit openrouter/minimax names ([ba9bcf0](https://github.com/ayagmar/llm-usage-metrics/commit/ba9bcf07da8a954d4ca67b5c0a7ba968abd29d67))
* **pricing:** keep retired prices that suffixed or prefixed names reach ([f0703ca](https://github.com/ayagmar/llm-usage-metrics/commit/f0703ca8ef4bcf789272a5920d2941aef4d1f420))
* **pricing:** price minimax-m2.1 and m2.5 at first-party MiniMax keys ([afa68df](https://github.com/ayagmar/llm-usage-metrics/commit/afa68df68c89db0c01ef19ae4300b7ea4e92bae7))
* **pricing:** stop a snapshot refresh when a pruned or retired file is unreadable ([32da698](https://github.com/ayagmar/llm-usage-metrics/commit/32da698f89aedc18581b0d38c81b0b462b5290db))
* **render:** end stacked measure values at one shared right edge ([c52c85e](https://github.com/ayagmar/llm-usage-metrics/commit/c52c85e81306352e660175d6c382c28d1e03e41a))
* **render:** group thousands in prune's Events column ([c093710](https://github.com/ayagmar/llm-usage-metrics/commit/c093710ddfb9384ac73d65fd9ceb26512cf9ac7c))
* **render:** leave a blank line under the wrapped header box ([f04e619](https://github.com/ayagmar/llm-usage-metrics/commit/f04e61931ca5a43cb87287e8cbf3ae86d6d3aa07))
* **render:** list prune candidates on narrow terminals ([3c79ab4](https://github.com/ayagmar/llm-usage-metrics/commit/3c79ab43b23e9e1e0e1cffdf8c46d8b6026978e3))
* **render:** pad the machine list by display width ([02f91ad](https://github.com/ayagmar/llm-usage-metrics/commit/02f91ad4e3f1e61218037e3b913ddb856d610d3f))
* **render:** pluralise file and event counts in machine output ([4352421](https://github.com/ayagmar/llm-usage-metrics/commit/435242131090731098a349a0c4d39bfc253d97c7))
* **render:** pluralise file, event and empty-day counts ([adab00a](https://github.com/ayagmar/llm-usage-metrics/commit/adab00a4543f43c200481511f524dbf4527c4397))
* **render:** print the end date of a block that crosses midnight ([1cd088c](https://github.com/ayagmar/llm-usage-metrics/commit/1cd088c478427cfeec71a3ef6b7874628ffe8f91))
* **render:** print the no-usage line in efficiency markdown ([f065e69](https://github.com/ayagmar/llm-usage-metrics/commit/f065e69f95d8f398aa7ab8dc1ba5a95788e3c8ae))
* **render:** say how a machine on another version is merged in the Machines note ([9525f87](https://github.com/ayagmar/llm-usage-metrics/commit/9525f87eb580b62c8bd56021d4cbcdcb5baeccd8))
* **render:** whole token ticks and one compact style in trends ([54ce046](https://github.com/ayagmar/llm-usage-metrics/commit/54ce0462191d85d453bac2b12f96a6747145fe62))
* **report:** name and round project cost shares alike in projects and value ([1dca31f](https://github.com/ayagmar/llm-usage-metrics/commit/1dca31f7f311fdc2c6432c091611d7e2fc1476f8))
* **session:** label projects from every row and key --by-repo like projects ([be0b59d](https://github.com/ayagmar/llm-usage-metrics/commit/be0b59d05b2baf643abc29c2a53a6efd0d9aca96))
* **share:** allow optimize's array data in the embedded envelope ([fa28d28](https://github.com/ayagmar/llm-usage-metrics/commit/fa28d28091cbeddc8e13bd2fb3bb0be0f90a994a))
* **share:** compare's cost fact says the change is unknown, not that nothing came before ([19bf6e7](https://github.com/ayagmar/llm-usage-metrics/commit/19bf6e7ed0abacb29f51e7948dff7df9894b14dc))
* **share:** count block usage only up to a narrowed end ([abec59d](https://github.com/ayagmar/llm-usage-metrics/commit/abec59db089b7bfe81a276da1ced65b1c9fcebc7))
* **share:** drop all of a spaced profile name the path scrubber finds in text ([0eb42c4](https://github.com/ayagmar/llm-usage-metrics/commit/0eb42c4d7d2c141901c24dc79cbe958244a06c10))
* **share:** drop the unreachable fallbacks in the wrapped recap clip ([245c88e](https://github.com/ayagmar/llm-usage-metrics/commit/245c88e69e48cfc11b1991fbc5a4a797f74b6053))
* **share:** find standard homes anywhere in a path, labels and text alike ([8948c13](https://github.com/ayagmar/llm-usage-metrics/commit/8948c139b126d678b85fe3a6e85dc57401d27245))
* **share:** format cost axis ticks from the step ([c80d318](https://github.com/ayagmar/llm-usage-metrics/commit/c80d31899f47df39ada8ce993027823959dbd9b0))
* **share:** hide paths and redacted names in every stderr line under --redact ([4abc862](https://github.com/ayagmar/llm-usage-metrics/commit/4abc862a82ada28d3c272de0573e5cd3b00c63c0))
* **share:** hide whole input paths with spaces in redacted stderr ([638761b](https://github.com/ayagmar/llm-usage-metrics/commit/638761bf997e8dc77e767e9a4cb346adcef01567))
* **share:** keep a Windows profile name with spaces inside its home ([28df886](https://github.com/ayagmar/llm-usage-metrics/commit/28df88667a570ebc6fa4490707bc9a190c85596c))
* **share:** keep blocks that run into the start of the view ([551f91d](https://github.com/ayagmar/llm-usage-metrics/commit/551f91dc4718bdf3e5d42f8665278eda1f8b8aa7))
* **share:** keep envelope identifiers when a project shares their name ([9b4fe37](https://github.com/ayagmar/llm-usage-metrics/commit/9b4fe376dbaf839ed914d27e00c9d0cf054cfda5))
* **share:** keep model and repository paths out of stderr under --redact ([6fe5ddc](https://github.com/ayagmar/llm-usage-metrics/commit/6fe5ddc7f74f80594fbf6a64f726978b890bfe50))
* **share:** keep the current value in compare lead tables on a phone ([709be0c](https://github.com/ayagmar/llm-usage-metrics/commit/709be0c0fb26e580d07e0ac0080886a256398ae4))
* **share:** keep tokens and cost when the tables narrow ([798d16f](https://github.com/ayagmar/llm-usage-metrics/commit/798d16ff706005e952f212519d793696a330f127))
* **share:** keep unknown and lower-bound block costs in the blocks table ([1e97096](https://github.com/ayagmar/llm-usage-metrics/commit/1e97096ab81ee69fbd1ebc2d0776fe74dfa269bd))
* **share:** label path-shaped and unlisted models model-N under --redact ([b40b220](https://github.com/ayagmar/llm-usage-metrics/commit/b40b22064a2c0f3cf6e411f5c503bf282c91db6b))
* **share:** label relative model paths and envelope models like the dictionary ([f999b1e](https://github.com/ayagmar/llm-usage-metrics/commit/f999b1ec98c7ae75e79752333a58124330157d6a))
* **share:** label the home directory ~ so no project label names the user ([7a2bc5b](https://github.com/ayagmar/llm-usage-metrics/commit/7a2bc5be114a7f29741582d7f37be6684c7a50b1))
* **share:** lead figures and wording follow --json and the terminal ([1cc3273](https://github.com/ayagmar/llm-usage-metrics/commit/1cc32739ae7a33a9431a635161d0194644b2a76f))
* **share:** lead tables keep their key columns on a narrow screen ([ed1b97f](https://github.com/ayagmar/llm-usage-metrics/commit/ed1b97f5bea7b9cf8cc94c81f22683de1c564ca5))
* **share:** let a dated optimize candidate wrap on a phone ([edbd2c1](https://github.com/ayagmar/llm-usage-metrics/commit/edbd2c1def5cdc889c14918ec60ade7e823f5957))
* **share:** let a saved view be reset to the command view ([b071ad4](https://github.com/ayagmar/llm-usage-metrics/commit/b071ad47b779ac70ed06a4ad78201562e1f4ed69)), references [#default](https://github.com/ayagmar/llm-usage-metrics/issues/default)
* **share:** mark and keyboard-scroll wide lead tables ([455cb87](https://github.com/ayagmar/llm-usage-metrics/commit/455cb87072a48a9ac30c2e9085881f37417cbbf7))
* **share:** meet AA contrast for accent text in the light theme ([569f9fd](https://github.com/ayagmar/llm-usage-metrics/commit/569f9fde36ef1820ecf52b3a2a31af049e8d9f3c)), references [#9e4528](https://github.com/ayagmar/llm-usage-metrics/issues/9e4528)
* **share:** name file-URI models by their basename ([f14e5fe](https://github.com/ayagmar/llm-usage-metrics/commit/f14e5feb99aa7e46bb82e24c6223a31b060c3c37))
* **share:** name logged path-shaped models model-N in redacted stderr ([c6f9db0](https://github.com/ayagmar/llm-usage-metrics/commit/c6f9db0867938a15dcf61bab135593ca95deba82))
* **share:** name the right day and hour for the largest block on long spans ([2a15c87](https://github.com/ayagmar/llm-usage-metrics/commit/2a15c8797fe9b2600bda06df3ce1d11f28f55220))
* **share:** redraw resized charts on the next frame ([cfda4b2](https://github.com/ayagmar/llm-usage-metrics/commit/cfda4b2379792c3cae588a4e8b3838215575a790))
* **share:** reject payloads whose view defaults or session indexes are invalid ([c7ffa99](https://github.com/ayagmar/llm-usage-metrics/commit/c7ffa99c2d827ce13419b35f1fe89774378f414a))
* **share:** replace names only in free-text envelope fields ([fd2f8f3](https://github.com/ayagmar/llm-usage-metrics/commit/fd2f8f3dc4422aac65e839681b63a665dbc007d7))
* **share:** replace the report file instead of writing through a symlink ([49b3688](https://github.com/ayagmar/llm-usage-metrics/commit/49b36887e5f318268e2e5c6e08a16fa59ed8af90))
* **share:** scope the efficiency share file to the usage the report counts ([a207ce3](https://github.com/ayagmar/llm-usage-metrics/commit/a207ce36828f85e5258615692985362b831865a9))
* **share:** scrub paths after | > « and drive paths with spaced folders ([113e17a](https://github.com/ayagmar/llm-usage-metrics/commit/113e17a2c70d45b2051295db7ebd7cafc84549f8))
* **share:** scrub paths after a colon and spaced profile names ([1bc2ce4](https://github.com/ayagmar/llm-usage-metrics/commit/1bc2ce46214d4aeada27b72a44cb0ee7bbf72291))
* **share:** scrub paths and redacted names anywhere in envelope text ([a883272](https://github.com/ayagmar/llm-usage-metrics/commit/a883272ad94dc0a98021f30c92d75390b7d705c4))
* **share:** shorten a long filter list in the header badge ([7a50645](https://github.com/ayagmar/llm-usage-metrics/commit/7a506454d4eaaba1fa985b7a7d548f0d2fd61640))
* **share:** show an open-ended window ending on the generation date ([2b71802](https://github.com/ayagmar/llm-usage-metrics/commit/2b718027542971d78d4a7f0f8c9957d3e8cd3d63))
* **share:** show the first date with data as an open period start ([4f1994a](https://github.com/ayagmar/llm-usage-metrics/commit/4f1994a025a2d2c27f7a7a7581d0bf69ebfe95b0))
* **share:** spell every standard home directory ~, not only the local one ([c928a37](https://github.com/ayagmar/llm-usage-metrics/commit/c928a3727038f2af42cf7c28c67cde847f923965))
* **share:** stop chart axes at the generation date ([d5a5381](https://github.com/ayagmar/llm-usage-metrics/commit/d5a53816b4aec7733d506b9615465e3d7419355f))
* **share:** stop the sort caret adding 1px of table overflow ([fe6fa6c](https://github.com/ayagmar/llm-usage-metrics/commit/fe6fa6cd48173066280912c1f5da20a1a5466c74))
* **share:** stop the wrapped recap at the generation date ([e8dfc71](https://github.com/ayagmar/llm-usage-metrics/commit/e8dfc7157825b462612807ac38cc48e64ce8a282))
* **share:** warn when the share file stays over its size target ([20d1f79](https://github.com/ayagmar/llm-usage-metrics/commit/20d1f79da9c83e19f3973cc2d99c9557a92823a5))
* **share:** wrapped lead's active time uses the terminal's whole hours ([c4ca8fe](https://github.com/ayagmar/llm-usage-metrics/commit/c4ca8feaf4a4c5e4e733f9e1595f7394efea0045))
* **source:** bump the Codex parser version to 6 ([6655602](https://github.com/ayagmar/llm-usage-metrics/commit/6655602f409a659b11364a641b32b8252a0511eb))
* **source:** bump the OpenCode parserVersion to 5 for per-step V1 events ([1458cce](https://github.com/ayagmar/llm-usage-metrics/commit/1458ccee969fab71ff5c964f57b18287f535a665))
* **source:** count every step of a multi-step OpenCode V1 message ([40b0a45](https://github.com/ayagmar/llm-usage-metrics/commit/40b0a452fafbf37e886dd1e77ce73c74d8c2f1d3))
* **source:** end an old Codex fork's copied block at the parent's last running total ([82e2ef9](https://github.com/ayagmar/llm-usage-metrics/commit/82e2ef97e640e08e2db02e74580271bd3a1ac405))
* **source:** match an old Codex fork's copy by its user messages and find archived parents ([53439d2](https://github.com/ayagmar/llm-usage-metrics/commit/53439d255c87491298d584fa976e54d7daab6a9a))
* **source:** read each step of a multi-step OpenCode V1 message as its own request ([4b745cd](https://github.com/ayagmar/llm-usage-metrics/commit/4b745cd779eb3c8738ac08153984d6b4eb5d46cf))
* **source:** reuse a stored Codex entry only when its parent cannot have changed ([f7bf089](https://github.com/ayagmar/llm-usage-metrics/commit/f7bf0893f9ef1f35c060525af817f3aa413d18d6))
* **sources:** honour the selection's require flag for Claude's multi-root adapter ([51f46fc](https://github.com/ayagmar/llm-usage-metrics/commit/51f46fce5c4a9386db132d513b3971dc63e5454f))
* **source:** skip migrated OpenCode V2 rows with NOT EXISTS ([f5b25e2](https://github.com/ayagmar/llm-usage-metrics/commit/f5b25e241c93766f6e9e9df8581e23e8c8ea2a50))
* **source:** skip OpenCode's pre-release opencode-next.db in discovery ([196836b](https://github.com/ayagmar/llm-usage-metrics/commit/196836b81306ef3b9e84d1b967a63d782858843b))
* **store:** cap a run's WAL at 10,000 pages ([a84c340](https://github.com/ayagmar/llm-usage-metrics/commit/a84c3407c4761b869661aea84d20f1ccb04e7248))
* **store:** open a migrated store when its vacuum fails ([42d8dbb](https://github.com/ayagmar/llm-usage-metrics/commit/42d8dbb9fe1a4eeef3dc8c7eb87cc52f32f44e60))
* **store:** read a machine cache's events in one read transaction ([f68a9fc](https://github.com/ayagmar/llm-usage-metrics/commit/f68a9fccbef29aab0ebc1ff5bd73d549ab778f8e))
* **store:** vacuum once after the v4 to v5 copy migration ([80d5b33](https://github.com/ayagmar/llm-usage-metrics/commit/80d5b33164c43045ed5c6b1eb1a597f2f7a9481c))
* **summary:** set month to date against the same days of last month ([99f5310](https://github.com/ayagmar/llm-usage-metrics/commit/99f5310b3655f6e3de2f8f47a33868393c084d2d))
* **trends:** split --by-repo active time at every project switch ([6b04fe4](https://github.com/ayagmar/llm-usage-metrics/commit/6b04fe43fb3dfa6a3a85e6f86fca00206e05116f))
* **update:** skip the update check for completion and --help-all ([5285a9c](https://github.com/ayagmar/llm-usage-metrics/commit/5285a9cee4f2662352d9a7cb2f77d706f67c6238))
* **update:** skip the update check for config commands ([ed40279](https://github.com/ayagmar/llm-usage-metrics/commit/ed4027987aeb297d9f01da247338442e3dc82265))
* **utils:** keep the date range end bound as time-buckets read it ([7b3e09a](https://github.com/ayagmar/llm-usage-metrics/commit/7b3e09ad0e8e70b9ab4bb19ba8b6c84fb6101bbf))
* **value:** default to a plan the source filter keeps ([4a3b0b1](https://github.com/ayagmar/llm-usage-metrics/commit/4a3b0b1ab7c417a8d8855a2b55b3a8ca0f23a655))
* **value:** end the month range at today ([2db0a40](https://github.com/ayagmar/llm-usage-metrics/commit/2db0a4070fa979f6046ff3d497a248b8a65a9b39))
* **value:** say which plan the default fell back to ([663be6d](https://github.com/ayagmar/llm-usage-metrics/commit/663be6d0ca6d972f6bfe26edd725594f4410d1ef))
* **value:** warn about plan sources without files per plan ([0dc865a](https://github.com/ayagmar/llm-usage-metrics/commit/0dc865a3ca690d2ac41e18f422e771dde5e1579a))

### Performance Improvements

* **cli:** add the cost mode to parsed events in place ([8955aaf](https://github.com/ayagmar/llm-usage-metrics/commit/8955aaf3f522c600007b9799081cb065d1adcf1a))
* **cli:** build each hourly key once per day window and hour ([7ba2351](https://github.com/ayagmar/llm-usage-metrics/commit/7ba23519fc128279bcda899d9b930aea02ec1ef7))
* **cli:** build the statusline without the full summary ([b0f5e0c](https://github.com/ayagmar/llm-usage-metrics/commit/b0f5e0cb91021e3ccd69208387eb84ce25d3718b))
* **cli:** cap auto parse workers at six when the run writes the event store ([b8ee607](https://github.com/ayagmar/llm-usage-metrics/commit/b8ee60781af786e05b5af75634642ba0883a4d1e))
* **cli:** cap parse worker young generation and give statusline 8 workers ([9061b62](https://github.com/ayagmar/llm-usage-metrics/commit/9061b6208777dc80f474e3a783b77fc49027827f))
* **cli:** cap the statusline's auto parse worker pool at four ([3ff7e9c](https://github.com/ayagmar/llm-usage-metrics/commit/3ff7e9cda4369c100183d60228626f640dfdf96f))
* **cli:** cap the statusline's auto parse worker pool at two ([eb6d68c](https://github.com/ayagmar/llm-usage-metrics/commit/eb6d68c9a60b7468d76be53ab1bbc75426d4935e))
* **cli:** confirm a stored Codex fingerprint without opening the file ([1494529](https://github.com/ayagmar/llm-usage-metrics/commit/1494529f3c0b7fad50876e7bcd2aa4d68bc7878b))
* **cli:** filter summary windows by UTC date bounds ([60ca042](https://github.com/ayagmar/llm-usage-metrics/commit/60ca042b4d25be82becf2a79a0269de6bc75de52))
* **cli:** keep a read cursor only for files seen growing ([d5abe55](https://github.com/ayagmar/llm-usage-metrics/commit/d5abe556db15a7968237748394a67fc93be61f27))
* **cli:** post each parse worker its next task before it answers ([746dc4d](https://github.com/ayagmar/llm-usage-metrics/commit/746dc4d0d16feec393dd3d9086d171bf6ae90e18))
* **cli:** read a Codex file's store entry once per lookup ([86021e1](https://github.com/ayagmar/llm-usage-metrics/commit/86021e1851622d9b2f492330ee38686bbabc56e3))
* **cli:** record per-file session ids only for session --timeline ([a927210](https://github.com/ayagmar/llm-usage-metrics/commit/a927210e377a952ec2093b312208a836fbfad697))
* **cli:** share one lazily spawned parse pool across worker sources ([bb0fe2b](https://github.com/ayagmar/llm-usage-metrics/commit/bb0fe2b8b57e069c34e7f4500b12eed153cbc8aa))
* **cli:** skip live reads of files older than the window ([103dbaf](https://github.com/ayagmar/llm-usage-metrics/commit/103dbaf42b8e7b874907375439e864fbf04cf029))
* **cli:** skip loading pricing for --no-cost usage and blocks reports ([a1a68bb](https://github.com/ayagmar/llm-usage-metrics/commit/a1a68bbd4bdbac9e45708d9865eb97e83de55879))
* **codex:** match the settings event at its fixed offset in the prefilter ([72ed00b](https://github.com/ayagmar/llm-usage-metrics/commit/72ed00b2e3b2883007e6838efed1a6ed12c842f1))
* **core:** assign defined event fields without a temporary object per key ([bfac5a6](https://github.com/ayagmar/llm-usage-metrics/commit/bfac5a61f713faecbdc85cc3caceca8086eaa015))
* **core:** cut per-line overhead of pi, codex and claude event reads ([f2eece0](https://github.com/ayagmar/llm-usage-metrics/commit/f2eece0500e178047f72d88eeae093786f534e31))
* **core:** read JSONL files into one reused buffer per thread ([c6ed1a8](https://github.com/ayagmar/llm-usage-metrics/commit/c6ed1a869a6b29db2ae9cf07739b557cf9864439))
* **core:** read JSONL records in batches of one chunk ([1fe4517](https://github.com/ayagmar/llm-usage-metrics/commit/1fe4517bc625a01a0bd18c1b15fc651e1cd0ae95))
* **core:** skip unused tool result text when reading claude events ([17df75d](https://github.com/ayagmar/llm-usage-metrics/commit/17df75d61917fd1800e3879d8604af0767ead0d4))
* **core:** yield codex usage events without a per-event generator ([c1cbe84](https://github.com/ayagmar/llm-usage-metrics/commit/c1cbe8400ce458caa3bdc5252655afb2c783feaa))
* **core:** yield parsed records directly on the read path ([48889fc](https://github.com/ayagmar/llm-usage-metrics/commit/48889fc90445b087a39d2a40b6c59c52d5a4c023))
* **dsh:** slice zstd logs as they are read instead of buffering the file ([ad8bed3](https://github.com/ayagmar/llm-usage-metrics/commit/ad8bed365b7d0f4e99cbb8a939353d75bb5ccb83))
* **machines:** tag cached machine events in place ([bfc2297](https://github.com/ayagmar/llm-usage-metrics/commit/bfc22975b09ea7441423e156529c9b255f0bc165))
* **persistence:** check stored timestamps with the canonical reader ([c315a7b](https://github.com/ayagmar/llm-usage-metrics/commit/c315a7bcc95e4b1f8e1d330703332b05f3bc3f52))
* **pricing:** keep each model name's rates in the pricing lookup ([9fbf5ab](https://github.com/ayagmar/llm-usage-metrics/commit/9fbf5ab06edfc5528ec36e06217bca6627501f42))
* **pricing:** share the outcomes of events left unpriced ([c990e9f](https://github.com/ayagmar/llm-usage-metrics/commit/c990e9f8d7640c1df532e1b4fd99fedeab3f66fa))
* **session:** live-read only the files that hold the timeline session ([b4e5e01](https://github.com/ayagmar/llm-usage-metrics/commit/b4e5e018f1b1e604ce52fcb43436beca32dce27f))
* **session:** read live events of the timeline's source only ([54f3a02](https://github.com/ayagmar/llm-usage-metrics/commit/54f3a02fd0a242dc8b0446dc234ca720f932f1ad))
* **store:** accept a repeated stored text value without re-checking it ([8ebf53f](https://github.com/ayagmar/llm-usage-metrics/commit/8ebf53ff4ec4375c98c3ea28f193dc47d496abe0))
* **store:** checkpoint a run's writes once, when it closes the store ([325d33f](https://github.com/ayagmar/llm-usage-metrics/commit/325d33fbdb82f6a75b2fe32b2edc7d4c4c26ae01))
* **store:** key tool call and message rows by an integer file id ([70a23a2](https://github.com/ayagmar/llm-usage-metrics/commit/70a23a26af0ee1102a5656b08f41a6bf287d60ee))
* **store:** key usage events by the integer file id ([dd97469](https://github.com/ayagmar/llm-usage-metrics/commit/dd9746999e87a89f499e8426c0a44d125c418e77))
* **summary:** narrow events once and read active days from daily rows ([0b9af23](https://github.com/ayagmar/llm-usage-metrics/commit/0b9af23ea07d0326684a1cec6bc2c4e1ea18f136))
* **time:** read canonical timestamps from char codes, without the memo ([93a5411](https://github.com/ayagmar/llm-usage-metrics/commit/93a5411e62ecb09b0934a1e6fc023400bb1a9c2a))
* **utils:** keep the UTC day start between canonical timestamps ([19f1257](https://github.com/ayagmar/llm-usage-metrics/commit/19f1257293ad22fc22a76a51a0fb516e9cb5df66))

### Code Refactoring

* **core:** make read the only adapter read path ([3fb11b9](https://github.com/ayagmar/llm-usage-metrics/commit/3fb11b924bca7909302862473b5fcee6dbd37dfe))
* **core:** move CLI-shaped names off the root entry ([7f9adec](https://github.com/ayagmar/llm-usage-metrics/commit/7f9adec790d9d8d0bb051861d9a0e64aac5603b8))

## Unreleased

Changes on `master` since 0.11.0 that are not in a release yet. [Upgrading](https://ayagmar.github.io/llm-usage-metrics/upgrading/#unreleased) explains what to change in scripts for each breaking or behaviour change.

### Breaking

- **`--share` writes an interactive HTML file** instead of a 1200×630 SVG card and an HTML page that exported a PNG. File names keep their stem and change extension: `usage-monthly-share.svg` becomes `usage-monthly-share.html`.
- **`events` CSV** gains a `cacheWrite1hTokens` column after `machine`, the last column.
- **`session` table**: the `Repo` column is now `Project`, labelled as the projects report labels it.
- **`config show`** prints the effective setup by section (config file, sources, event store, machines, pricing, defaults), each value with where it came from, instead of the config file path and the `Active config:` block. It now has `--json`.

### Added

- `hourly`: usage hour by hour, today unless `--last`, `--since`, `--until` or `--all`. In `--json`, rows of the hour repeated when clocks go back carry `repeatedHour`.
- `projects`: cost, tokens, events, active days and top models per project, costliest first.
- `blocks`: estimated 5-hour usage blocks per source, with the active block and its burn rate.
- `value`: the API-priced cost of each month against subscription plan prices, per plan and project.
- `pricing <model...>`: how a model name resolves to a price: the matched pricing key and rule, overrides, where the prices came from, rates per 1M tokens and tiers. It never reads usage.
- `--by-repo` on `daily`, `weekly`, `monthly`, `hourly`, `trends` and `compare` splits rows by project.
- `--repo` counts only the named projects in `summary`, the usage reports, `projects`, `compare`, `trends`, `session`, `blocks`, `value`, `efficiency`, `optimize`, `tools`, `context` and `events`. A path matches that root and the roots under it; a name matches the end of a root.
- `--cost-mode explicit|estimated|both` on every command with pricing options. The default, `both`, keeps the earlier behaviour, and stderr now counts events that logged `$0` with tokens and were estimated.
- The interactive report from `--share`: period, source, model and project filters, hour to month grouping, sortable tables, a project to session drill-down, a 5-hour blocks chart, PNG and SVG chart export, and light and dark themes. It loads nothing from the network. `--redact` labels projects `project-N`, machines `machine-N`, and models that LiteLLM does not list or whose name holds a path `model-N`. The file is written with mode `0600`.
- `tools`: tool calls per tool from claude, codex and pi sessions, with errors, error rate, calls with no result, sessions and the top project. `--by-source`, `--by-repo` and `--top`. Tool calls come from the event store, departed files that history serves included.
- `context`: per model, or per session with `--by-session`, the peak prompt, requests above 200k tokens, what the long-context tier rates added, and requests above 80% of the model's context limit (LiteLLM's `max_input_tokens`, kept with the prices).
- `session --id <id> --timeline`: one session request by request with the running cost, between them its tool calls and user and assistant turns, from the event store.
- Spend spikes: a day that cost at least $1 and at least 3 times the median of the active days among the 28 before it. `summary` names the costliest one of the last 7 days under the table (`spike` in `--json`), and `trends` with the cost metric (the default) lists spike days and sets `spike: true` on them in `totalSeries`.
- `summary --json` gives each period a `previous` window: yesterday, the 7 days before, and the same days of last month for month to date. The share page sets each summary period against it.
- `events --format otlp-traces`: OpenTelemetry traces as OTLP/JSON Lines on stdout, one trace per session with a span per usage event and per tool call, following the GenAI semantic conventions. Ids are derived from the data, so a re-export gives the same bytes and a span keeps its id in any date window that includes it. Repository paths, and session ids that hold one (qwen chats without an id), are left out or hashed unless `--otel-include-paths` is given. See [OpenTelemetry export](https://ayagmar.github.io/llm-usage-metrics/otel/).
- `events --format otlp-metrics`: daily token and cost counters as OTLP/JSON Lines, one line per agent and day in `--timezone`. Token counts use the GenAI `gen_ai.client.inference.usage.*` counters and cost goes in `llm_usage.cost_usd`, all DELTA Sums whose points span the day, or for the current day end at the run time. A DELTA point sent twice counts twice; the page shows how to send each day once. Metric backends often reject old points; the [OpenTelemetry export](https://ayagmar.github.io/llm-usage-metrics/otel/#metrics) page covers Prometheus and Datadog.
- The OTLP exports follow `semantic-conventions-genai` commit `f49da22`. `chat` spans leave out reasoning and cache token counts that are zero, and `execute_tool` spans carry `gen_ai.agent.name`. `otlp-metrics` adds the per-inference token histograms `gen_ai.client.inference.operation.input_tokens` and `.output_tokens`, and `gen_ai.execute_tool.duration` for tool calls whose log records when they ended.
- `events --otlp-endpoint <url>` sends the `otlp-traces` or `otlp-metrics` export to an OTLP/HTTP receiver instead of printing it, with headers from `OTEL_EXPORTER_OTLP_HEADERS`. Requests stay under 4 MiB (a larger session is split across requests, root span first), time out after 10 seconds, and are retried on `429`, `502`, `503` or `504` up to 4 attempts, after `Retry-After` or a 1, 2 and 4 second backoff; a `Retry-After` over 60 seconds fails the push. Redirects are not followed, an endpoint that already ends with `/v1/traces` or `/v1/metrics` is used as is, and header values a receiver echoes back are redacted, or the receiver's message withheld. See [Push to a receiver](https://ayagmar.github.io/llm-usage-metrics/otel/#push-to-a-receiver).
- `--help-all` works on every command and subcommand. `llm-usage --help-all` prints the root help instead of the summary's.
- `--all` works on every report that reads usage. `trends` charts every day since the first usage with it, and `hourly` every hour. Where the default is already the full history it changes nothing, and `summary`, `compare` and `wrapped` ignore it.
- `machine export` records each source's parser version in the bundle header.
- `machine export` sends each file's tool calls and turns (no text) in bundle format 1, which 0.11.0 still reads. `tools` and `session --timeline` include other machines, and `tools` takes `--machine`, `--no-sync` and `--history` like the other reports. A machine running 0.11.0 or older sends usage only; its tool calls appear once it is updated and synced again. The first sync after the syncing machine upgrades fetches every file once, so tool calls a 0.11.0 sync dropped are not lost.
- The parsers are a separate package, [`@ayagmar/agent-sessions`](https://ayagmar.github.io/llm-usage-metrics/library/), versioned on its own. It is not on npm yet; the CLI bundles it. It exports `dedupeToolCalls`, which counts a tool call that a resumed or forked transcript repeats once.

### Changed

- **Long-context tiers**: a request whose prompt is over a model's LiteLLM threshold bills at the higher tier for the whole request. Tiers apply to events that record one request: every claude, gemini, pi, opencode and antigravity event, and codex events logged per response or equal to the row's `last_token_usage`. `events` marks them with `singleRequest: true`. Pricing caches written before tiers existed are discarded once.
- **Priority rates**: stderr counts the events priced at a priority rate, for a model that LiteLLM lists only with a priority rate for a token bucket. Prices are unchanged.
- **Retired prices** are dropped when a live LiteLLM key prices the same name at the same rates, so a few model names resolve to a different key.
- **MiniMax M2.1 and M2.5** (and their `-free` names) are priced at MiniMax's own LiteLLM keys instead of OpenRouter's retired ones: $0.30 input, $1.20 output, $0.03 cache read and $0.375 cache write per 1M tokens. M2.5 was $0.27, $1.08 and $0.027 with no cache-write rate; M2.1 cache writes were $0. Names that spell out OpenRouter (`openrouter/minimax/minimax-m2.5`) keep OpenRouter's rates.
- **`optimize`** prices its baseline at base rates, as it prices the candidates, so a tier premium never shows up as savings.
- **Machines**: when two machines parse a shared session's source with different parser versions, or one recorded none, sync matches their events by timestamp instead of by content hash and warns until both run the same release.
- **Terminal output**: every table aligns text left and numbers right, including the stacked list on narrow terminals; `prune` summaries and `doctor`'s per-source lines say `1 file` and `2 files`; `trends` uses whole token ticks, and its token totals show three significant digits (`2.17K` instead of `2.2K`); `efficiency` and `optimize` print the shared no-usage message instead of an all-zero table.
- **Speed**: Claude and pi files parse on the worker pool, as Codex files already did; `statusline` no longer builds the full summary; DeepSeek Harness zstd logs are read as a stream instead of whole; JSONL files are read one 1 MiB chunk of records at a time instead of one record at a time.
- **Growing transcripts**: once a run has seen a claude, pi or qwen file grow, later runs that find it grown again read only the appended lines and add their events, instead of reading and storing the whole file again. On a synthetic 422 MB corpus with a 30 MB transcript growing by one turn per run, a run takes about 150 ms instead of 250 ms. Any other change still reads the whole file, as does a change to bytes a previous run already read. In the library, the claude and pi adapters honour `resume`: `onStart` reports in `replaced` the last events a resumed read yields again, and `onCursor` reports `partialLine`.
- **`--no-cost`** on `hourly`, `daily`, `weekly`, `monthly` and `blocks` no longer loads prices, so a cold pricing cache with no network no longer fails these reports. Models tied on tokens are then ordered by logged cost only. `projects` and `value` still load prices to rank by cost.
- **Cold runs** (empty event store) are faster than in 0.11.0 and use more memory, because each parse worker holds its own heap. On the maintainer's logs, a cold `statusline` takes 3.08–3.36 s at a 724–787 MB peak, against 5.75–5.83 s at 616–701 MB in 0.11.0. Every command, `statusline` included, uses up to 6 workers when `parseWorkers` is `auto` and the event store is on (8 with it off), each with a 2 MB young generation: past six, workers wait on the main thread's store writes and only add their heaps. Each thread reads JSONL files into one reused 1 MiB buffer, so used read buffers no longer pile up in a worker until its next full garbage collection. A lower `parseWorkers` lowers the peak.
- **Event store** schema v5 keeps each claude, codex and pi file's tool calls and messages (role, ids, model and text length, never text). The first run after upgrading reads those sources' files on disk again once; a file that departed before then keeps its usage and has no tool calls. `doctor` and `prune` count tool calls and messages as events.
- **Claude tool results**: reading Claude tool calls and turns skips the text of tool results, which nothing reads, instead of decoding and parsing it, so that first run takes less time and memory.
- **Projects** are described as the working directory the tool recorded, not the repository root, in help, docs and schemas.
- **`--version`** is read only before the command word: `llm-usage daily --version` fails with an unknown-option error, and `llm-usage --version` prints the version.
- **`statusline` ticks that overlap** share a lock next to the event store: while one tick parses a cold store, the others wait up to a second and then print `warming up…` instead of each parsing every file. The first tick that finds no usage logs prints a one-time hint on stderr.
- **Update check** is skipped for `config`, `completion` and `--help-all` too, as it already was for `statusline`, `machine export`, `help`, `--help` and `--version`.
- **Messages**: `projects --top` now says "must be a positive integer" and `optimize --top` rejects leading zeros, as the other reports do.

### Fixed

- A forked Codex session no longer counts the parent's usage again on the day of the fork. The lines Codex copies from the parent are skipped, and the fork counts only its own turns. Codex 0.152 and later mark where the copy ends. For older forks, and for subagents Codex 0.120 to 0.134 spawned with a copy of their parent's turns, the copy is found by matching the parent rollout, looked up under the sessions directory and `archived_sessions`. Without the parent they count as before, and so does a fork whose parent is deleted after both were counted, next to the parent's usage that the event store keeps. Every fork, old ones included, is now reported as its own session rather than under the parent's id.
- OpenCode V2 databases parse, one event per model step, instead of failing with a schema drift error. A V1 database that OpenCode V2 migrated in place counts each message once.
- An OpenCode V1 message with several model steps gives one event per step, from its `step-finish` parts, each with that step's tokens and cost. It gave one event with the last step's tokens and the cost of every step.
- OpenCode discovery skips `opencode-next.db`, the pre-release V2 database that OpenCode 2 imports into `opencode.db`. It failed with a schema drift error and would have counted those sessions twice.
- Goose and Antigravity retry a database that is busy when a read starts, instead of failing the source.
- A timestamp with no offset (`2026-01-02T03:04:05`) reads as UTC instead of in the machine's time zone, so a file gives the same events on every machine. Every source's files are parsed again once after upgrading.
- A usage row with a token count above 10¹² is skipped and counted among the skipped rows instead of swamping the totals.
- DeepSeek Harness reads a `time` logged in epoch seconds as seconds instead of as a date in 1970.
- `optimize` keeps its report when a provider's events carry a logged cost but no token counts, instead of printing the no-usage message.
- `prune` groups thousands in its Events column and lists candidates as labelled values on narrow terminals.
- `machine list` keeps its columns aligned when a name or ssh target has wide characters.
- `session` labels each project from every row in the window, as `projects` does, so a label no longer depends on `--top` or `--id`, and `--by-repo` keys rows as `projects` does, so `/x/app` and `/x/app/` are one row.
- The priority-rate note on `stderr` no longer counts an event whose priority-only bucket was billed at a long-context tier rate or the one-hour cache-write rate.
- The history note, `doctor`, `machine export` and machine sync messages say `1 event` and `2 departed files` instead of `event(s)` and `file(s)`, and group thousands.
- On a Node.js version outside the supported range (22.16+ or 24+), the CLI says which versions it needs instead of failing on a missing API.
- `efficiency --markdown` prints the no-usage message when no period has both commits and usage, as the terminal output does, instead of an all-zero table.
- Root help examples that are wider than the terminal wrap between flags with shell line continuations, so they still paste as one command.
- `trends` and `wrapped` fall back to UTC when the system reports no time zone, as the other reports do.
- Share page: a report made with `--all` shows the first date with data as the period start instead of a blank date field; a long filter list in the header badge shows three names and counts the rest; wide summary tables shade the edge that has more columns and scroll with the keyboard.
- Library: `since` and `until` throw on a date-only bound that is not an ISO date (`'June 1, 2026'`), which `Date.parse` would read as local midnight; `maxBusyRetries` on the SQLite adapters throws unless it is a non-negative integer; a failed `node:sqlite` load names the source.

## [0.11.0](https://github.com/ayagmar/llm-usage-metrics/compare/v0.10.2...v0.11.0) (2026-10-13)

### Bug Fixes

* **claude:** count rows a branched session copied once ([16fd74c](https://github.com/ayagmar/llm-usage-metrics/commit/16fd74cb40ebe78f206a84a9f0e0d9c0e92b8a3a))
* **claude:** name the continued-session copies and keep export checks exact ([acf51f6](https://github.com/ayagmar/llm-usage-metrics/commit/acf51f65c88fe1ff3a14dd2ba75934132dddbcb1))
* **cli:** accept --last on trends, keep --days as an alias ([7ab0391](https://github.com/ayagmar/llm-usage-metrics/commit/7ab03913de1fe00b06033c61d59f3d8c050a810d))
* **cli:** explain ~ only for the events a report shows ([36a2f24](https://github.com/ayagmar/llm-usage-metrics/commit/36a2f2460fc4ff1fb9a1e94b3ffa8616e88559a2))
* **cli:** explain the ~ cost marker on stderr ([89513ee](https://github.com/ayagmar/llm-usage-metrics/commit/89513eef55039c97a05ea262b3a1f1a3addf547f))
* **cli:** make date, granularity, optimize and repo errors actionable ([dbf84bd](https://github.com/ayagmar/llm-usage-metrics/commit/dbf84bd717af0dde9e7feb5b2457db74419698a6))
* **cli:** stack help on phone-width terminals and keep the --json hint ([0c98581](https://github.com/ayagmar/llm-usage-metrics/commit/0c98581dce4528e50d26588e417425348176e82e))
* **cli:** tighten provider hint, missing-git and repo-dir messages ([dfea63d](https://github.com/ayagmar/llm-usage-metrics/commit/dfea63d342ba8976831dccc7555d757705f4fa49))
* **cli:** validate trends --last with the usage reports' 10000 cap ([e137a63](https://github.com/ayagmar/llm-usage-metrics/commit/e137a63abda87f31ea9ab1d2d5f2b8c6ee6293ad))
* **cli:** wrap help on narrow terminals and drop options that do nothing ([0e9f9bd](https://github.com/ayagmar/llm-usage-metrics/commit/0e9f9bdece0b7fcb1897f93b79d8bcab670676c4))
* **filters:** convert every timestamp when a window bound reaches year 9999 ([1742ffd](https://github.com/ayagmar/llm-usage-metrics/commit/1742ffd650077ac1e9b4400ebbd7d66e6011f583))
* **history:** bind override-only marks positionally for Node 22 ([f07c313](https://github.com/ayagmar/llm-usage-metrics/commit/f07c3130eb79737331822cb036596b222db13e7b))
* **history:** count every live hash when a departed event has no stored hash ([c4a1862](https://github.com/ayagmar/llm-usage-metrics/commit/c4a18623914f2bf2194281fc0ae2683c31cfda15))
* **history:** keep files read from a custom directory out of default history ([0aaa75f](https://github.com/ayagmar/llm-usage-metrics/commit/0aaa75feb9f42762e6e8e4ded9ba7dfa5e5ebd01))
* **history:** warn instead of disabling the store when a claim fails ([0a2b21f](https://github.com/ayagmar/llm-usage-metrics/commit/0a2b21f42e4dd1aee596989818c400fd1037158b))
* **machines:** say why the last sync failed in reports ([1ac405d](https://github.com/ayagmar/llm-usage-metrics/commit/1ac405d9b8906cb757102446f75165f86b16506f))
* **machines:** strip terminal escapes from sync errors and name first-sync failures ([3a0c231](https://github.com/ayagmar/llm-usage-metrics/commit/3a0c231c27934ff15260a158753da472e15caab7))
* **optimize:** price one-hour cache writes for candidates like the baseline ([6d4ae8d](https://github.com/ayagmar/llm-usage-metrics/commit/6d4ae8de883360cd6a5c6231fe65b494e48bb637))
* **optimize:** suggest a provider only when it is in the data ([d087d37](https://github.com/ayagmar/llm-usage-metrics/commit/d087d3761685c561df77abd60a00c3d945d8bfa9))
* **render:** address review of empty-state messages ([a37dfab](https://github.com/ayagmar/llm-usage-metrics/commit/a37dfabe9b44586a57875f482b40fead4855fffe))
* **render:** list rows when a table cannot fit a narrow terminal ([6fbdbc4](https://github.com/ayagmar/llm-usage-metrics/commit/6fbdbc4cc95fd2be4f29564902b9455b5b733998))
* **render:** print one message for empty reports and point summary at older usage ([28b0f1f](https://github.com/ayagmar/llm-usage-metrics/commit/28b0f1f557109e09a3945055ca311d3c0be4589a))

### Performance Improvements

* **claude:** compare same-timestamp events before building copy identities ([93d82c4](https://github.com/ayagmar/llm-usage-metrics/commit/93d82c48754cd5530e4703afc1915961c937694c))
* **filters:** skip time zone conversion for timestamps far from the window edges ([bb02167](https://github.com/ayagmar/llm-usage-metrics/commit/bb021671196520334097a20d85c81c3d7754a77b))
* **history:** count live hashes only for what departed files hold ([8c934f9](https://github.com/ayagmar/llm-usage-metrics/commit/8c934f9a1e694f978ecac28a009f520045b3bacf))
* **machines:** read wide cache windows in file order ([e344aaa](https://github.com/ayagmar/llm-usage-metrics/commit/e344aaa038ba903a8f9258d310243f977290c2d8))
* **machines:** size the wide-window threshold on the real row count ([49af1ec](https://github.com/ayagmar/llm-usage-metrics/commit/49af1ec75070a48216f1c1237aaf581d463ec08d))
* **time:** keep the local-date memo for a whole run ([487b1bb](https://github.com/ayagmar/llm-usage-metrics/commit/487b1bbe79262199f6735da974f3d0ebde44c728))

## [0.10.2](https://github.com/ayagmar/llm-usage-metrics/compare/v0.10.1...v0.10.2) (2026-10-10)

### Features

* **summary:** split this month's cost by machine ([9c9cd70](https://github.com/ayagmar/llm-usage-metrics/commit/9c9cd700168667cc44a9f48bcee30041bdee1a05))

### Bug Fixes

* **pricing:** bill Claude one-hour cache writes at the one-hour rate ([d30d961](https://github.com/ayagmar/llm-usage-metrics/commit/d30d96138047bf455f67176e6e71c11ca6c684df))
* **pricing:** keep an older pricing cache usable offline ([6829217](https://github.com/ayagmar/llm-usage-metrics/commit/6829217364d534df5204c6e0bd94ead031b83f40))

## [0.10.1](https://github.com/ayagmar/llm-usage-metrics/compare/v0.10.0...v0.10.1) (2026-10-09)

### Features

* **report:** add --last N and --no-cost to daily, weekly and monthly ([94c5bd7](https://github.com/ayagmar/llm-usage-metrics/commit/94c5bd7624a8004c09172fdce23a0b6b368f66a7))
* **statusline:** show the Claude Code session's cost and context use ([16b1420](https://github.com/ayagmar/llm-usage-metrics/commit/16b1420e303cb627e3451f6a91a31701055c4adb))

### Bug Fixes

* **antigravity:** keep the source for Claude model and provider filters ([dac2af4](https://github.com/ayagmar/llm-usage-metrics/commit/dac2af44a985934f5637a697670bafefd0ede2e1))
* **gemini:** count a project once when a symlinked alias points to it ([d1d5ffa](https://github.com/ayagmar/llm-usage-metrics/commit/d1d5ffad6b86536ce5a89c6975fa5a496cb7bfca))
* **history:** count repeated live events once when classifying departed files ([0011e1d](https://github.com/ayagmar/llm-usage-metrics/commit/0011e1db4dc5ad6fe2be747310c07ee19e143b86))
* **history:** decide export trimming on the events it sends ([0fa3bae](https://github.com/ayagmar/llm-usage-metrics/commit/0fa3bae141ee639158f1b1a5b9bb35b0229cdfbc))
* **history:** let a file that failed to parse not hide a departed copy ([724c37a](https://github.com/ayagmar/llm-usage-metrics/commit/724c37ae1c8b793f92a0ba5287c08552535f0bc5))
* **history:** serve a partly overlapping departed file without counted events ([7503ee7](https://github.com/ayagmar/llm-usage-metrics/commit/7503ee726165dae401a5016f45f457e782d6f7a9))
* **machine:** never take over a config lock automatically ([2015a6b](https://github.com/ayagmar/llm-usage-metrics/commit/2015a6b3a31cf2a98571c6b29cb62cec055f5033))
* **machine:** serialize config edits so concurrent runs keep each change ([54f9f37](https://github.com/ayagmar/llm-usage-metrics/commit/54f9f3747543b6d3f0bfc7c87a423fb6d6500920))
* **pi:** count a deleted parent's usage once when its fork replays it ([c07c37d](https://github.com/ayagmar/llm-usage-metrics/commit/c07c37d2a2cdaf8f8d9ec3feaed2091277c78445))
* **pi:** count an entry that sibling forks both copy once ([0c81309](https://github.com/ayagmar/llm-usage-metrics/commit/0c81309ec2be58e7ba3493672ef1f0a42cfbfb69))
* **pi:** keep copies under the fork id when the parent name gives no id ([d42eaa2](https://github.com/ayagmar/llm-usage-metrics/commit/d42eaa2bcd766b58ddde4bd42fb68aaae009e96a))
* **prune:** check again that a file is gone before deleting it ([1471d96](https://github.com/ayagmar/llm-usage-metrics/commit/1471d96e760835bea2b9630e8916d18828aabd81))
* **prune:** choose files to delete under the write lock ([a8dd8c6](https://github.com/ayagmar/llm-usage-metrics/commit/a8dd8c6917204aff952e0ae9147b35e4fc484f9e))
* **prune:** let only live files with current stored events suppress a copy ([c25701b](https://github.com/ayagmar/llm-usage-metrics/commit/c25701b1e71a8d48a409b9a23f797952834c305d))
* **prune:** recheck live files under the write lock with a read-only lookup ([937a360](https://github.com/ayagmar/llm-usage-metrics/commit/937a360c9b5ffeaafe1eb3604979096759a10b6b))
* **report:** end the --last window today ([a53db1a](https://github.com/ayagmar/llm-usage-metrics/commit/a53db1a852cbc9ebe7bb91c1ea4c44cae106fd5d))
* **sources:** fail transcripts of the wrong shape and reparse cached failures ([32362e2](https://github.com/ayagmar/llm-usage-metrics/commit/32362e2559fff65425782bbebfae4a6d9744bdca))
* **sources:** keep stored events when a whole transcript cannot be read ([03239ae](https://github.com/ayagmar/llm-usage-metrics/commit/03239aec1793f3117de5c7864591b4881cfba63e))

## [0.10.0](https://github.com/ayagmar/llm-usage-metrics/compare/v0.9.0...v0.10.0) (2026-10-08)

### Features

* **doctor:** show each configured machine ([ea27402](https://github.com/ayagmar/llm-usage-metrics/commit/ea2740239333820ee87997d319f17203b53e6ddb))
* **machine:** add a versioned machine export bundle ([b79d901](https://github.com/ayagmar/llm-usage-metrics/commit/b79d9018492d92d80d9b48416b45d3680593a3d3))
* **machine:** add machine add, list, remove and sync ([65281b8](https://github.com/ayagmar/llm-usage-metrics/commit/65281b8fca8e2dfbd81dfa9855023b85e803e4a0))
* **machine:** default the ssh destination to the machine name ([af07ecf](https://github.com/ayagmar/llm-usage-metrics/commit/af07ecf0c4aa546d1448fa0c6335da5193be6fc0))
* **machine:** find llm-usage through the login shell on machine add ([a20f574](https://github.com/ayagmar/llm-usage-metrics/commit/a20f57449296771b990da2ccbdd28fd40860d6ce))
* **machine:** include other machines' usage in reports ([fb13a3d](https://github.com/ayagmar/llm-usage-metrics/commit/fb13a3de322d3d1426469924c0e337a51a79d42b))
* **machine:** refresh other machines while reports parse ([ffcd00a](https://github.com/ayagmar/llm-usage-metrics/commit/ffcd00aa09fbbe4e371af5a1382c0dfe3e88cdec))
* **machine:** split usage rows by machine with --by-machine ([2eac39c](https://github.com/ayagmar/llm-usage-metrics/commit/2eac39ce4594ce9619d2da2281dbd869055a9485))
* support running the CLI on Bun ([4e4b63e](https://github.com/ayagmar/llm-usage-metrics/commit/4e4b63ed4a433bdf108977f931c2adf807311ae3))

### Bug Fixes

* **doctor:** read machine status without locking the cache ([a865582](https://github.com/ayagmar/llm-usage-metrics/commit/a865582e904f54b6d382d58a7a55c164e9a56860))
* fail instead of hanging when a configured directory is under /proc ([0e7d7c6](https://github.com/ayagmar/llm-usage-metrics/commit/0e7d7c63d0d8ae996199b40c9f5895cff23e4fb5))
* **machine:** address review of --by-machine ([cda5a16](https://github.com/ayagmar/llm-usage-metrics/commit/cda5a16b35013f31f30344e327508a127b85b0ad))
* **machine:** address review of machine reports ([cb65c0f](https://github.com/ayagmar/llm-usage-metrics/commit/cb65c0fbe7b931555c9d4b90127f0608716ec8e4))
* **machine:** address review of machine sync ([b504141](https://github.com/ayagmar/llm-usage-metrics/commit/b504141278b899355429a39bc01b85156f7864fd))
* **machine:** address review of report refresh ([185e6df](https://github.com/ayagmar/llm-usage-metrics/commit/185e6dfc83df87c0ff5391042cd0b32f0cc7688a))
* **machine:** do not record a stopped refresh as a failed sync ([8cf3500](https://github.com/ayagmar/llm-usage-metrics/commit/8cf35009c43009013ad0937822426488950546ca))
* **machine:** export only parsed files, with revisions from their events ([c3bc3de](https://github.com/ayagmar/llm-usage-metrics/commit/c3bc3de26975a069099fa2f310a13c7ba818545e))
* **machine:** never start ssh for a refresh stopped before it began ([d7cb6c5](https://github.com/ayagmar/llm-usage-metrics/commit/d7cb6c5b43de5f1948f6fd4967af59e7c9fb3c65))
* **machine:** put node's real directory on PATH for login-shell installs ([9d11a6f](https://github.com/ayagmar/llm-usage-metrics/commit/9d11a6f77358ecb90b52845afea7a40782cd2f9c))
* walk directory paths as given and refuse non-regular files at user paths ([3274e90](https://github.com/ayagmar/llm-usage-metrics/commit/3274e902f1adcfdc5c58b24c17d840feb771174a))

### Performance Improvements

* cache compiled code between runs with a small bin loader ([effc4ca](https://github.com/ayagmar/llm-usage-metrics/commit/effc4ca61b2771e0904f72371a62dc98ee7028b3))
* cap the timestamp memo so long-lived processes stay bounded ([5bb4c6d](https://github.com/ayagmar/llm-usage-metrics/commit/5bb4c6d115e76bb99ca04f57bd75d56197dc4f41))
* memoize local dates per event timestamp ([9e2ae06](https://github.com/ayagmar/llm-usage-metrics/commit/9e2ae0641ea3b2ede61d8e70d348b323fc6ee603))

## [0.9.0](https://github.com/ayagmar/llm-usage-metrics/compare/v0.8.1...v0.9.0) (2026-10-08)

### ⚠ BREAKING CHANGES

* **cli:** `llm-usage daily` (including --json and --markdown) without
  --since or --until now reports only the last 7 days. Pass --all for the full
  history. A bare `llm-usage` runs the summary instead of printing help.
* **cli:** `llm-usage weekly` (including --json) without dates now
  reports only the last 8 weeks. Pass --all or --since to keep full history.
* **cli:** reports include usage from departed files by default; pass --no-history for the previous behavior.
* **cache:** the default event store path moves from the cache to the data directory.

### Features

* **cache:** keep the event ledger in the data directory ([d13e754](https://github.com/ayagmar/llm-usage-metrics/commit/d13e754dbf200b6e4f8707cac1f78119678675ce))
* **cli:** add an llm-usage-metrics command alias ([16fe2c1](https://github.com/ayagmar/llm-usage-metrics/commit/16fe2c1583fe92e002934af8618b53985a4e1635))
* **cli:** add shell completions and an examples block to each command's help ([3b9f4db](https://github.com/ayagmar/llm-usage-metrics/commit/3b9f4db67417c9d357dca24196097eb98acab30d))
* **cli:** fit usage tables to the terminal width and add --compact ([6c2a922](https://github.com/ayagmar/llm-usage-metrics/commit/6c2a92203437a848716dd51cfa741a55cb762b33))
* **cli:** group source-path flags under --help-all, fix root option errors, add --share --no-open ([55763a4](https://github.com/ayagmar/llm-usage-metrics/commit/55763a4a9ba2e9eee0c93b461acf036d9c73423f))
* **cli:** include retained history in reports by default ([b3963e1](https://github.com/ayagmar/llm-usage-metrics/commit/b3963e10ca0d91c6b3dde38caa7f1721c668dc29))
* **cli:** print one stderr summary line and add --verbose ([d515f8d](https://github.com/ayagmar/llm-usage-metrics/commit/d515f8dd1dba34967249612e473892403d9ace81))
* **cli:** show each source's state and searched paths in doctor ([9ea6595](https://github.com/ayagmar/llm-usage-metrics/commit/9ea659559c451cbf1839f2845d8778fc2ee8ce12))
* **cli:** summarize recent usage by default and window daily to 7 days ([f23f1d1](https://github.com/ayagmar/llm-usage-metrics/commit/f23f1d189c2c46cbf3ac719c1b09ebea7aac8124))
* **cli:** warn when a source, provider, or model filter matches nothing ([daf9d0f](https://github.com/ayagmar/llm-usage-metrics/commit/daf9d0f46ac193028bb53b66406a3959aada69bb))
* **cli:** window weekly reports to the last 8 weeks by default ([a11435c](https://github.com/ayagmar/llm-usage-metrics/commit/a11435c5ac5037dafa5763f950a029c62707d464))
* **share:** redesign share cards with light and dark themes and a PNG export page ([0f191da](https://github.com/ayagmar/llm-usage-metrics/commit/0f191da1fc3b61a1603e1386d821c234d9388efc))
* **site:** refresh landing page and documentation UX ([a11ddf5](https://github.com/ayagmar/llm-usage-metrics/commit/a11ddf5ad95cee577db3b422f330169828d69f8e))
* **source:** read CLAUDE_CONFIG_DIR and CODEX_HOME, and scan several directories per source ([2b1820c](https://github.com/ayagmar/llm-usage-metrics/commit/2b1820c9b011d5c8231c4e307ac0fb01dfb59542))
* **statusline:** print today's cost, streak, and month to date in one line ([af30a21](https://github.com/ayagmar/llm-usage-metrics/commit/af30a2184fec9feeafda3cab7a0b6a63cebaa160))
* **summary:** add streaks, best day, and a past-year activity heatmap ([9ad3696](https://github.com/ayagmar/llm-usage-metrics/commit/9ad3696945fd4978cf6d42de801406975894fe84))
* **summary:** project month-end cost against an optional budget and show cache savings ([cb6c152](https://github.com/ayagmar/llm-usage-metrics/commit/cb6c1528f9687246f29274fb66f96f13074c62c5))
* support Node.js 22.16 and test on macOS and Windows ([b8c3560](https://github.com/ayagmar/llm-usage-metrics/commit/b8c3560229b2eb5b9f9f12d31f37ce6038bc4409))

### Bug Fixes

* **cache:** copy the legacy ledger instead of deleting it, and let prune find it ([3529877](https://github.com/ayagmar/llm-usage-metrics/commit/352987711bc8c29e862b6b9f84a113ec0ad4a8c9))
* **cache:** create a fresh event store schema under a write lock ([8ffe243](https://github.com/ayagmar/llm-usage-metrics/commit/8ffe24389f0183e6f693466062d9a6bb93a198b6))
* **cache:** include parser version in event-store fingerprints ([2448382](https://github.com/ayagmar/llm-usage-metrics/commit/244838200138db66f943003ebc3183ca8a34d1d5))
* **cache:** mark a legacy copy that a stopped run left unmarked ([eedf641](https://github.com/ayagmar/llm-usage-metrics/commit/eedf641de94487e6494b70cdb6e52142cf885eb3))
* **cache:** never re-import the legacy ledger after a reset ([1ecc690](https://github.com/ayagmar/llm-usage-metrics/commit/1ecc690a788b593ec83cd0404026b9e048d37455))
* **cache:** re-parse stored events after the sanitation and DSH frame-cap changes ([d2078dd](https://github.com/ayagmar/llm-usage-metrics/commit/d2078dd9749808569818a575ed169898265b0ad7))
* **cache:** stop keying SQLite sources on the -shm sidecar ([9c0a823](https://github.com/ayagmar/llm-usage-metrics/commit/9c0a823b7945b8ea37c8f25298858accce0351d9))
* **cache:** write the pricing and update caches atomically ([907c730](https://github.com/ayagmar/llm-usage-metrics/commit/907c730db9402aae6ad7a35d651e99f5ca49211e))
* **cli:** address review findings on paths, doctor, filters, and help ([9abda34](https://github.com/ayagmar/llm-usage-metrics/commit/9abda34eb4090c98d1c34c5ce38f23c335399b5e))
* **cli:** exit quietly when stdout is closed early ([120e11a](https://github.com/ayagmar/llm-usage-metrics/commit/120e11aa142dd2fefa6ff9dafdeb79db0ea76b13))
* **cli:** fail --history when the store cannot open and accept v2 stores in doctor ([ff40c63](https://github.com/ayagmar/llm-usage-metrics/commit/ff40c6355f12ee3e17bec05f4d60042bedc70eec))
* **cli:** keep the command's exit code when stdout closes early ([66b44d6](https://github.com/ayagmar/llm-usage-metrics/commit/66b44d6d2e245fdccdaca86a98b9b362be950e2b))
* **cli:** make printed report schemas compile offline and in strict mode ([8f9df3b](https://github.com/ayagmar/llm-usage-metrics/commit/8f9df3b130af132aab9679c4f1eaf847a4a882b5))
* **cli:** name config sources, not --source, in unknown-source errors ([490c0ee](https://github.com/ayagmar/llm-usage-metrics/commit/490c0ee261d9071491d1734a7d27818177d0a947))
* **cli:** treat config source dirs as defaults, not explicit requests ([da47cee](https://github.com/ayagmar/llm-usage-metrics/commit/da47cee00a1c4cf860752e3386215d1ef0c94479))
* **compare:** compare month to date against the same days of last month ([ebae517](https://github.com/ayagmar/llm-usage-metrics/commit/ebae5175ef6dd131528a8ce75dee3b5845f3051e))
* **completion:** complete subcommand options in fish, --flag=value in bash, and leading options in zsh ([06f2f7c](https://github.com/ayagmar/llm-usage-metrics/commit/06f2f7cdb123edebc6ada35180893aeb72e71ba5)), references [#compdef](https://github.com/ayagmar/llm-usage-metrics/issues/compdef)
* **completion:** keep spaced paths whole in bash, install fish completions per bin name, add config subcommand examples ([ab43916](https://github.com/ayagmar/llm-usage-metrics/commit/ab439169fdcbc1406f076c3317e4ff483b581345))
* **config:** quote the default event store path in the config template ([600191c](https://github.com/ayagmar/llm-usage-metrics/commit/600191ca7627d2ca0d9d10b94a8e624ae8129d52))
* **config:** warn about wrong-type values and resolve config paths like a user expects ([de18f18](https://github.com/ayagmar/llm-usage-metrics/commit/de18f183f821019434caaa5451647adbd2d1f39a))
* **discovery:** skip looping and unresolvable symlinks ([4c366ba](https://github.com/ayagmar/llm-usage-metrics/commit/4c366baf5206dc4f0c5a5d50a1a05d2ad84a28ea))
* **efficiency:** stop adding reasoning to output in Tokens/Commit ([9899e3f](https://github.com/ayagmar/llm-usage-metrics/commit/9899e3fdd13a9cae76102327ddbf32cb45f0eaeb))
* exclude Node.js 23 from the supported range ([b68cab7](https://github.com/ayagmar/llm-usage-metrics/commit/b68cab7adeb2b3c790c7296657113f65b6cb540e))
* **history:** keep uncounted on-disk files out of move suppression ([cbba5ac](https://github.com/ayagmar/llm-usage-metrics/commit/cbba5ac1c8d59aa73627130742f1a486531b2f7e))
* **history:** only treat stored files missing from disk as departed ([95152cd](https://github.com/ayagmar/llm-usage-metrics/commit/95152cd26bb1ef74ae4fa08de868cb05d91b97c8))
* **history:** serve unverifiable stored files as history but never prune them ([ef8cd21](https://github.com/ayagmar/llm-usage-metrics/commit/ef8cd211d629de9269c8f7f31aa58aa8d67405e9))
* **optimize:** price cache writes as input for candidates without a write rate ([79f5a02](https://github.com/ayagmar/llm-usage-metrics/commit/79f5a02750cbd75d8fe995debf0522bb4168d1cf))
* **pricing:** bill separately rated reasoning tokens once ([99a4f7c](https://github.com/ayagmar/llm-usage-metrics/commit/99a4f7c79b373b39b53300153c2e2b761ebaede0))
* **pricing:** bridge reasoning-effort suffixes in prefix matching ([0181195](https://github.com/ayagmar/llm-usage-metrics/commit/0181195cb97cf162b872724afdf92e45244a2f0d))
* **pricing:** check release suffixes without a backtracking regex ([b462e4a](https://github.com/ayagmar/llm-usage-metrics/commit/b462e4a7c7f56fb3add12840d827a9935e4a2406))
* **pricing:** fail on malformed pricing overrides instead of dropping them ([ccd373a](https://github.com/ayagmar/llm-usage-metrics/commit/ccd373ab816dc69346d61b5bb6eb38cf123768a2))
* **pricing:** keep retired LiteLLM models priced and repair a dead preferred key ([2d16d64](https://github.com/ayagmar/llm-usage-metrics/commit/2d16d64fc65ecbb6682ba15dc6c83d2edffaf29c))
* **pricing:** prefer first-party pricing keys and stop bridging model variants ([28aeca6](https://github.com/ayagmar/llm-usage-metrics/commit/28aeca6f96de636b27b7b3085ddcbe07ffeaf4a6))
* **pricing:** price effort-suffixed models as their base model before reseller keys ([c8266ac](https://github.com/ayagmar/llm-usage-metrics/commit/c8266ac97e14e4055f76c8f3753fff3628f540b3))
* **pricing:** warn with the cache date when stale cached pricing is used ([b2f32d2](https://github.com/ayagmar/llm-usage-metrics/commit/b2f32d21a41ed50f27ff97a4ddbd8518c7639ad8))
* **render:** close terminal sanitation gaps in untrusted text ([b2a592c](https://github.com/ayagmar/llm-usage-metrics/commit/b2a592c8e21185c432bc805466416e4789b2cb4a))
* replace quadratic regexes flagged by a ReDoS checker ([2c24a29](https://github.com/ayagmar/llm-usage-metrics/commit/2c24a2948ee0d0c5f8570767e62817bfc63a7e1c))
* **scripts:** keep the dist smoke run out of the user's ledger and caches ([d966878](https://github.com/ayagmar/llm-usage-metrics/commit/d966878ae09f3950b1e66735c7fae9d24bd71b8c))
* **share:** always label the last period on usage cards ([f6dcc5a](https://github.com/ayagmar/llm-usage-metrics/commit/f6dcc5a5ad4c05d9831dbcbec2efb69e58354f2b))
* **share:** keep empty periods, guard XML-forbidden characters, and tidy share wording ([8503014](https://github.com/ayagmar/llm-usage-metrics/commit/850301467b6e528906ace30e42e032b02f139c0a))
* **share:** name and render the PNG for the theme chosen at click time ([fad81ef](https://github.com/ayagmar/llm-usage-metrics/commit/fad81ef6767d6c6f561e4663f3b26574d4dd80b2))
* **source:** count goose reasoning inside output and key its cache on SQLite sidecars ([b658c27](https://github.com/ayagmar/llm-usage-metrics/commit/b658c278c49f10fa6a578d6c983d9d55b678f4bb))
* **source:** count OpenCode reasoning inside output tokens ([f7f8acb](https://github.com/ayagmar/llm-usage-metrics/commit/f7f8acba71098d6adc007e4dcabf1a95eb0b3e3a)), references [#21047](https://github.com/ayagmar/llm-usage-metrics/issues/21047)
* **source:** fall back to the model family for qwen rows without a total ([072f54c](https://github.com/ayagmar/llm-usage-metrics/commit/072f54c9905debb88d652eb8501bb8b9329d3798))
* **source:** only skip fork copies when discovery covers the parent ([61f7cbc](https://github.com/ayagmar/llm-usage-metrics/commit/61f7cbc1eb47fc52e9504c328ef84da5be3b6ed8))
* **source:** parse current antigravity blobs and correct their token mapping ([08b7220](https://github.com/ayagmar/llm-usage-metrics/commit/08b7220e61fc54843298652aba62535a9542730a))
* **source:** read every OpenCode channel database, not just the first ([7e38755](https://github.com/ayagmar/llm-usage-metrics/commit/7e38755d9dc56de043bd0ae8eca58eec7cb5b86d))
* **source:** read the real Gemini CLI projects.json layout for repoRoot ([107cf4a](https://github.com/ayagmar/llm-usage-metrics/commit/107cf4a42c767cc8d6250b1cbe5b73839d34406b))
* **source:** recover the Codex auto-compaction response from token_usage_record rows ([f91c140](https://github.com/ayagmar/llm-usage-metrics/commit/f91c14020d076f0e35ec500c5bb9ee86d7d66bb0))
* **source:** rediscover files on every call in MultiDirectorySourceAdapter ([9e8f141](https://github.com/ayagmar/llm-usage-metrics/commit/9e8f1415fab73a264a051087ea100e4b63cd0f20))
* **source:** report Claude thinking tokens in the reasoning breakdown ([aa484b0](https://github.com/ayagmar/llm-usage-metrics/commit/aa484b0347704cd13118087a6942854fc062307a))
* **source:** skip parent entries copied into forked pi sessions ([fca5891](https://github.com/ayagmar/llm-usage-metrics/commit/fca58914f5e986cfc4260d915ffb8f2c41beff97))
* **source:** skip parent rows replayed into forked claude subagents ([e2e8761](https://github.com/ayagmar/llm-usage-metrics/commit/e2e876150850de51bd3ff8c9dc7b844555b4686c))
* **source:** skip pi fork copies only while the parent session exists ([3be4e89](https://github.com/ayagmar/llm-usage-metrics/commit/3be4e895749d1a32700a28b814e67caf1c997e69))
* **source:** split cache tokens out of Roo Code and Kilo Code input counts ([88c692c](https://github.com/ayagmar/llm-usage-metrics/commit/88c692c7a5066c27b55f65e8229a7e2130de8c7d)), references [#8954](https://github.com/ayagmar/llm-usage-metrics/issues/8954)
* **source:** stop counting reasoning twice in pi, qwen, copilot, dsh, and openclaw totals ([1d47624](https://github.com/ayagmar/llm-usage-metrics/commit/1d47624c3a316cc9aea51ed94e47fa4374dd0511))
* **source:** stop dating timestamp-less OpenClaw rows by file mtime ([cb49f8c](https://github.com/ayagmar/llm-usage-metrics/commit/cb49f8cb1c5b4a0fa66d93c8f8ef5371d9267c31))
* **source:** stop double-counting cached input for gemini, qwen and openclaw ([013bffb](https://github.com/ayagmar/llm-usage-metrics/commit/013bffb30b7ab91f112e6aa33a8cf17bfcba531b))
* state the Node.js 22.16 minimum in the SQLite docs and loader error ([a126e2e](https://github.com/ayagmar/llm-usage-metrics/commit/a126e2e5c443bdd464402e6e68e93f038f9cc4a9))
* **statusline:** keep warnings with --verbose and document pricing URL, filter, and slow-refresh cases ([4cd0778](https://github.com/ayagmar/llm-usage-metrics/commit/4cd07787813f8f9c9bba5afc5d9ebe87b87c08db))
* **statusline:** leave the budget out when the month's cost is unknown ([a746321](https://github.com/ayagmar/llm-usage-metrics/commit/a746321974155f0e8ff40bb1c04af59bab943b96))
* **statusline:** print the run diagnostics with --verbose ([f89c2cf](https://github.com/ayagmar/llm-usage-metrics/commit/f89c2cf414afa13e2480c9415bca78ae98b879c4))
* **summary:** keep activity optional in the v1 schema and fit the heatmap legend ([c387278](https://github.com/ayagmar/llm-usage-metrics/commit/c3872782b782577fdeaceed4e5c60f6494a45156))
* **summary:** scope the budget to unfiltered runs and stay quiet for an empty month ([c4c75b2](https://github.com/ayagmar/llm-usage-metrics/commit/c4c75b289e4e461bf5b60adb8ad47d8ed17b4249))

### Performance Improvements

* **cache:** bound event-store write batches ([00393af](https://github.com/ayagmar/llm-usage-metrics/commit/00393affb70db6d7bacb0247c2e128e6fa8cd507))
* **cache:** stop fsyncing the event store once per parsed file ([10b14a4](https://github.com/ayagmar/llm-usage-metrics/commit/10b14a47d2b0313f0ec1cc4f5f657a0416ee010d))
* **cli:** skip files last modified before the --since window ([57c521b](https://github.com/ayagmar/llm-usage-metrics/commit/57c521bf22ce73f621ae16d625e76735d3f0594b))
* **source:** read only pi session headers and share claude parent keys ([3dd76e8](https://github.com/ayagmar/llm-usage-metrics/commit/3dd76e85b41a66e91121f8d64059aab794a3c146))
* **source:** stream DSH session logs instead of materialising them ([9d04e13](https://github.com/ayagmar/llm-usage-metrics/commit/9d04e13e692d0e208bb1d2e890a18d77f84ab8e5))

## [0.8.1](https://github.com/ayagmar/llm-usage-metrics/compare/v0.8.0...v0.8.1) (2026-10-04)

### Features

* **site:** add export card to the landing report grid ([92674f8](https://github.com/ayagmar/llm-usage-metrics/commit/92674f89f9af3fc078ec5fe51fd212b447812f97))
* **source:** add dsh adapter for DeepSeek Harness sessions ([2739a04](https://github.com/ayagmar/llm-usage-metrics/commit/2739a04de2d15ba63b70cbfeeb648f00166b0c17))

### Bug Fixes

* **benchmark:** compare direct application runtimes fairly ([937a39f](https://github.com/ayagmar/llm-usage-metrics/commit/937a39f0d9a1d7d10f91604fde1b15fc95b175de))
* **dsh:** await complete decompression before returning frames ([b3a3479](https://github.com/ayagmar/llm-usage-metrics/commit/b3a3479f4c74887d39ba408b0b48554aeaa1b0c7))
* **pricing:** stop billing deepseek-flash as deepseek-v4-flash ([3faea42](https://github.com/ayagmar/llm-usage-metrics/commit/3faea429c04e8d96f4f1cf0ac7b2cb3330da9968))

### Performance Improvements

* **cli:** schedule largest Codex misses first ([51500e2](https://github.com/ayagmar/llm-usage-metrics/commit/51500e2c4db1fd160fb50ef250c667dcd9880757))
* **history:** drive event joins from temp tables ([3efa475](https://github.com/ayagmar/llm-usage-metrics/commit/3efa475c87bbf87d45f05b4d6c83f52c2e6286a7))
* **persistence:** read stored events as positional rows ([4b25556](https://github.com/ayagmar/llm-usage-metrics/commit/4b255563192995bf87251f69576218bf483f4ef9))

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

## [0.3.0](https://github.com/ayagmar/llm-usage-metrics/compare/v0.2.1...v0.3.0) (2026-02-23)

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

## [0.2.1](https://github.com/ayagmar/llm-usage-metrics/compare/v0.2.0...v0.2.1) (2026-02-22)

### Bug Fixes

* **cli:** restore local pnpm source execution ([6482500](https://github.com/ayagmar/llm-usage-metrics/commit/64825000dd11baa1efabea70c49f3312d591a7f1))
* **lint:** enforce safe assertions in runtime code ([12900ff](https://github.com/ayagmar/llm-usage-metrics/commit/12900ff6d30a0f6d247b12102e5ab21830db0a90))
* **parsing:** close cache bugs and raise test coverage ([9f644f9](https://github.com/ayagmar/llm-usage-metrics/commit/9f644f9422f7dece9bf120b2045673a32e93ccbe))
* **parsing:** harden and simplify parse cache loading ([b4c621c](https://github.com/ayagmar/llm-usage-metrics/commit/b4c621cdc30b98c354900fdf9c7bda405c744871))
* **parsing:** improve cache resilience and trim payload ([2275d18](https://github.com/ayagmar/llm-usage-metrics/commit/2275d18afb841c850819556967173300eb7cc594))
* **parsing:** keep precise mtimes and optimize cache trimming ([443f4b6](https://github.com/ayagmar/llm-usage-metrics/commit/443f4b66388d00dcd4fed25cf93ee35d6b12afa8))

### Performance Improvements

* **parsing:** add bounded parse cache and jsonl prefilters ([9a76986](https://github.com/ayagmar/llm-usage-metrics/commit/9a76986ce623eca3f21a2e56511e62133df586a7))

## [0.2.0](https://github.com/ayagmar/llm-usage-metrics/compare/v0.1.11...v0.2.0) (2026-02-22)

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
