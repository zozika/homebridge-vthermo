# Changelog

## 2.3.0

### Added
- **Sleepy (ICD) Matter devices**, e.g. battery Thread door sensors like IKEA MYGGBETT. They are
  detected from their session idle interval or the IcdManagement cluster and are **never polled**:
  matter.js keeps a permanent subscription (its native auto-subscribe, including LIT check-in
  registration) and the thermostats read the reported values from the node state. Changes trigger
  a control cycle immediately. Values stay valid while the subscription is confirmed; after
  15 minutes without it a window counts as closed and the thermostat shows a fault. Lost
  subscriptions are retried every minute. Independent of `instantUpdates`.
- ICD details (idle/active interval) on the settings page and in the live status.
- **Startup network diagnostics** (Linux): warns when the host has no routable IPv6 address, or no
  route to a device's IPv6 address (typical for Thread when the host ignores the border routers'
  route information, `accept_ra_rt_info_max_plen`).
- **`matterInterface`**: limit Matter discovery to one network interface (e.g. `br0`), so Docker/LXC
  bridges are not used.
- End-to-end test for a sleepy device (`test/e2e/run-icd.mjs`).

### Changed
- Pairing picks the device record whose commissioning window is open (CM ≠ 0) and ignores stale
  Thread records; commissioning may take up to 3 minutes (sleepy devices). The settings page shows
  a tip to keep battery devices awake while pairing.
- Timeouts for sleepy devices cover a full idle interval, and a timeout does not put them into backoff.
- A window sensor that has not reported for 15 minutes (was 10) counts as closed and now raises a fault.

## 2.2.1

### Fixed
- Hubs on another VLAN were unreachable after the matter.js 0.17 update: 0.17 tries IPv6
  addresses first and waits 45 s before the next address (2 min after ENETUNREACH), so the working
  IPv4 address was never tried within the read timeout. The next address is now tried after 3 s.
- The fixed IP address of a device moves to its new node id when the device is paired again
  (settings page and runtime).

## 2.2.0

### Added
- **Pair and remove devices while the plugin runs.** The running plugin offers its Matter
  controller to the settings page through a local-only (127.0.0.1), token-protected API
  (`vthermo-matter/control.json`, readable only by the Homebridge user). Scans on the settings page
  are live instead of cached while the bridge runs.
- **Instant updates (experimental, `instantUpdates`)**: Matter subscriptions for window sensors and
  relays trigger a control cycle within about a second. Polling continues as a fallback, and a
  failed subscription is retried in the background.
- **Eve history (`enableHistory`)**: temperature, target and heating graphs in the Eve app.

### Changed
- Updated to **matter.js 0.17** (the version Homebridge 2.4 uses). Existing pairings are kept and
  keep their node ids. After updating, going back to 1.x/2.1.x is not supported.
- Paired node names come from the device after the structure read.

## 2.1.0

### Added
- **Live status** on the settings page: current and target temperature, humidity, relay state,
  window state, per-sensor readings and errors for each thermostat, refreshed every 10 s while the
  plugin runs (the plugin writes `vthermo-matter/status.json`).
- **Automatic reconnect after re-pairing**: devices that got a new Matter node id are found again by
  unique id / serial number, both at runtime and on the settings page (save to make it permanent).
- **Clear "pairing lost" message** when a device rejects the controller (`NoSharedTrustRoots`)
  instead of a generic "not reachable".
- **Boiler protection**: minimum relay on-time and off-time (`minOnMinutes`, `minOffMinutes`); a
  shared relay uses the strictest setting of its thermostats.
- **Frost protection** (`frostProtectionTemperature`): heats below this temperature even when the
  thermostat is off or a window is open.
- **Per-sensor calibration offset** for temperature sources.
- **Humidity** (`humiditySource`) shown on the thermostat in Apple Home.

## 2.0.5

### Added
- Buy Me a Coffee link (Donate button in the Homebridge UI, npm and GitHub Sponsor button).

## 2.0.4

### Fixed
- Matter nodes with an empty node label (e.g. Aqara hubs) were shown by their internal id
  ("peer1") instead of their product name.

## 2.0.3

### Changed
- The settings page no longer blocks with a spinner while a live Matter scan runs in the background
  (when a previous scan is shown). Pairing buttons are disabled until the scan finishes.
- Commissionable discovery now runs in parallel with reading the paired nodes, so a scan is ~12 s faster.

## 2.0.2

### Fixed
- After (re)pairing a Matter bridge only part of its devices appeared on the settings page. The
  settings-page scan now always reads the full node structure instead of skipping it when some
  endpoints were already known.

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
