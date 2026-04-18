# Changelog

## [0.5.0](https://github.com/costajohnt/oss-scout/compare/core-v0.4.0...core-v0.5.0) (2026-04-18)


### Features

* include open-PR repos in Phase 0 search ([#65](https://github.com/costajohnt/oss-scout/issues/65)) ([#66](https://github.com/costajohnt/oss-scout/issues/66)) ([e5af4d2](https://github.com/costajohnt/oss-scout/commit/e5af4d2950bf243e6b77ba02344b4c2c4ad80045))

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
