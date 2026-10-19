# DYP — Winter Bathing Journal v1.4.0

## What changed in 1.4

- **No 8 km cutoff.** The app queries current DMI `tw` observations across a broad **110 km discovery radius**, but proximity does not determine automatic water-station selection.
- **Conservative coastal-area selection.** An initial *provisional* Sejerø Bugt / Ordrup Strand coastal mapping gives priority to Sjællands Odde / Havnebyen / Sejerø-labelled stations **only when they actually return a recent DMI water-temperature observation**. No such reading means no DMI value is inferred. This is not a verified hydrodynamic classification. Other coasts default to a labelled Open-Meteo estimate unless a station is chosen by the user. Future releases can add verified mappings.
- **Station picker.** After a GPS lookup, DYP lists *reporting* DMI `tw` stations and their distance, temperature and time. You can choose any available station, even farther away, and save it as the preferred station for the named bathing spot (or a roughly 1 km GPS cell when unnamed). The choice is stored on this device and reused on subsequent lookups. If the preferred station lacks a current measurement, DYP uses a clearly labelled marine estimate rather than silently switching to a different harbour.
- **Three modes:** Coastal-aware auto, saved DMI station, or marine model only. Manual temperatures are never overwritten by lookups.
- **Provenance:** CSV/JSON record the chosen station, observation timestamp, selection rule, water-body hint, and whether the station is part of the provisional coastal group. JSON backups also include saved station preferences (old v1 backups still work).
- **Privacy:** GPS and date are transmitted only when the user taps the conditions lookup. The journal and preferences stay on-device. Weather lookup needs internet; the journal remains offline-first.

## How to update GitHub Pages

Export a JSON backup first. In the GitHub repository **root**, replace `index.html`, `app.js`, `styles.css`, and `sw.js` with the files from the GitHub update ZIP. Commit, wait for Pages deployment, then reopen online. The new cache version is `dyp-shell-v1.4.0`. Sessions remain in the existing IndexedDB schema, version 1.

## API limitations

- DMI stations listing alone does not mean they measure `tw`. Only recent, valid `tw` observations appear in the picker.
- DMI water sensors are not necessarily at swimming depth or exposed beaches. A water station in a different bay should not be mistaken for a local temperature even if geographically close.
- Provisional mapping does not claim an objectively verified same-water-body relationship for every station. The user should check the preferred station's name and locality.
- API requests are subject to browser CORS/network access, and the broad discovery request may be paginated or partially incomplete.
- Open-Meteo marine is a modelled sea-surface estimate, not a local measurement. No suitable model reading => field stays empty.

## Existing features retained

- Session logging: date and time, immersion duration, water temperature, optional location name and GPS, air temperature, wind speed, wind direction, weather, and notes.
- Stopwatch: start, pause, resume, and finish-to-log. Elapsed time uses wall-clock time after iOS suspends the app.
- Session history (search, edit, delete) and seasonal summary dashboard.
- CSV export and JSON backup/import; locally stored IndexedDB session records.
- Offline-first installable iPhone PWA with no user account or subscription. Automatic conditions require internet.
- iPhone date/time field layout fix introduced in v1.3.1 is retained.

## Installation

Upload the contents of the complete ZIP to the **root** of your GitHub Pages repository (not a nested directory), or upload the four changed files from the small update ZIP. Publish Pages from branch `main` and folder `/(root)`; visit the HTTPS Pages URL in iPhone Safari and choose Share → Add to Home Screen. After an update, reopen online so the versioned service worker can cache it.

## Session model and backups

The IndexedDB database is `dyp-winter-bathing`, object store `sessions`, schema version 1; no migration is needed. The original fields are unchanged. Each automatically populated water temperature may store `selectionRule`, `coastalArea`, `coastalMatch`, `waterSelectionNote`, and (for DMI) `stationId`, `stationName`, `stationDistanceKm`, `observedAt`. The backup remains `{format:"dyp-backup",schemaVersion:1,sessions:[...]}` with an additional optional `waterStationPreferences` map. Old backups import normally. Import merges by session ID and only adds missing station preferences; existing entries are never overwritten.

Water-station preferences are kept separately in localStorage (`dyp.water-station-prefs.v1`), keyed by normalized bathing-spot name if available, otherwise by a rounded GPS cell. They are included in JSON backups but not directly synced between devices. As in older DYP versions, records in a Home Screen PWA and Safari may not share the same storage. Back up before reinstalling or clearing site data.

## Data sources

- DMI Open Data — <https://www.dmi.dk/friedata/dokumentation/apis/oceanographic-observation-and-tidewater-api>
- DMI Meteorological Observation API — <https://www.dmi.dk/friedata/dokumentation/meteorological-observation-api>
- Open-Meteo Marine — <https://open-meteo.com/en/docs/marine-weather-api>

