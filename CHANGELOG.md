# Changelog

## 2.0.1

### Fixed
- An unreachable Matter node is now reported with the same message on every attempt, so each
  thermostat logs it once instead of on every cycle ("Next attempt in 30s/15s…").
- A relay command that keeps failing is logged once; retries are only visible with detailed logging.
- Removed the doubled full stop in "not reachable right now.." messages.
- HAP no longer warns about the StatusFault characteristic on the Thermostat service.

## 2.0.0

### Fixed
- The settings page crashed with `TypeError: isVerboseLoggingEnabled is not a function` whenever the
  Matter client logged something, so paired nodes could show up as unreachable.
- HomeKit requests no longer wait for Matter. Getters answer from memory and setters return
  immediately, so an unreachable device no longer makes the thermostat show "No Response".
- A target temperature or mode change during a running control cycle was silently dropped until
  the next cycle; it now triggers a follow-up cycle right away.
- Overlapping reads to the same Matter node ("The previous message … has not been acked yet") are
  gone: all traffic to one node is queued.
- Matter operations have a 20 s timeout. After a failure the node is backed off (30 s → 2 min),
  so an offline device fails fast instead of blocking for about a minute every cycle.
- One failing temperature sensor no longer disables the whole thermostat; the working ones are used.
- Thermostats sharing one relay no longer switch it against each other.
- Relay reads that started before our own command are ignored, avoiding false cut-out detection.
- HomeKit target range with min = max is corrected (HomeKit rejects it).
- Thermostats start controlling right away instead of waiting for the settings-page scan.
- The Matter controller is closed and timers stopped on Homebridge shutdown.

### Added
- Settings page in English and Hungarian (automatic, or chosen in the page).
- Fixed IP address per Matter node (`nodeAddressOverrides`), set on the settings page. It is written
  before the Matter controller starts and into the live peer, so the very first connection attempt
  already uses it, and automatic address repair never replaces it. The field is available even when
  there is no scan data (e.g. while the child bridge is running), for every node used in the config.
- Clear "not reachable" help on the settings page, cached scan shown instantly while a live scan runs.
- Two-click confirmation for removing pairings and thermostats.
- Last temperature is persisted, so Apple Home shows a sensible value right after a restart.
- `ConfiguredName` for correct names on iOS 16+.
- matter.js logs are quiet by default (WARN), INFO with detailed logging, `MATTER_LOG_LEVEL` overrides.

### Changed
- Homebridge 2.x support declared (`^1.8.0 || ^2.0.0`), built and tested against Homebridge 2.4.
- Temperatures, window sensors and the relay state are read in one batched Matter read per node
  on every control cycle. `temperatureRefreshIntervalMinutes` is no longer needed; it is accepted
  and ignored.
- Relay retry delay now counts from the moment the cut-out was detected.
- A thermostat whose config becomes invalid keeps its HomeKit accessory (shown as faulted), so
  rooms and automations are not lost.

### Removed
- Unused legacy HomeKit-controller code and the `hap-controller` and `@matter/nodejs-ble` dependencies.
