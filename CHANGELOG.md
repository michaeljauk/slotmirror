# Changelog

## [0.2.0](https://github.com/slotmirror/slotmirror/compare/slotmirror-v0.1.0...slotmirror-v0.2.0) (2026-11-07)


### Features

* **node:** add the SQLite registry database ([#91](https://github.com/slotmirror/slotmirror/issues/91)) ([90bb298](https://github.com/slotmirror/slotmirror/commit/90bb298f28b311c6c76dde9b0f0ed67998e03c31))
* **website:** add an imprint and a privacy notice for slotmirror.com ([#93](https://github.com/slotmirror/slotmirror/issues/93)) ([662c533](https://github.com/slotmirror/slotmirror/commit/662c533fa91c9f856f564ae24d4846e94fab0310))
* **website:** redesign the home page around a live demo and showcase cards ([#92](https://github.com/slotmirror/slotmirror/issues/92)) ([f9b5685](https://github.com/slotmirror/slotmirror/commit/f9b5685e8a4d0f554f76882cb1453c3751f8a791))


### Bug fixes

* **calendars:** skip a calendar that does not fit the schema and read every page ([#99](https://github.com/slotmirror/slotmirror/issues/99)) ([8fe34c3](https://github.com/slotmirror/slotmirror/commit/8fe34c35bde536e41f71fd7016c4b3863d56abc5))
* **graph:** accept a calendar whose owner is null ([#97](https://github.com/slotmirror/slotmirror/issues/97)) ([0bb5f09](https://github.com/slotmirror/slotmirror/commit/0bb5f0978b6e7b1e07e55ab35a6235bfb37aef20))
* **log:** log why listing calendars failed inside the account instance ([#96](https://github.com/slotmirror/slotmirror/issues/96)) ([81cb350](https://github.com/slotmirror/slotmirror/commit/81cb350d58f4d8d2fee8f5c1cef38e1f13e602b1))
* **log:** name the code and path of a schema error in error logs ([#95](https://github.com/slotmirror/slotmirror/issues/95)) ([f5bef68](https://github.com/slotmirror/slotmirror/commit/f5bef685bc3f69ef4e59d83e1426be25e0d3ac30))
* **release:** ignore release-please files in oxfmt and read the version in tests ([#86](https://github.com/slotmirror/slotmirror/issues/86)) ([3889106](https://github.com/slotmirror/slotmirror/commit/3889106dabf6b0cb84c969ab10e7ec43a93b8d20))


### Documentation

* **license:** drop license-mit and link the mit text at its last commit ([#98](https://github.com/slotmirror/slotmirror/issues/98)) ([8fe8430](https://github.com/slotmirror/slotmirror/commit/8fe8430987ab86451ae4431c0c5f6ae773aa6ddf))

## 0.1.0 (2026-11-06)


### Features

* **access:** check each route against an action catalog and let admins limit mcp to admins ([#84](https://github.com/slotmirror/slotmirror/issues/84)) ([fde4b24](https://github.com/slotmirror/slotmirror/commit/fde4b24b2ee3cf4e9c57d8c7fd308f54c29a634a))
* add operator alerts, comparison runs and a scenario suite ([#51](https://github.com/slotmirror/slotmirror/issues/51)) ([7d8a92e](https://github.com/slotmirror/slotmirror/commit/7d8a92e8b15b38c5b6bca3523e9330f485d5e22a))
* add public privacy page for each deployment ([4288122](https://github.com/slotmirror/slotmirror/commit/42881220d25639d3571a2f19b8befc08d76bea66))
* add sign-in provider limit, data jurisdiction and detail caps ([70dcfcf](https://github.com/slotmirror/slotmirror/commit/70dcfcff0760b93930f5898eec503982e236346a))
* add worker with microsoft sign-in, accounts and admin pages ([57310a5](https://github.com/slotmirror/slotmirror/commit/57310a57367157cc9fff7657aa497ee7b0ebc519))
* **alerts:** call an outside monitor from the hourly cron ([#69](https://github.com/slotmirror/slotmirror/issues/69)) ([7012beb](https://github.com/slotmirror/slotmirror/commit/7012beb03e3da1b49aeebc4c9533f825ae84244d))
* ask to reconnect broken accounts, set the block title, filter by category ([c316fb0](https://github.com/slotmirror/slotmirror/commit/c316fb095e36755b33fd41233bf945e9ab4a18ec))
* **audit:** add activity page and real sync status ([877f306](https://github.com/slotmirror/slotmirror/commit/877f306e8316e1974de2d75162587780604cff55))
* **audit:** add audit event table and 90-day retention ([9717aab](https://github.com/slotmirror/slotmirror/commit/9717aab273d4a299ff7d9b765f25c82e776e800e))
* **audit:** record auth, account and rule events ([0f2ce87](https://github.com/slotmirror/slotmirror/commit/0f2ce87a740af7ed486cdb2b2dd8e0f2d39560cb))
* **audit:** record sync runs and failures ([152b6f1](https://github.com/slotmirror/slotmirror/commit/152b6f1a2601e9bed6d625425500f48ac88c3394))
* **editor:** rebuild the rules editor with account working hours and a buffer per source ([#31](https://github.com/slotmirror/slotmirror/issues/31)) ([33fc76c](https://github.com/slotmirror/slotmirror/commit/33fc76c5675ec5bb04222f5f0f4dd385d2002dcf))
* **feeds:** add a private free/busy ics feed per user ([#18](https://github.com/slotmirror/slotmirror/issues/18)) ([24d7949](https://github.com/slotmirror/slotmirror/commit/24d7949d9b4e0414dd1911e1bf356bf9c491ffce))
* **google:** add google calendar through provider adapters ([2504341](https://github.com/slotmirror/slotmirror/commit/2504341ca6a4e00e61a8b9c7f754bd0ce7726985))
* load tests with simulated calendars, a source cache, and a view for many accounts ([957bf96](https://github.com/slotmirror/slotmirror/commit/957bf96480f069e204afd0be38a83ab0f3226b31))
* **mcp:** add a read-only MCP endpoint with personal API tokens ([#71](https://github.com/slotmirror/slotmirror/issues/71)) ([aff253a](https://github.com/slotmirror/slotmirror/commit/aff253a390153259bef9834d1cb000e1930949bc))
* **mcp:** connect MCP clients with the user's sign-in over OAuth ([#76](https://github.com/slotmirror/slotmirror/issues/76)) ([de3b6cd](https://github.com/slotmirror/slotmirror/commit/de3b6cdf63ba2f949746a0f0db1861adcbbe3050))
* offboarding with SCIM, account deletion and shorter sessions ([5f2ba85](https://github.com/slotmirror/slotmirror/commit/5f2ba85f823737f2e41068c28265ccd3e3ecd0df))
* **offboarding:** keep each removal as a tombstone and show what is left ([#59](https://github.com/slotmirror/slotmirror/issues/59)) ([85f0c89](https://github.com/slotmirror/slotmirror/commit/85f0c89eebbad3e1b758277e0cbe3d8d9ec9541a))
* **rules:** add rule page with preview and manual run ([eb26842](https://github.com/slotmirror/slotmirror/commit/eb2684208e9ba13899af59b279065528cfbc82b3))
* **rules:** start new rules paused and add pause and turn-on ([751aa05](https://github.com/slotmirror/slotmirror/commit/751aa052533877abe6f47deb3efd18c0b07b45e9))
* **scripts:** add a capacity probe for staged load runs ([#47](https://github.com/slotmirror/slotmirror/issues/47)) ([984cfbf](https://github.com/slotmirror/slotmirror/commit/984cfbfc02f110249d6c3519278e264d3f1ef146))
* **sync:** add an opt-in category list per direction ([#64](https://github.com/slotmirror/slotmirror/issues/64)) ([7265008](https://github.com/slotmirror/slotmirror/commit/726500867081a5478237b41e74ba100e920ea92a))
* **sync:** add an optional origin note to mirrored blocks ([#32](https://github.com/slotmirror/slotmirror/issues/32)) ([31981a1](https://github.com/slotmirror/slotmirror/commit/31981a11ef7620a02cb85e5caeee8856d72c0dcf))
* **sync:** add sync planner with recurring-event test matrix ([869ae26](https://github.com/slotmirror/slotmirror/commit/869ae266767ee8f420dcda17aeaaae1ed7ffcda4))
* **sync:** pause accounts that need reconnecting and show them on every page ([#16](https://github.com/slotmirror/slotmirror/issues/16)) ([185ef74](https://github.com/slotmirror/slotmirror/commit/185ef74eebfec729b3b9d100a4dc5370ae500326))
* **sync:** poll only calendars without push, and skip echoes of own writes ([32dea4b](https://github.com/slotmirror/slotmirror/commit/32dea4b37bfe2c7be67b3ac4f65fe43bdbbace81))
* **sync:** push notifications from Microsoft and Google ([95ca441](https://github.com/slotmirror/slotmirror/commit/95ca441e59f1b34210db854e6c22ad68a282b5ab))
* **sync:** remove blocks when a rule is deleted or an account is disconnected ([7de2830](https://github.com/slotmirror/slotmirror/commit/7de2830b2beca94c56a449b493946aed4d7b49db))
* **sync:** run rules in the target account's durable object ([3093887](https://github.com/slotmirror/slotmirror/commit/30938875dc1ed3fddc45df1923b138c04c959112))
* **ui:** add account colours and a configurable block colour per direction ([7a3ce11](https://github.com/slotmirror/slotmirror/commit/7a3ce11407fbed8585a7b67fb9a3b3b52a54bc65))
* **ui:** choose several source calendars per account ([b8b6cbb](https://github.com/slotmirror/slotmirror/commit/b8b6cbb4401130d26fd699ba05f145706a7f341f))
* **ui:** edit a source card without page reloads ([202641d](https://github.com/slotmirror/slotmirror/commit/202641df18694a77d6d9ea163fcce7395dd85a18))
* **ui:** first steps and a quick start for new users ([edbd1d2](https://github.com/slotmirror/slotmirror/commit/edbd1d2c7730f4036060a581c41c40c98ffb813a))
* **ui:** keep the overview next to the editor and remove blocks in the background ([c18346f](https://github.com/slotmirror/slotmirror/commit/c18346fca3e7122873fe57dd9a5c3814c72e20e3))
* **ui:** let users rename accounts ([d05519d](https://github.com/slotmirror/slotmirror/commit/d05519d906120fe296826ea2b22ea25cf7f488e2))
* **ui:** local times, quieter disconnect with confirmation, rules on the home page ([75caefb](https://github.com/slotmirror/slotmirror/commit/75caefbb24253def6fceace4a9e96ee90b676ced))
* **ui:** move the navigation into a sidebar and fix the setup traps ([#52](https://github.com/slotmirror/slotmirror/issues/52)) ([3799018](https://github.com/slotmirror/slotmirror/commit/3799018f57b2d2d2eac42c7135b56a77c66bafa6))
* **ui:** open the account settings inline instead of as a popup ([#68](https://github.com/slotmirror/slotmirror/issues/68)) ([887e802](https://github.com/slotmirror/slotmirror/commit/887e8023da1ad67f9881b5c091d30f6f496f6fa9))
* **ui:** replace the rule list with a calendar editor ([d2c8844](https://github.com/slotmirror/slotmirror/commit/d2c88441e80bac82a0a693c35f6a20e2acee6691))
* **ui:** save all editor changes with one button for the page ([37f8ca9](https://github.com/slotmirror/slotmirror/commit/37f8ca9853c6576d2cd4d4b2b68254ed7afedd61))
* **ui:** settings for all calendars, phone layout, one page width ([7f6f7d1](https://github.com/slotmirror/slotmirror/commit/7f6f7d1c7a920a7c1c6baaa6063b42bfcb7bc1fd))
* **ui:** show the build version in the footer ([#39](https://github.com/slotmirror/slotmirror/issues/39)) ([be3abef](https://github.com/slotmirror/slotmirror/commit/be3abefdc0bfc241d4e535fdaee416cce20c223e))
* **waitlist:** add a waitlist worker and a website form with double opt-in ([#38](https://github.com/slotmirror/slotmirror/issues/38)) ([e6ceeef](https://github.com/slotmirror/slotmirror/commit/e6ceeefb48406d11171661f93f8666862ccccfe8))
* **website:** add an Astro and Starlight site with docs, guides and changelog ([ea77143](https://github.com/slotmirror/slotmirror/commit/ea77143f6e9220d3fa51112c7a1a3601b6339d4d))
* **website:** add german versions of the guides ([#77](https://github.com/slotmirror/slotmirror/issues/77)) ([7e223de](https://github.com/slotmirror/slotmirror/commit/7e223de6abe96510634c8df0d78d9b7aa540d00b))
* **website:** build the home page from the c2 design ([91804c6](https://github.com/slotmirror/slotmirror/commit/91804c6f8e966622eb46f2a05f3ae1a0cd42ea59))
* **website:** let the demo move the meeting in every calendar ([afa6543](https://github.com/slotmirror/slotmirror/commit/afa6543232bf8ce3f9139f940e2fd43a5e6f65b5))
* **website:** rank the home page call to action and drop the unmeasured speed claim ([#46](https://github.com/slotmirror/slotmirror/issues/46)) ([b98cfb4](https://github.com/slotmirror/slotmirror/commit/b98cfb49f33178c989d39eda1d154a709f9a48de))
* **website:** serve the website from Cloudflare and measure it with cookieless PostHog ([#37](https://github.com/slotmirror/slotmirror/issues/37)) ([c37c59b](https://github.com/slotmirror/slotmirror/commit/c37c59b167627d09e1fecf3d1aa09a26c3430173))
* **website:** show the colours in the editor screenshot and the docs link on phones ([d251845](https://github.com/slotmirror/slotmirror/commit/d2518459e88252af8318779eb664dd12e2f6cc05))


### Bug fixes

* **audit:** record failed manual runs, not only alarm runs ([2e32c54](https://github.com/slotmirror/slotmirror/commit/2e32c54a74f6d9422d327aa97bf4019c31270a05))
* **compare:** stop a comparison when its owner no longer has access ([#63](https://github.com/slotmirror/slotmirror/issues/63)) ([5786958](https://github.com/slotmirror/slotmirror/commit/5786958a78d777603f608f2807bbad4593170161))
* **config:** keep dashboard settings across deploys ([#40](https://github.com/slotmirror/slotmirror/issues/40)) ([9839278](https://github.com/slotmirror/slotmirror/commit/98392782a232b875edff67e711e9c5ecc8287215))
* **editor:** let users turn a direction off when the target is read-only ([#24](https://github.com/slotmirror/slotmirror/issues/24)) ([b6d0f91](https://github.com/slotmirror/slotmirror/commit/b6d0f91f66baf0957a80170426b9a890b9905a40))
* **editor:** re-create lost group rules and survive concurrent saves ([#27](https://github.com/slotmirror/slotmirror/issues/27)) ([d36d699](https://github.com/slotmirror/slotmirror/commit/d36d6999bcec27361c651c5bc9187ae4186291df))
* **editor:** save all changes or none, and fix stale status, names and copy ([#28](https://github.com/slotmirror/slotmirror/issues/28)) ([c0fe631](https://github.com/slotmirror/slotmirror/commit/c0fe631314b07e68ef5b8e960a67e40578c9bfdd))
* **editor:** save settings in one batch and queue trims once per account ([#30](https://github.com/slotmirror/slotmirror/issues/30)) ([7e90bcd](https://github.com/slotmirror/slotmirror/commit/7e90bcdaeddf4eabf700ea5a6fe327b62bcdabc1))
* **logs:** keep provider error descriptions out of logs ([#29](https://github.com/slotmirror/slotmirror/issues/29)) ([3ebe81e](https://github.com/slotmirror/slotmirror/commit/3ebe81e8d35ffeec0f9ee13db0a725704837cf82))
* **rules:** offer only own calendars as targets and allow a 365-day window ([8e5db29](https://github.com/slotmirror/slotmirror/commit/8e5db29d4ff2b9b22ebd44035b1f63cd965bb6e5))
* **sync:** back off failed removals and respect retry-after ([#20](https://github.com/slotmirror/slotmirror/issues/20)) ([dc2fd13](https://github.com/slotmirror/slotmirror/commit/dc2fd13baa400ce0cafde98bd839fddefd7058fa))
* **sync:** check graph notifications in an alarm, after the write that caused them ([#10](https://github.com/slotmirror/slotmirror/issues/10)) ([8da32d7](https://github.com/slotmirror/slotmirror/commit/8da32d7086a4a85c168bb45b1fb10d7758615829))
* **sync:** keep queued removals and rules when the queue changes during a run ([#5](https://github.com/slotmirror/slotmirror/issues/5)) ([f424ff4](https://github.com/slotmirror/slotmirror/commit/f424ff4a5dfbd6f23f359818b38e7e075e290f27))
* **sync:** keep retrying removals of a retiring account ([#26](https://github.com/slotmirror/slotmirror/issues/26)) ([3bf4677](https://github.com/slotmirror/slotmirror/commit/3bf46774097822e42cf49a6d84259928b452025e))
* **sync:** keep the cron loop, google all-day changes and follower rules working ([#21](https://github.com/slotmirror/slotmirror/issues/21)) ([ce42520](https://github.com/slotmirror/slotmirror/commit/ce42520d59aa728a19c40dda4a6b14dc20a716a6))
* **sync:** let each rule manage only its own blocks ([a2ef78d](https://github.com/slotmirror/slotmirror/commit/a2ef78d6f0d5818d55c6c6f67fc6b52069a59923))
* **sync:** remove blocks beyond a lowered days-ahead window ([#25](https://github.com/slotmirror/slotmirror/issues/25)) ([1529d2c](https://github.com/slotmirror/slotmirror/commit/1529d2c052d7740b360dacccbdaa0d9ea0a4352e))
* **sync:** retry failed sync requests and compare google echoes with the notification time ([#15](https://github.com/slotmirror/slotmirror/issues/15)) ([2f03a57](https://github.com/slotmirror/slotmirror/commit/2f03a577cbc4af6ffe2f472c7b2cde36f416f0b6))
* **sync:** run a full cycle again for changes that arrive during a cycle ([#19](https://github.com/slotmirror/slotmirror/issues/19)) ([e28204a](https://github.com/slotmirror/slotmirror/commit/e28204ad0768e5efea4f467e3bde75e80ac485dd))
* **sync:** run one provider call per mailbox at a time ([d22522c](https://github.com/slotmirror/slotmirror/commit/d22522c9f549151a192cd298b4dbd40032ab342d))
* **sync:** run one rule per alarm ([9e58cab](https://github.com/slotmirror/slotmirror/commit/9e58cabd42829bc52a1a54eea66d64fe9c884716))
* **sync:** skip google notifications about blocks this deployment wrote ([#8](https://github.com/slotmirror/slotmirror/issues/8)) ([d4b402c](https://github.com/slotmirror/slotmirror/commit/d4b402cc39241e72ee0025ee7c37090aeeb49f83)), closes [#7](https://github.com/slotmirror/slotmirror/issues/7)
* **sync:** stop re-creating all-day blocks at the window edges ([#23](https://github.com/slotmirror/slotmirror/issues/23)) ([cc319df](https://github.com/slotmirror/slotmirror/commit/cc319df15a003845c1db788906de31c412364c90))
* **sync:** wait for retry-after when a provider throttles ([fde7c67](https://github.com/slotmirror/slotmirror/commit/fde7c6712d7e4158040254c935cab320e9694d40))
* **sync:** write one block where several rules would write equal ones ([#4](https://github.com/slotmirror/slotmirror/issues/4)) ([34c4235](https://github.com/slotmirror/slotmirror/commit/34c4235eb76a7e6b0de3d7f9bbb2bf18e94c43d9))
* **ui:** align the account menu with the avatar at every width ([#13](https://github.com/slotmirror/slotmirror/issues/13)) ([ef00b93](https://github.com/slotmirror/slotmirror/commit/ef00b931109d3d2b329d65764a009fcc71c88ca3))
* **ui:** check every source calendar of a direction with real events ([7956239](https://github.com/slotmirror/slotmirror/commit/7956239bb8ec0ade35ac83d345733758e7b5e2de))
* **ui:** clear the block colour on reset and show the google colour in the example ([cd11cd1](https://github.com/slotmirror/slotmirror/commit/cd11cd17ede63396799277e34c1b5345587cfd08))
* **ui:** explain the sync settings and show them as switches ([86bc7cf](https://github.com/slotmirror/slotmirror/commit/86bc7cf051e17aa01f53ab8581c98a7504385e32))
* **ui:** keep account names whole in the rules overview ([#67](https://github.com/slotmirror/slotmirror/issues/67)) ([2cac23e](https://github.com/slotmirror/slotmirror/commit/2cac23ebee473e46b8cc832dc15990deffd1e384))
* **ui:** keep assigned account colours when another account gets a chosen colour ([8fcc17c](https://github.com/slotmirror/slotmirror/commit/8fcc17c328f7a3cb75b10d5395b403cc3c484069))
* **ui:** keep the sidebar on the privacy page for a signed-in user ([#65](https://github.com/slotmirror/slotmirror/issues/65)) ([ba8ae18](https://github.com/slotmirror/slotmirror/commit/ba8ae18d36f8ab75d1e845b1b5451cb772d1c583))
* **ui:** plain words for the inline check, and keep the chosen button readable on hover ([aac8f99](https://github.com/slotmirror/slotmirror/commit/aac8f99b6cfda0249bd6ccfe3835401035a8028e))
* **ui:** send a doctype so that browsers use standards mode ([e39bde0](https://github.com/slotmirror/slotmirror/commit/e39bde004ef2cc55af8260153631a99f3c67d8ed))
* **ui:** show the direction in the editor and tidy small layout issues ([9783a8a](https://github.com/slotmirror/slotmirror/commit/9783a8a67296828593b863fc40b3a547e7ccfd75))
* **ui:** warn when an account has no loaded calendars ([#66](https://github.com/slotmirror/slotmirror/issues/66)) ([8badca2](https://github.com/slotmirror/slotmirror/commit/8badca222a44116bf508d67661c68945fe9d26b5))
* **ui:** widen the header with the editor and use short labels in the overview ([e19aa42](https://github.com/slotmirror/slotmirror/commit/e19aa420a3298966f69ae87c059952a8bd813cf8))
* **website:** add robots.txt, structured data and preview tags for search engines ([#72](https://github.com/slotmirror/slotmirror/issues/72)) ([b5694f1](https://github.com/slotmirror/slotmirror/commit/b5694f1e05959644c278afd37a84410084505858))
* **website:** align the link preview and page texts with the hero headline ([#50](https://github.com/slotmirror/slotmirror/issues/50)) ([c004597](https://github.com/slotmirror/slotmirror/commit/c004597780e8b897a2d049362e0f9e25303f8463))
* **website:** drop the license from the hero and the footer ([#58](https://github.com/slotmirror/slotmirror/issues/58)) ([fb493c9](https://github.com/slotmirror/slotmirror/commit/fb493c914ce4b1a12c19bd7232b7d92e7c61dde5))


### Performance

* import signing and encryption keys once per isolate ([3affbf9](https://github.com/slotmirror/slotmirror/commit/3affbf984b9d75ae54c2757a3f06a40ff1aa2eb8))
* **sync:** cut cpu per sync run ([#22](https://github.com/slotmirror/slotmirror/issues/22)) ([45d7b2f](https://github.com/slotmirror/slotmirror/commit/45d7b2feb73f7e45ff8ecd0696d00e2f64a29c05))


### Documentation

* add a logo lockup with the wordmark, for light and dark backgrounds ([9d9fb46](https://github.com/slotmirror/slotmirror/commit/9d9fb46d3353e83ca20ebb9786cf7cfe22cf0b76))
* add a marketing demo gif with cursor and zoom to the readme ([c692e3e](https://github.com/slotmirror/slotmirror/commit/c692e3ef6193b7ed58ae3ce7b225590e21e7350a))
* add contributing guide, security policy, code of conduct and agent guide ([a04424d](https://github.com/slotmirror/slotmirror/commit/a04424d2ffd5bcdcb5809acfdca334cc98d8324d))
* **alerts:** show how one healthchecks.io check takes both secrets ([#70](https://github.com/slotmirror/slotmirror/issues/70)) ([0aa9f66](https://github.com/slotmirror/slotmirror/commit/0aa9f662906f6cb49b887dae479ae71271018809))
* describe provider rate limits and the call queue ([2710c92](https://github.com/slotmirror/slotmirror/commit/2710c9293e1a5fddeeca76ed119afaa215a4a484))
* describe the hourly full sync and the self-service data deletion ([64ac5bf](https://github.com/slotmirror/slotmirror/commit/64ac5bfb7fd79f0163935baeecacc6377b5f63eb))
* **design:** add the github social preview image ([34eef3d](https://github.com/slotmirror/slotmirror/commit/34eef3da7e8ba23277e5dfe7096e1bffd68ab80a))
* **design:** point the social preview source at repo paths ([84a4d2d](https://github.com/slotmirror/slotmirror/commit/84a4d2dc0a46663642e40bcbaab3cc80b35fb2ce))
* **license:** relicense to agpl-3.0 and add a contributor license agreement ([#36](https://github.com/slotmirror/slotmirror/issues/36)) ([989d81c](https://github.com/slotmirror/slotmirror/commit/989d81c808c0867e1090d1926deae730370752ca))
* point repo links to the slotmirror organization ([#85](https://github.com/slotmirror/slotmirror/issues/85)) ([1385438](https://github.com/slotmirror/slotmirror/commit/1385438cb0d359672a1b83c0905ea88d36a370d7))
* **quickstart:** deploy first, then OAuth app, then secrets ([#44](https://github.com/slotmirror/slotmirror/issues/44)) ([cc95c1e](https://github.com/slotmirror/slotmirror/commit/cc95c1ef2512b500f9fb91f16ee6ad0bdefcd998))
* **readme:** add coffee link, ci badges and support footer ([93ce752](https://github.com/slotmirror/slotmirror/commit/93ce7520f31641634397cc3f6aede046fab22987))
* **readme:** point to the provider guides and list what setup needs ([#48](https://github.com/slotmirror/slotmirror/issues/48)) ([405b128](https://github.com/slotmirror/slotmirror/commit/405b128f3b728525107272f4c3744b9605708cb0))
* rewrite the readme for the launch ([e67c4db](https://github.com/slotmirror/slotmirror/commit/e67c4db0c5022405f61e51d2f2bd31189a32d5c7))
* **sync:** warn that short graph field lists drop the marker ([d8d9020](https://github.com/slotmirror/slotmirror/commit/d8d90201d168eca19548123ce995f0a6a9534330))
* **upgrade:** add a guide to update a deployment and go back ([#45](https://github.com/slotmirror/slotmirror/issues/45)) ([f004296](https://github.com/slotmirror/slotmirror/commit/f00429641b8991388072609ec6e6355eaf93f4d6))
* **website:** add a guide on self-hosted calendar sync ([#73](https://github.com/slotmirror/slotmirror/issues/73)) ([ef4f8b0](https://github.com/slotmirror/slotmirror/commit/ef4f8b071b1760d7d97af402a6cd3b65d73cd6c8))
* **website:** explain in each guide why the built-in calendar options fall short ([#74](https://github.com/slotmirror/slotmirror/issues/74)) ([759235f](https://github.com/slotmirror/slotmirror/commit/759235f77057ac722ad90d2e98f1a1d8262c7883))
* **website:** give pages titles and descriptions that match what people search for ([#75](https://github.com/slotmirror/slotmirror/issues/75)) ([76db5c4](https://github.com/slotmirror/slotmirror/commit/76db5c4f03b6877e9c127f7e5bfa1aa72f1b99e2))
