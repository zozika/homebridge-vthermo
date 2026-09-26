# homebridge-vthermo

A virtual heating thermostat for [Homebridge](https://homebridge.io) (v1.8+ and v2) that uses
**Matter** devices: it reads Matter temperature sensors (and optional door/window sensors) and
switches a Matter On/Off relay or plug. The thermostat shows up in Apple Home like a normal one.

[![npm](https://img.shields.io/npm/v/homebridge-vthermo)](https://www.npmjs.com/package/homebridge-vthermo)
[![Build and test](https://github.com/zozika/homebridge-vthermo/actions/workflows/build.yml/badge.svg)](https://github.com/zozika/homebridge-vthermo/actions/workflows/build.yml)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-☕-yellow)](https://www.buymeacoffee.com/palmaiz)

> 🇭🇺 Magyar leírás lent: [Magyarul](#magyarul)

## Features

- Multiple thermostats in one platform
- One or more temperature sources per thermostat, combined as average, minimum or maximum
- If a source does not answer, the others are used; the last good reading is kept for 10 minutes
- Heating pauses while any selected door/window sensor is open
- Hysteresis band and a configurable check interval
- Several thermostats can share one relay (e.g. one boiler): it stays on while any of them needs heat
- Optional relay retry after a cut-out (relay switched itself off while heat was still needed)
- Built-in Matter controller: pair Matter devices or bridges (e.g. Aqara Hub M2) from the settings page
- Settings page in English or Hungarian
- Fail-safe: if no temperature can be read, heating is switched off and the thermostat shows a fault in Apple Home
- Boiler protection: minimum relay on-time and off-time
- Frost protection: heats below a set temperature even when the thermostat is off or a window is open
- Per-sensor calibration offset, optional humidity shown on the thermostat
- Live status on the settings page (temperatures, relay, window, errors) while the plugin runs
- Devices that were paired again are reconnected to your thermostats automatically
- Pair and remove Matter devices while the plugin is running
- Optional instant updates for window sensors and relays (Matter subscriptions, experimental)
- Optional Eve app history graphs

## Install

From the Homebridge UI search for `homebridge-vthermo`, or from a local package:

```bash
npm install -g ./homebridge-vthermo-2.0.0.tgz
```

Running the plugin as a **child bridge** is recommended.

## Setup

1. Open the Vthermo plugin settings in the Homebridge UI.
2. Pair your Matter device or bridge: pick it from *Discovered Matter nodes* or use *Pair by Matter code*
   (Apple Home → device → *Turn On Pairing Mode* gives you a code for an extra controller).
3. Add a thermostat, then pick its temperature sources, the relay and optional window sensors.
4. Save and restart the Vthermo child bridge.

**Pairing while the plugin is running:** the settings page talks to the running plugin through a
local-only (127.0.0.1), token-protected connection, so you can pair and remove devices without
stopping anything. When the plugin is not running, the settings page uses the Matter controller itself.

## Troubleshooting

**“… is not reachable” / `Resume failed … Operation timed out`**: Homebridge cannot reach the
Matter device at its stored address. Usually the device got a new IP address or it is on a
different subnet/VLAN than Homebridge (mDNS discovery does not cross subnets). Check from the
Homebridge host:

```bash
ping <device-ip>
```

```bash
avahi-browse -rt _matter._tcp
```

Fix it with a DHCP reservation for the device. If it lives in another subnet on purpose, enable
an mDNS reflector on your router and allow routing, or set a **fixed address** for the node in the
settings page (`nodeAddressOverrides`).

**“… no longer accepts this controller (NoSharedTrustRoots)”**: the device lost its Matter pairing
(e.g. after a reset or when the controller was removed in the Aqara/Apple Home app). Remove the
pairing in the settings and pair the device again; your thermostat selections are reconnected
automatically.

**Detailed logging**: turn on *Detailed logging* in the settings. For deep Matter protocol traces
start Homebridge with `MATTER_LOG_LEVEL=debug`.

## Configuration

The settings page writes the config for you. Reference:

| Option | Default | Description |
| --- | --- | --- |
| `language` | `auto` | Settings page language: `auto`, `en`, `hu` |
| `enableVerboseLogging` | `false` | Detailed runtime logs |
| `instantUpdates` | `false` | Experimental: Matter subscriptions for window sensors and relays |
| `enableHistory` | `false` | Eve app history (stored under `vthermo-history/`) |
| `nodeAddressOverrides` | `[]` | `[{ "nodeId": "...", "address": "192.168.1.68:5540" }]` fixed addresses for nodes mDNS cannot find |
| `thermostats[].name` | | Name in Apple Home |
| `thermostats[].temperatureSources` | | Matter temperature endpoints (selected in the UI) |
| `thermostats[].temperatureAggregation` | `average` | `average`, `minimum`, `maximum` |
| `thermostats[].switchTarget` | | Matter On/Off endpoint (relay, plug) |
| `thermostats[].contactSensors` | `[]` | Matter contact sensors that pause heating while open |
| `thermostats[].hysteresis` | `0.5` | Total band in °C (0.1–5) |
| `thermostats[].checkIntervalSeconds` | `30` | Control cycle interval (5–3600 s) |
| `thermostats[].relayRetryEnabled` | `false` | Switch the relay on again after a cut-out |
| `thermostats[].relayRetryDelayMinutes` | `5` | Wait time before the retry (1–180 min) |
| `thermostats[].defaultTargetTemperature` | `21` | Initial target |
| `thermostats[].minTargetTemperature` / `maxTargetTemperature` | `10` / `30` | Allowed target range (5–35 °C) |
| `thermostats[].minOnMinutes` / `minOffMinutes` | `0` / `0` | Boiler protection: minimum relay on/off time (0–60 min) |
| `thermostats[].frostProtectionTemperature` | `0` | Heat below this even when off or a window is open (0 = disabled, 3–15 °C) |
| `thermostats[].humiditySource` | | Optional Matter humidity endpoint shown on the thermostat |
| `temperatureSources[].offset` | | Per-sensor calibration in °C (−10…10), set on the settings page |

Matter controller state is stored in the Homebridge storage folder under `vthermo-matter/`.

## Support

If Vthermo keeps your home warm, you can [buy me a coffee](https://www.buymeacoffee.com/palmaiz) ☕. Thank you!

## Development

```bash
npm install
npm test
npm pack
```

---

## Magyarul

Virtuális fűtési termosztát Homebridge-hez (v1.8+ és v2), ami **Matter** eszközökkel dolgozik:
Matter hőmérséklet-érzékelőket (és opcionálisan ajtó/ablak érzékelőket) olvas, és egy Matter
On/Off relét vagy konnektort kapcsol. Az Apple Home-ban normál termosztátként jelenik meg.

### Tudja

- Több termosztát egy platformon
- Termosztátonként több hőmérséklet-forrás (átlag, minimum vagy maximum)
- Ha egy forrás nem válaszol, a többit használja; az utolsó jó értéket 10 percig megtartja
- Nyitott ajtó/ablak esetén a fűtés szünetel
- Hiszterézis és állítható ellenőrzési időköz
- Több termosztát használhatja ugyanazt a relét (pl. egy kazán): addig marad bekapcsolva, amíg bármelyiknek fűtés kell
- Opcionális relé újrakapcsolás, ha a relé magától kikapcsol (pl. kazánvédelem)
- Beépített Matter vezérlő: Matter eszközök vagy bridge-ek (pl. Aqara Hub M2) párosítása a beállítások oldalon
- Magyar vagy angol beállítások oldal
- Biztonság: ha egyik hőmérséklet sem olvasható, kikapcsolja a fűtést és hibát jelez az Apple Home-ban
- Kazánvédelem: minimális bekapcsolt és kikapcsolt relé idő
- Fagyvédelem: kikapcsolt termosztát vagy nyitott ablak mellett is fűt egy beállított hőmérséklet alatt
- Érzékelőnkénti korrekció, opcionális páratartalom a termosztáton
- Élő állapot a beállítások oldalon (hőmérsékletek, relé, ablak, hibák), miközben a plugin fut
- Az újrapárosított eszközök automatikusan visszakerülnek a termosztátokhoz
- Párosítás és törlés a plugin leállítása nélkül
- Opcionális azonnali frissítés ablakérzékelőkre és relékre (Matter feliratkozás, kísérleti)
- Opcionális Eve app előzménygrafikonok

### Beállítás

1. Nyisd meg a Vthermo plugin beállításait a Homebridge UI-ban.
2. Párosítsd a Matter eszközt vagy bridge-et: válaszd ki a *Talált Matter eszközök* közül, vagy használd a *Párosítás Matter kóddal* részt
   (Apple Home → eszköz → *Párosítási mód bekapcsolása* ad kódot egy további vezérlőhöz).
3. Adj hozzá termosztátot, és válaszd ki a hőmérséklet-forrásokat, a relét és az opcionális ablakérzékelőket.
4. Mentsd el, és indítsd újra a Vthermo child bridge-et.

**Párosítás futó plugin mellett:** a beállítások oldal egy csak helyi (127.0.0.1), tokennel védett
kapcsolaton át a futó pluginnal párosít, így semmit sem kell leállítani.

### Hibaelhárítás

**„… is not reachable” / `Resume failed … Operation timed out`**: a Homebridge nem éri el a Matter
eszközt a tárolt címen. Általában új IP címet kapott, vagy más alhálózaton/VLAN-on van, mint a
Homebridge (az mDNS nem megy át alhálózatok között). Ellenőrizd a Homebridge gépről a `ping` és az
`avahi-browse -rt _matter._tcp` paranccsal. Megoldás: fix DHCP cím az eszköznek, mDNS reflektor a
routeren, vagy **fix cím** megadása a beállítások oldalon.

### Támogatás

Ha a Vthermo melegen tartja az otthonod, meghívhatsz egy [kávéra](https://www.buymeacoffee.com/palmaiz) ☕. Köszönöm!
