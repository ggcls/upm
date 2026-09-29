# Changelog


## v1.3.1

[compare changes](https://github.com/unjs/upm/compare/v1.3.0...v1.3.1)

### 🏡 Chore

- Build after version bump in release script ([2c52b2b](https://github.com/unjs/upm/commit/2c52b2b))
- Ignore devEngine mismatch ([bce27ed](https://github.com/unjs/upm/commit/bce27ed))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v1.3.0

[compare changes](https://github.com/unjs/upm/compare/v1.2.0...v1.3.0)

### 🚀 Enhancements

- Minimal progress bar and shorter install output ([#12](https://github.com/unjs/upm/pull/12))
- **cli:** Add --verbose flag ([#18](https://github.com/unjs/upm/pull/18))
- **cli:** Add -v and --version ([#19](https://github.com/unjs/upm/pull/19))
- **cli:** `upm` alone installs ([242fa15](https://github.com/unjs/upm/commit/242fa15))
- **cli:** Report progress with OSC 9;4. ([81e79ce](https://github.com/unjs/upm/commit/81e79ce))

### 🔥 Performance

- Faster warm resolve and reuse of an existing node_modules ([#9](https://github.com/unjs/upm/pull/9))
- Faster warm resolve on large workspaces ([#15](https://github.com/unjs/upm/pull/15))
- Faster link from upm.lock with a warm store ([#14](https://github.com/unjs/upm/pull/14))
- No-op install in a large workspace without a glob ([#13](https://github.com/unjs/upm/pull/13))
- Faster cold install ([#16](https://github.com/unjs/upm/pull/16))

### 🩹 Fixes

- Share one peer version between consumers whose ranges overlap ([#10](https://github.com/unjs/upm/pull/10))
- Link undeclared deps through `.upm/node_modules` ([#20](https://github.com/unjs/upm/pull/20))

### 🏡 Chore

- Update readme ([1108606](https://github.com/unjs/upm/commit/1108606))
- Update website ([16ad722](https://github.com/unjs/upm/commit/16ad722))
- Fix bench script ([234e246](https://github.com/unjs/upm/commit/234e246))
- Update benchmarks ([89f6461](https://github.com/unjs/upm/commit/89f6461))
- Update size chart ([79b4407](https://github.com/unjs/upm/commit/79b4407))
- Update bench script ([7c62d9e](https://github.com/unjs/upm/commit/7c62d9e))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Pi0x <x@pi0.io>
- Grégoire Ciles ([@ggcls](https://github.com/ggcls))

## v1.2.0

[compare changes](https://github.com/unjs/upm/compare/v1.1.0...v1.2.0)

### 🚀 Enhancements

- Fall back to installed bins for `upm <cmd>` ([a9a38b5](https://github.com/unjs/upm/commit/a9a38b5))

### 💅 Refactors

- Reduce dist size ([7b8496f](https://github.com/unjs/upm/commit/7b8496f))
- **cli:** Improve messages ([47da6e9](https://github.com/unjs/upm/commit/47da6e9))

### 🏡 Chore

- Credit @sondreb for pkg name ([6672999](https://github.com/unjs/upm/commit/6672999))
- Rerun full benchmarks ([dc5cf3a](https://github.com/unjs/upm/commit/dc5cf3a))
- Add devEngines.packageManager ([6611add](https://github.com/unjs/upm/commit/6611add))

### ✅ Tests

- Measure startup budget as minified code ([c0c5a33](https://github.com/unjs/upm/commit/c0c5a33))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v1.1.0


### 🚀 Enhancements

- **cli:** Accept npm's command names and common flags ([4e41c4d](https://github.com/unjs/upm/commit/4e41c4d))
- Auto install when running scripts ([a20cf07](https://github.com/unjs/upm/commit/a20cf07))
- Offline mode and registry cache ([#2](https://github.com/unjs/upm/pull/2))
- Pluggable store backend ([#4](https://github.com/unjs/upm/pull/4))

### 🩹 Fixes

- **runtime:** Support browser process shims and timers ([948e59f](https://github.com/unjs/upm/commit/948e59f))

### 📦 Build

- Label obuild's libs chunk group with debugName ([aa5ee19](https://github.com/unjs/upm/commit/aa5ee19))

### 🏡 Chore

- Update docs ([15de9ef](https://github.com/unjs/upm/commit/15de9ef))
- Update docs ([8e31525](https://github.com/unjs/upm/commit/8e31525))
- Apply automated updates ([50a430f](https://github.com/unjs/upm/commit/50a430f))
- Apply automated updates ([222f014](https://github.com/unjs/upm/commit/222f014))
- Update website ([081ecc1](https://github.com/unjs/upm/commit/081ecc1))
- Finalize state files ([889261f](https://github.com/unjs/upm/commit/889261f))
- Update website ([7ef4721](https://github.com/unjs/upm/commit/7ef4721))
- Apply automated updates ([4f4d753](https://github.com/unjs/upm/commit/4f4d753))
- Improve website ([92b213a](https://github.com/unjs/upm/commit/92b213a))
- Improve website ([c63ab74](https://github.com/unjs/upm/commit/c63ab74))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
- Pi0x <x@pi0.io>

