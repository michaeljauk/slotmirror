# Changelog

## 0.1.0 (2026-10-25)


### Features

* add public privacy page for each deployment ([4288122](https://github.com/michaeljauk/freebusy-sync/commit/42881220d25639d3571a2f19b8befc08d76bea66))
* add sign-in provider limit, data jurisdiction and detail caps ([70dcfcf](https://github.com/michaeljauk/freebusy-sync/commit/70dcfcff0760b93930f5898eec503982e236346a))
* add worker with microsoft sign-in, accounts and admin pages ([57310a5](https://github.com/michaeljauk/freebusy-sync/commit/57310a57367157cc9fff7657aa497ee7b0ebc519))
* **audit:** add activity page and real sync status ([877f306](https://github.com/michaeljauk/freebusy-sync/commit/877f306e8316e1974de2d75162587780604cff55))
* **audit:** add audit event table and 90-day retention ([9717aab](https://github.com/michaeljauk/freebusy-sync/commit/9717aab273d4a299ff7d9b765f25c82e776e800e))
* **audit:** record auth, account and rule events ([0f2ce87](https://github.com/michaeljauk/freebusy-sync/commit/0f2ce87a740af7ed486cdb2b2dd8e0f2d39560cb))
* **audit:** record sync runs and failures ([152b6f1](https://github.com/michaeljauk/freebusy-sync/commit/152b6f1a2601e9bed6d625425500f48ac88c3394))
* **google:** add google calendar through provider adapters ([2504341](https://github.com/michaeljauk/freebusy-sync/commit/2504341ca6a4e00e61a8b9c7f754bd0ce7726985))
* **rules:** add rule page with preview and manual run ([eb26842](https://github.com/michaeljauk/freebusy-sync/commit/eb2684208e9ba13899af59b279065528cfbc82b3))
* **rules:** start new rules paused and add pause and turn-on ([751aa05](https://github.com/michaeljauk/freebusy-sync/commit/751aa052533877abe6f47deb3efd18c0b07b45e9))
* **sync:** add sync planner with recurring-event test matrix ([869ae26](https://github.com/michaeljauk/freebusy-sync/commit/869ae266767ee8f420dcda17aeaaae1ed7ffcda4))
* **sync:** remove blocks when a rule is deleted or an account is disconnected ([7de2830](https://github.com/michaeljauk/freebusy-sync/commit/7de2830b2beca94c56a449b493946aed4d7b49db))
* **sync:** run rules in the target account's durable object ([3093887](https://github.com/michaeljauk/freebusy-sync/commit/30938875dc1ed3fddc45df1923b138c04c959112))
* **ui:** local times, quieter disconnect with confirmation, rules on the home page ([75caefb](https://github.com/michaeljauk/freebusy-sync/commit/75caefbb24253def6fceace4a9e96ee90b676ced))


### Bug fixes

* **audit:** record failed manual runs, not only alarm runs ([2e32c54](https://github.com/michaeljauk/freebusy-sync/commit/2e32c54a74f6d9422d327aa97bf4019c31270a05))
* **rules:** offer only own calendars as targets and allow a 365-day window ([8e5db29](https://github.com/michaeljauk/freebusy-sync/commit/8e5db29d4ff2b9b22ebd44035b1f63cd965bb6e5))
* **sync:** let each rule manage only its own blocks ([a2ef78d](https://github.com/michaeljauk/freebusy-sync/commit/a2ef78d6f0d5818d55c6c6f67fc6b52069a59923))
* **sync:** run one provider call per mailbox at a time ([d22522c](https://github.com/michaeljauk/freebusy-sync/commit/d22522c9f549151a192cd298b4dbd40032ab342d))
* **sync:** run one rule per alarm ([9e58cab](https://github.com/michaeljauk/freebusy-sync/commit/9e58cabd42829bc52a1a54eea66d64fe9c884716))
* **sync:** wait for retry-after when a provider throttles ([fde7c67](https://github.com/michaeljauk/freebusy-sync/commit/fde7c6712d7e4158040254c935cab320e9694d40))


### Performance

* import signing and encryption keys once per isolate ([3affbf9](https://github.com/michaeljauk/freebusy-sync/commit/3affbf984b9d75ae54c2757a3f06a40ff1aa2eb8))


### Documentation

* add contributing guide, security policy, code of conduct and agent guide ([a04424d](https://github.com/michaeljauk/freebusy-sync/commit/a04424d2ffd5bcdcb5809acfdca334cc98d8324d))
* describe provider rate limits and the call queue ([2710c92](https://github.com/michaeljauk/freebusy-sync/commit/2710c9293e1a5fddeeca76ed119afaa215a4a484))
* **sync:** warn that short graph field lists drop the marker ([d8d9020](https://github.com/michaeljauk/freebusy-sync/commit/d8d90201d168eca19548123ce995f0a6a9534330))
