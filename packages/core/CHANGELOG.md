# Changelog

## [1.2.0](https://github.com/costajohnt/oss-scout/compare/core-v1.1.0...core-v1.2.0) (2026-06-19)


### Features

* broaden contributed-repo discovery depth and age window ([#244](https://github.com/costajohnt/oss-scout/issues/244)) ([1ef851a](https://github.com/costajohnt/oss-scout/commit/1ef851a99a8e1c64eb1f7155ccd1c1354be5436b))

## [1.1.0](https://github.com/costajohnt/oss-scout/compare/core-v1.0.0...core-v1.1.0) (2026-06-12)


### Features

* **personalization:** implement avoidRepos and boostIssueTypes ([#168](https://github.com/costajohnt/oss-scout/issues/168)) ([#239](https://github.com/costajohnt/oss-scout/issues/239)) ([1f24ea8](https://github.com/costajohnt/oss-scout/commit/1f24ea8cb739025099ce992ebd5ecc8a12634678))

## [1.0.0](https://github.com/costajohnt/oss-scout/compare/core-v0.11.0...core-v1.0.0) (2026-06-11)


### ⚠ BREAKING CHANGES

* **types:** tighten exported types for the next major ([#158](https://github.com/costajohnt/oss-scout/issues/158)) (#233)

### Features

* **cli:** surface boost reasons and diversity slot in non-JSON output ([#111](https://github.com/costajohnt/oss-scout/issues/111)) ([6135693](https://github.com/costajohnt/oss-scout/commit/61356934dd5a0de7ba2e60bed054de64981d2991))
* **config:** persist personalization preferences ([#168](https://github.com/costajohnt/oss-scout/issues/168)) ([#229](https://github.com/costajohnt/oss-scout/issues/229)) ([0d6488c](https://github.com/costajohnt/oss-scout/commit/0d6488c4325c0600f14df8a9e067d62906437465))
* **core:** logger level control + ScoutStateWriter injectable + export bootstrapScout ([#218](https://github.com/costajohnt/oss-scout/issues/218)) ([fb16f83](https://github.com/costajohnt/oss-scout/commit/fb16f834469218305d2ac6bba1af3afda0906ea7))
* **results:** add --new-only / --since filtering and --markdown export ([#170](https://github.com/costajohnt/oss-scout/issues/170)) ([#225](https://github.com/costajohnt/oss-scout/issues/225)) ([1f43514](https://github.com/costajohnt/oss-scout/commit/1f435145a4704099721c3070aa261d3c665f3665))
* **scoring:** populate the hasActiveMaintainers repo signal ([#167](https://github.com/costajohnt/oss-scout/issues/167)) ([#230](https://github.com/costajohnt/oss-scout/issues/230)) ([e38b319](https://github.com/costajohnt/oss-scout/commit/e38b319403061c82e5f2159acccaca621ff8b0e8))
* sync command to reconcile tracked open PRs ([#164](https://github.com/costajohnt/oss-scout/issues/164)) ([#231](https://github.com/costajohnt/oss-scout/issues/231)) ([e56990b](https://github.com/costajohnt/oss-scout/commit/e56990b87b8b093401bfa8728d8e41253c550823))
* **vet-list:** claim-watch status deltas ([#165](https://github.com/costajohnt/oss-scout/issues/165)) ([#228](https://github.com/costajohnt/oss-scout/issues/228)) ([4e38ce0](https://github.com/costajohnt/oss-scout/commit/4e38ce0156ead6f52f1de49ab025dd4d136fcc8a))
* **vetting:** classify the user's own in-flight PR vs competition ([#166](https://github.com/costajohnt/oss-scout/issues/166)) ([#227](https://github.com/costajohnt/oss-scout/issues/227)) ([1584819](https://github.com/costajohnt/oss-scout/commit/15848191ccb31bc055b5ad836d026f245ee27975))


### Bug Fixes

* **cli,mcp:** validate issue URLs on skip add ([#182](https://github.com/costajohnt/oss-scout/issues/182)) ([7f7b3e8](https://github.com/costajohnt/oss-scout/commit/7f7b3e881de26c465ebf5ecd5cb2322e86d0b249)), closes [#134](https://github.com/costajohnt/oss-scout/issues/134)
* **cli:** document the -- escape for dash-prefixed config values ([#200](https://github.com/costajohnt/oss-scout/issues/200)) ([55728e6](https://github.com/costajohnt/oss-scout/commit/55728e6dd622f16f216cc641ae3082724f0b1fcb)), closes [#132](https://github.com/costajohnt/oss-scout/issues/132)
* **cli:** honor the gist persistence preference in commands ([#213](https://github.com/costajohnt/oss-scout/issues/213)) ([fd3b22b](https://github.com/costajohnt/oss-scout/commit/fd3b22b3045ca22e9838794fc4b78ed74070d9ce)), closes [#115](https://github.com/costajohnt/oss-scout/issues/115)
* **cli:** honor the JSON contract for hints, validation, and setup ([#199](https://github.com/costajohnt/oss-scout/issues/199)) ([8a8ec5e](https://github.com/costajohnt/oss-scout/commit/8a8ec5eddaf68220b550ab91b2fa9fdfc3f56582)), closes [#131](https://github.com/costajohnt/oss-scout/issues/131)
* **cli:** let the defaultStrategy preference take effect ([#181](https://github.com/costajohnt/oss-scout/issues/181)) ([34e0c69](https://github.com/costajohnt/oss-scout/commit/34e0c6903ec3e4ffdf68cc5d98c99e35bb5e37be)), closes [#133](https://github.com/costajohnt/oss-scout/issues/133)
* **core:** bound the CONTRIBUTING-parse regexes against attacker-controlled input ([#205](https://github.com/costajohnt/oss-scout/issues/205)) ([766b5dc](https://github.com/costajohnt/oss-scout/commit/766b5dcabb09c11a71fe159547e12c028d5e3900)), closes [#152](https://github.com/costajohnt/oss-scout/issues/152)
* **core:** classify abuse-detection 403s as rate-limit errors everywhere ([#191](https://github.com/costajohnt/oss-scout/issues/191)) ([4d45f2d](https://github.com/costajohnt/oss-scout/commit/4d45f2d7ab88add30e7d2d0a62fd315ea34434f0)), closes [#138](https://github.com/costajohnt/oss-scout/issues/138)
* **core:** clause-based claim detection instead of substring matching ([#183](https://github.com/costajohnt/oss-scout/issues/183)) ([aabe029](https://github.com/costajohnt/oss-scout/commit/aabe029696b63fc39415f01a3dffb03931a11b27)), closes [#126](https://github.com/costajohnt/oss-scout/issues/126)
* **core:** dedup input URLs in parallel vetting ([#190](https://github.com/costajohnt/oss-scout/issues/190)) ([69334d2](https://github.com/costajohnt/oss-scout/commit/69334d259c03a889fa8436cb272adc025df55f5d)), closes [#129](https://github.com/costajohnt/oss-scout/issues/129)
* **core:** default createScout to local persistence instead of throwaway state ([#210](https://github.com/costajohnt/oss-scout/issues/210)) ([2b23b12](https://github.com/costajohnt/oss-scout/commit/2b23b12383a31ee1810ce4ea077ad3f2d92c32c6)), closes [#116](https://github.com/costajohnt/oss-scout/issues/116)
* **core:** detect closed issues during vetting ([#196](https://github.com/costajohnt/oss-scout/issues/196)) ([d3954d2](https://github.com/costajohnt/oss-scout/commit/d3954d28e1168a980d4f4c87a72e91975db84255)), closes [#120](https://github.com/costajohnt/oss-scout/issues/120)
* **core:** detect truncated gist scans and warn before creating a possible duplicate ([#186](https://github.com/costajohnt/oss-scout/issues/186)) ([539ee4c](https://github.com/costajohnt/oss-scout/commit/539ee4c5195cafab541a6ce10c689edb139bb9a7)), closes [#141](https://github.com/costajohnt/oss-scout/issues/141)
* **core:** evict stale http-cache entries on every cache-burning entry point ([#178](https://github.com/costajohnt/oss-scout/issues/178)) ([622189f](https://github.com/costajohnt/oss-scout/commit/622189f6becc0199d68c3527633e5a9d93208fcc))
* **core:** fetch only the newest comment pages in claim detection ([#187](https://github.com/costajohnt/oss-scout/issues/187)) ([d63736d](https://github.com/costajohnt/oss-scout/commit/d63736d3c0b8c2409aef67855358be5d1cd3eda3)), closes [#127](https://github.com/costajohnt/oss-scout/issues/127)
* **core:** in-flight dedup for per-repo lookups during parallel vetting ([#198](https://github.com/costajohnt/oss-scout/issues/198)) ([2739a32](https://github.com/costajohnt/oss-scout/commit/2739a32acc61c44ecc544103ae6f63cb375c5b04)), closes [#124](https://github.com/costajohnt/oss-scout/issues/124)
* **core:** make the broad-phase skip threshold satisfiable ([#180](https://github.com/costajohnt/oss-scout/issues/180)) ([4d09550](https://github.com/costajohnt/oss-scout/commit/4d0955013d9df070f4e2f1b2276b0ac079ace874)), closes [#123](https://github.com/costajohnt/oss-scout/issues/123)
* **core:** never cache vetting results built on inconclusive checks ([#188](https://github.com/costajohnt/oss-scout/issues/188)) ([f26e76d](https://github.com/costajohnt/oss-scout/commit/f26e76d7ee8f1990d53ba5c2532944e0f454f850)), closes [#122](https://github.com/costajohnt/oss-scout/issues/122)
* **core:** parse GitHub URLs with the URL class instead of unanchored regexes ([#185](https://github.com/costajohnt/oss-scout/issues/185)) ([bc4fa75](https://github.com/costajohnt/oss-scout/commit/bc4fa750c51583c1a41951506cf624f9430fc549)), closes [#135](https://github.com/costajohnt/oss-scout/issues/135)
* **core:** per-label queries restore any-of semantics in starred search ([#194](https://github.com/costajohnt/oss-scout/issues/194)) ([2f2255c](https://github.com/costajohnt/oss-scout/commit/2f2255ce557fecb175235049cd28462380c11b46)), closes [#118](https://github.com/costajohnt/oss-scout/issues/118)
* **core:** per-language broad feature queries via the cached search path ([#197](https://github.com/costajohnt/oss-scout/issues/197)) ([f6be7af](https://github.com/costajohnt/oss-scout/commit/f6be7af117f6f8f03b7c1994e7c2d895f7d753d5)), closes [#121](https://github.com/costajohnt/oss-scout/issues/121)
* **core:** replenish the external search budget when GitHub's window resets ([#195](https://github.com/costajohnt/oss-scout/issues/195)) ([bfbce92](https://github.com/costajohnt/oss-scout/commit/bfbce928d205107dc2611ef6660b02c2b2802f89)), closes [#119](https://github.com/costajohnt/oss-scout/issues/119)
* **core:** require a word boundary for CLA detection in CONTRIBUTING parsing ([#176](https://github.com/costajohnt/oss-scout/issues/176)) ([c7bf10a](https://github.com/costajohnt/oss-scout/commit/c7bf10aca3cc5550a9c54d6365c01939327a5a32)), closes [#128](https://github.com/costajohnt/oss-scout/issues/128)
* **core:** round-trip unknown state keys and add a migration entry point ([#193](https://github.com/costajohnt/oss-scout/issues/193)) ([1c52a6e](https://github.com/costajohnt/oss-scout/commit/1c52a6ebec5be95f7aa73e636b0a713f5e76a3bf)), closes [#137](https://github.com/costajohnt/oss-scout/issues/137)
* **core:** score the real closed-without-merge count in live vetting ([#189](https://github.com/costajohnt/oss-scout/issues/189)) ([739c395](https://github.com/costajohnt/oss-scout/commit/739c395c51ef10a7547ee343a74c5970480480b9)), closes [#125](https://github.com/costajohnt/oss-scout/issues/125)
* **core:** treat cached falsy bodies as hits and recover from orphaned 304s ([#177](https://github.com/costajohnt/oss-scout/issues/177)) ([0e6c3b0](https://github.com/costajohnt/oss-scout/commit/0e6c3b09ebd9477e8565ff8a15415ce8fcc88791)), closes [#142](https://github.com/costajohnt/oss-scout/issues/142)
* **core:** trim GITHUB_TOKEN and stop logging the raw gh error object ([#179](https://github.com/costajohnt/oss-scout/issues/179)) ([408af8a](https://github.com/costajohnt/oss-scout/commit/408af8ab6f5fe8e02ebe25e9032f08a93532f021)), closes [#136](https://github.com/costajohnt/oss-scout/issues/136)
* **core:** truthful strategiesUsed and case-insensitive repo config matching ([#184](https://github.com/costajohnt/oss-scout/issues/184)) ([deec310](https://github.com/costajohnt/oss-scout/commit/deec3108111823433c8385fa1d897ffe3e89f1fa)), closes [#130](https://github.com/costajohnt/oss-scout/issues/130)
* **core:** unique tmp path for atomic state saves ([#192](https://github.com/costajohnt/oss-scout/issues/192)) ([dada081](https://github.com/costajohnt/oss-scout/commit/dada081d80603ed0ff335fbfc9774c8b90f652ce)), closes [#140](https://github.com/costajohnt/oss-scout/issues/140)
* **gist:** prevent merge data loss with tombstones and recency tracking ([#214](https://github.com/costajohnt/oss-scout/issues/214)) ([0735c99](https://github.com/costajohnt/oss-scout/commit/0735c99563edc61909d5ab5c549bad10ec14c258))
* **mcp:** stop the 60s tool timeout firing on every default search ([#206](https://github.com/costajohnt/oss-scout/issues/206)) ([63cdbc1](https://github.com/costajohnt/oss-scout/commit/63cdbc114b296741d7469ebeb3b7f6c7ed5b2e39)), closes [#143](https://github.com/costajohnt/oss-scout/issues/143)


### Performance Improvements

* **vetting:** batch issue core fetch via GraphQL with REST fallback ([#169](https://github.com/costajohnt/oss-scout/issues/169)) ([#232](https://github.com/costajohnt/oss-scout/issues/232)) ([48c30c5](https://github.com/costajohnt/oss-scout/commit/48c30c59381243a9e3454f6404ab277190cc2989))


### Code Refactoring

* **types:** tighten exported types for the next major ([#158](https://github.com/costajohnt/oss-scout/issues/158)) ([#233](https://github.com/costajohnt/oss-scout/issues/233)) ([ca940b5](https://github.com/costajohnt/oss-scout/commit/ca940b531582e8c1fb38cdb1bd46d8014e0429ee))

## [0.11.0](https://github.com/costajohnt/oss-scout/compare/core-v0.10.0...core-v0.11.0) (2026-05-18)


### Features

* **search:** add diversityRatio counterweight to avoid echo-chamber bias ([#109](https://github.com/costajohnt/oss-scout/issues/109)) ([72376fe](https://github.com/costajohnt/oss-scout/commit/72376fe52003f0d21533ca9bad4d4ddd518f71ab))

## [0.10.0](https://github.com/costajohnt/oss-scout/compare/core-v0.9.1...core-v0.10.0) (2026-05-18)


### Features

* **search:** soft-boost ranking via preferLanguages and preferRepos ([#107](https://github.com/costajohnt/oss-scout/issues/107)) ([1e938a0](https://github.com/costajohnt/oss-scout/commit/1e938a08f51820a2a37df98f28964cb044957738))

## [0.9.1](https://github.com/costajohnt/oss-scout/compare/core-v0.9.0...core-v0.9.1) (2026-05-18)


### Bug Fixes

* **search:** fan out Phase 2 per language when combined with labels ([#105](https://github.com/costajohnt/oss-scout/issues/105)) ([5193fa6](https://github.com/costajohnt/oss-scout/commit/5193fa64061b76f5cd81482e709447c807c86278))

## [0.9.0](https://github.com/costajohnt/oss-scout/compare/core-v0.8.0...core-v0.9.0) (2026-05-10)


### Features

* add scout features subcommand ([#92](https://github.com/costajohnt/oss-scout/issues/92)) ([#93](https://github.com/costajohnt/oss-scout/issues/93)) ([d873127](https://github.com/costajohnt/oss-scout/commit/d8731279414ab59bf5c8be56b59eb37767d9fa39))
* configurable anchor threshold + split ratio for scout features ([#98](https://github.com/costajohnt/oss-scout/issues/98) [#99](https://github.com/costajohnt/oss-scout/issues/99)) ([#101](https://github.com/costajohnt/oss-scout/issues/101)) ([051766a](https://github.com/costajohnt/oss-scout/commit/051766ac3ef2537b7c571fe5398ae946ddd333b5))
* scout features follow-ups — wontfix detection, roadmap scraping, broad mode ([#95](https://github.com/costajohnt/oss-scout/issues/95) [#96](https://github.com/costajohnt/oss-scout/issues/96) [#100](https://github.com/costajohnt/oss-scout/issues/100)) ([#103](https://github.com/costajohnt/oss-scout/issues/103)) ([7daddc0](https://github.com/costajohnt/oss-scout/commit/7daddc0e9bf61eea9e890ea5360be013aa06923f))
* stalled-PR annotation in scout + scout features ([#97](https://github.com/costajohnt/oss-scout/issues/97)) ([#102](https://github.com/costajohnt/oss-scout/issues/102)) ([6f243ec](https://github.com/costajohnt/oss-scout/commit/6f243ec49740fcd2bbcad157d4f386a1a41c96d9))


### Bug Fixes

* align ROADMAP scraping with intended design ([#95](https://github.com/costajohnt/oss-scout/issues/95)) ([#104](https://github.com/costajohnt/oss-scout/issues/104)) ([e5f7ece](https://github.com/costajohnt/oss-scout/commit/e5f7ece4de160a44765f79fdc66da08da132f2df))

## [0.8.0](https://github.com/costajohnt/oss-scout/compare/core-v0.7.1...core-v0.8.0) (2026-04-26)


### Features

* distinguish cause in degraded-mode bootstrap warning ([#90](https://github.com/costajohnt/oss-scout/issues/90)) ([#91](https://github.com/costajohnt/oss-scout/issues/91)) ([b40455a](https://github.com/costajohnt/oss-scout/commit/b40455a0c6f09bac7ac1e06bf8d1656847c1a1b9))


### Bug Fixes

* add 401/rate-limit propagation guards to remaining core/ catches ([#80](https://github.com/costajohnt/oss-scout/issues/80)) ([#85](https://github.com/costajohnt/oss-scout/issues/85)) ([961e235](https://github.com/costajohnt/oss-scout/commit/961e2350b9873af93c48a556846c24ef7fde4f23))
* propagate 401/rate-limit in gist-state-store ([#88](https://github.com/costajohnt/oss-scout/issues/88)) ([#89](https://github.com/costajohnt/oss-scout/issues/89)) ([cecc393](https://github.com/costajohnt/oss-scout/commit/cecc39384f31424c40e5da1e5284c029fa3bb6a7))
* propagate 401/rate-limit through vetIssuesParallel and vetList ([#79](https://github.com/costajohnt/oss-scout/issues/79)) ([#87](https://github.com/costajohnt/oss-scout/issues/87)) ([231e559](https://github.com/costajohnt/oss-scout/commit/231e559079b5ebf42706ff3d4177b99e6fdafe7e))

## [0.7.1](https://github.com/costajohnt/oss-scout/compare/core-v0.7.0...core-v0.7.1) (2026-04-26)


### Bug Fixes

* implement getSLMTriageConfig on OssScout so vetter can read prefs ([#83](https://github.com/costajohnt/oss-scout/issues/83)) ([05b8190](https://github.com/costajohnt/oss-scout/commit/05b8190a6a871ba9f3da2350fc690a89a61a1e23))

## [0.7.0](https://github.com/costajohnt/oss-scout/compare/core-v0.6.0...core-v0.7.0) (2026-04-26)


### Features

* optional SLM pre-triage pass during issue vetting ([#81](https://github.com/costajohnt/oss-scout/issues/81)) ([1c50091](https://github.com/costajohnt/oss-scout/commit/1c5009116d0539a4b17b8fe8e06afdd0c33ecb56))

## [0.6.0](https://github.com/costajohnt/oss-scout/compare/core-v0.5.0...core-v0.6.0) (2026-04-26)


### Features

* add antiLLMPolicy scan on IssueCandidate ([#70](https://github.com/costajohnt/oss-scout/issues/70)) ([#73](https://github.com/costajohnt/oss-scout/issues/73)) ([849d10f](https://github.com/costajohnt/oss-scout/commit/849d10f74d0c140b628dc41fbfd5e60a1027efb6))
* surface linked-PR metadata on IssueCandidate ([#69](https://github.com/costajohnt/oss-scout/issues/69)) ([#71](https://github.com/costajohnt/oss-scout/issues/71)) ([343f960](https://github.com/costajohnt/oss-scout/commit/343f96005f21e845291de890bd49b229dfd9b97f))


### Bug Fixes

* propagate 401/429 in eligibility + repo-health helpers ([#74](https://github.com/costajohnt/oss-scout/issues/74)) ([#76](https://github.com/costajohnt/oss-scout/issues/76)) ([43f5397](https://github.com/costajohnt/oss-scout/commit/43f53972a31b716d39c2a9c07ae09242caa9a819))

## [0.5.0](https://github.com/costajohnt/oss-scout/compare/core-v0.4.0...core-v0.5.0) (2026-04-18)

### Features

- include open-PR repos in Phase 0 search ([#65](https://github.com/costajohnt/oss-scout/issues/65)) ([#66](https://github.com/costajohnt/oss-scout/issues/66)) ([e5af4d2](https://github.com/costajohnt/oss-scout/commit/e5af4d2950bf243e6b77ba02344b4c2c4ad80045))

## [0.4.0](https://github.com/costajohnt/oss-scout/compare/core-v0.3.0...core-v0.4.0) (2026-04-01)

### Features

- add configurable inter-phase delay for rate limit management ([#59](https://github.com/costajohnt/oss-scout/issues/59)) ([7860bf9](https://github.com/costajohnt/oss-scout/commit/7860bf9115367a156cb16042503ebfca68f6f083))

### Bug Fixes

- add rate limit delay and skip logic before broad search phase ([#60](https://github.com/costajohnt/oss-scout/issues/60)) ([8bc6f7b](https://github.com/costajohnt/oss-scout/commit/8bc6f7b3a7a0c76123a425b4916bcf9357393a08))
- don't cache empty search results to prevent rate-limit poisoning ([965a635](https://github.com/costajohnt/oss-scout/commit/965a635c893261a5c95096904736e48b20f9b4e6)), closes [#56](https://github.com/costajohnt/oss-scout/issues/56)
- harden error handling in REST search functions ([#63](https://github.com/costajohnt/oss-scout/issues/63)) ([407078f](https://github.com/costajohnt/oss-scout/commit/407078fc7dfc9520332d8e6285ca35aa383e8367))
- MCP config parity, correct SKILL.md phase order, remove dead mocks ([#64](https://github.com/costajohnt/oss-scout/issues/64)) ([71fafb4](https://github.com/costajohnt/oss-scout/commit/71fafb4c96a6e7b8974495bb9e95e7dd1d695ea8))
- reorder search phases to run broad strategy first ([#58](https://github.com/costajohnt/oss-scout/issues/58)) ([9ed7963](https://github.com/costajohnt/oss-scout/commit/9ed7963419d4a7dc56cd8e6938900b1dd17e0ea5))
- use REST API for Phase 3 maintained-repo search ([#61](https://github.com/costajohnt/oss-scout/issues/61)) ([143df21](https://github.com/costajohnt/oss-scout/commit/143df2196f01d42442708ff10aed49ff72cba425))
- use REST Issues API for Phase 0 and Phase 1 searches ([#62](https://github.com/costajohnt/oss-scout/issues/62)) ([1e66b4e](https://github.com/costajohnt/oss-scout/commit/1e66b4ed4120fbd42d657deae3c59a7d16a118f2))

## [0.3.0](https://github.com/costajohnt/oss-scout/compare/core-v0.2.1...core-v0.3.0) (2026-03-30)

### Features

- add skip list with 90-day auto-cull, search filtering, and CLI/MCP support ([#50](https://github.com/costajohnt/oss-scout/issues/50)) ([a60c0ef](https://github.com/costajohnt/oss-scout/commit/a60c0ef3cf9f9b8774e8a54f22173371cfa926c1))
- change default language filter to 'any' (all languages) ([59a803f](https://github.com/costajohnt/oss-scout/commit/59a803fdafc66b8e70d4f08568c98cdc8b8c286e))

### Bug Fixes

- address final audit findings — fake URLs, versions, SEO, edge cases ([6bb7be3](https://github.com/costajohnt/oss-scout/commit/6bb7be362952f4137d3cc50dee08858342fd3d92))
- final review cleanup — MCP name, timeout leak, dead code, error types ([9abcc6b](https://github.com/costajohnt/oss-scout/commit/9abcc6b20cb57bea823728896d49d324f6a1d4c8))
- skip list gist sync, MCP feedback, date validation ([1314aae](https://github.com/costajohnt/oss-scout/commit/1314aae1328093740be588a91164004ab30400e1))

## [0.2.1](https://github.com/costajohnt/oss-scout/compare/core-v0.2.0...core-v0.2.1) (2026-03-29)

### Bug Fixes

- address review findings — gist safety, MCP error handling, persistence ([5d1743c](https://github.com/costajohnt/oss-scout/commit/5d1743c962a0040a17aa108a7739cc267099dc7b))

## [0.2.0](https://github.com/costajohnt/oss-scout/compare/core-v0.1.1...core-v0.2.0) (2026-03-28)

### Features

- add batch vetting with vet-list command ([#21](https://github.com/costajohnt/oss-scout/issues/21)) ([60d02a5](https://github.com/costajohnt/oss-scout/commit/60d02a5825d4f3f779c50a8eb50bea31a08b4177))
- add config command to view and update preferences ([#16](https://github.com/costajohnt/oss-scout/issues/16)) ([a83e2c7](https://github.com/costajohnt/oss-scout/commit/a83e2c7206f117bc5bf73c48a3a25ee1437e7bce))
- add configurable search strategy selection ([#19](https://github.com/costajohnt/oss-scout/issues/19)) ([88856ec](https://github.com/costajohnt/oss-scout/commit/88856ec331b68c7d54f14ce8f379d5f25d10d6bc))
- add first-run bootstrap for starred repos and PR history ([#18](https://github.com/costajohnt/oss-scout/issues/18)) ([ca62ac8](https://github.com/costajohnt/oss-scout/commit/ca62ac88ca9dbd6823c18e0b083c4e584a9582f3)), closes [#5](https://github.com/costajohnt/oss-scout/issues/5)
- add interactive setup command and local state persistence ([#15](https://github.com/costajohnt/oss-scout/issues/15)) ([889d5a9](https://github.com/costajohnt/oss-scout/commit/889d5a9fce333c027f09fd3ace71b62a16f5a195))
- implement gist-backed state persistence ([#24](https://github.com/costajohnt/oss-scout/issues/24)) ([f74041a](https://github.com/costajohnt/oss-scout/commit/f74041a9033e15509f05943d370c6002a6609152)), closes [#8](https://github.com/costajohnt/oss-scout/issues/8)
- initial extraction of oss-scout from oss-autopilot ([c9f52e9](https://github.com/costajohnt/oss-scout/commit/c9f52e92ecb337a68a4a5d7bea86b3101b434822))
- persist search results and add results command ([#17](https://github.com/costajohnt/oss-scout/issues/17)) ([27d6582](https://github.com/costajohnt/oss-scout/commit/27d6582a75ef6cc91134a1fb8c85ab87ff066aae))

### Bug Fixes

- add excludeOrgs support, update CLAUDE.md, publish MCP server ([214f6bd](https://github.com/costajohnt/oss-scout/commit/214f6bd672143f4cb32e06176ef8178bc7d666e7))
- address code review findings from pr-review-toolkit ([ca897a4](https://github.com/costajohnt/oss-scout/commit/ca897a4675a6f6b7249de1b65719ec40b1821dcc))
- correct plugin docs, add MCP validation, extract CLI error handler ([0a5ba37](https://github.com/costajohnt/oss-scout/commit/0a5ba379e7aad32d9b436403e311aa0f4524081d))
- improve error handling in state persistence and bootstrap ([#25](https://github.com/costajohnt/oss-scout/issues/25)) ([65a6064](https://github.com/costajohnt/oss-scout/commit/65a606494673f297abfb0431fd719b165f5b0cf5))
