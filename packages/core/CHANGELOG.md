# Changelog

## [0.2.1](https://github.com/costajohnt/oss-scout/compare/core-v0.2.0...core-v0.2.1) (2026-03-29)


### Bug Fixes

* address review findings — gist safety, MCP error handling, persistence ([5d1743c](https://github.com/costajohnt/oss-scout/commit/5d1743c962a0040a17aa108a7739cc267099dc7b))

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
