# DYP — Winter Bathing Journal (v1.1.0)

A private, offline-first, installable iPhone web app (PWA) built with plain HTML, CSS, and JavaScript. No build step, login, external libraries, analytics, or server database.

## Features

- Manual winter bathing sessions, including date and time, immersion duration, water temperature (°C), bathing spot, optional GPS coordinates, air temperature (°C), wind speed (m/s), wind direction, weather condition, and notes.
- Stopwatch with start, pause, resume, and finish-to-log. It calculates elapsed **wall-clock time** so it catches up if Safari is suspended or the phone screen is locked. It **does not automatically detect entering/exiting the water**.
- Local IndexedDB history with edit, delete, search, and a seasonal dashboard. A season runs **September 1–August 31**.
- CSV export for analysis. JSON backup/export and merge-only JSON restore to protect against data loss.
- Offline support after first online visit and service worker install; optional geolocation is requested only when you tap the GPS button.

## Install on iPhone (GitHub Pages)

You must host the app over **HTTPS** to enable the service worker and GPS. GitHub Pages is free and works with these files.

1. Create a GitHub repository, for example `dyp`.
2. Unzip `dyp-pwa.zip`. Upload **the contents** of the `dyp-pwa` directory (`index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, `icons/`, etc.) into the repository root. Don't upload a nested `dyp-pwa` directory.
3. In the repository's **Settings → Pages**, choose **Deploy from a branch**, branch **main**, folder **/(root)**. Save.
4. Open `https://YOUR-USERNAME.github.io/dyp/` in **Safari** on the iPhone. (GitHub Pages can take time to finish deploying; use the URL shown on the Pages settings page.)
5. Tap Safari's **Share** button → **Add to Home Screen** → **Add**. If offered an **Open as Web App** toggle, enable it.
6. Open DYP from the Home Screen once while online to initialize the app; it will subsequently load and save records offline.

Important: a file opened directly from the Files app (`file://`) is **not** an installable, offline-ready PWA. Host it first. Your browser and installed Home Screen app may have **separate storage**, so install before logging significant data and export regular JSON backups.

## Local desktop testing

From the directory that contains `index.html`:

```sh
python3 -m http.server 8080
```

Open `http://localhost:8080/`. Localhost supports service worker registration. To test offline, load it once online, then disable networking in browser dev tools and reload.

## Session data model

IndexedDB database `dyp-winter-bathing`, object store `sessions`, key path `id` (UUID). A stored session resembles:

```json
{
  "id": "95e19f0c-2edf-48d7-8caf-c0c5563f0452",
  "schemaVersion": 1,
  "startedAt": "2026-10-19T08:20:00.000Z",
  "durationSeconds": 74,
  "waterTemperatureC": 10.2,
  "location": {
    "name": "Islands Brygge",
    "latitude": 55.6651,
    "longitude": 12.5741,
    "accuracyMeters": 18
  },
  "weather": {
    "airTemperatureC": 8.4,
    "windSpeedMs": 3.2,
    "windDirection": "NW",
    "condition": "cloudy"
  },
  "notes": "A calm morning.",
  "source": "stopwatch",
  "createdAt": "2026-10-19T08:22:00.000Z",
  "updatedAt": "2026-10-19T08:22:00.000Z",
  "timeZone": "Europe/Copenhagen"
}
```

`startedAt`, `createdAt`, and `updatedAt` use ISO 8601 UTC. Numeric temperature/condition fields are nullable, and unknown measurements are **not treated as zero**. Coordinates are nullable, GPS is optional. `source` is `stopwatch` or `manual`. Local timezone is the timezone of the device when saved.

CSV includes ISO UTC and a local date/time rendering in the recorded session timezone for convenience. Text fields beginning with spreadsheet formula trigger characters get a leading apostrophe in CSV to protect spreadsheet imports; the unmodified value remains in JSON.

## How it works offline / privacy

- App shell is cached by a versioned service worker. The app fetches Open-Meteo only on request.
- Journal records are in device-local IndexedDB; stopwatch and unsaved new-session draft state are kept in device-local localStorage.
- No account/sync is provided. Clearing Safari's website data, iPhone storage pressure, or deleting an installed web app can erase local data. Export JSON backups routinely (e.g., after every few dips).
- GPS needs user permission and a secure context. Water temperature, air temperature, wind and weather are editable manual entries; the GPS button can auto-fill estimates from Open-Meteo when online. The coordinates and date are sent to Open-Meteo (not your private journal). Open-Meteo Marine sea-surface temperature is a **modelled offshore estimate**, not a bathing spot measurement and not applicable to freshwater. Data for older than 7 days are not automatically fetched.
- To publish changes, increase the cache version in `sw.js`; installed clients will get the new cached shell after they reconnect and reload.

## Safety

Winter bathing and cold-water immersion can be dangerous. The timer is observational, not a target; it does not measure your physiological condition and cannot detect an emergency. Never winter bathe alone.

## Files

- `index.html`: UI structure
- `styles.css`: responsive layout and visual styling
- `app.js`: data model, IndexedDB operations, timer, views, import/export
- `sw.js`: offline app-shell service worker
- `manifest.webmanifest`: installation metadata
- `icons/`: app icons and SVG favicon

## Update v1.0.1 — iPhone date/time input width

Fixes the iOS Safari datetime-local input extending beyond the right edge of its card.
The form and datetime input now shrink to their container, and the datetime label clips Safari's oversized native input.
The stylesheet URL and service worker cache were versioned to ensure GitHub Pages and installed apps pick up the fix.

For existing GitHub Pages deployments, replace `index.html`, `styles.css`, and `sw.js` in the repository root, then reload the live app online (sometimes twice). Saved sessions are unaffected.

## Update v1.1.0 — Automatic sea and weather conditions

- In Log a dip → Where, tap **Use GPS & get conditions**. iOS will ask for location permission. The app sends requested coordinates to Open-Meteo Weather and Marine APIs, returning temperature (°C), wind (m/s), direction and condition, plus a **modelled sea-surface temperature**.
- The lookup uses the **session time** (nearest weather hour or nearest marine model value, which can be several hours old) if the session is within the last 7 days. Historical dips further back require manual values. Water temperatures come from offshore sea-surface model cells, not water thermometers. Marine results >25 km from requested GPS point are rejected. **Not for freshwater or enclosed bathing basins.**
- **Refresh conditions** repeats lookup for the currently saved GPS coordinates. Manually entered values are never overwritten automatically; to replace a manual value, clear it and refresh.
- Session-level `measurements` metadata captures which values came from Open-Meteo, their time and (for water) grid distance. CSV export includes water/air origins and time. JSON backup and restore preserve metadata; old v1 data still loads.
- Works offline exactly as before for session logging, history, timer, exports. Remote estimates require a network connection. Open-Meteo receives coordinates and session time when requested, as described in the app.
- Existing GitHub Pages deployment: replace **index.html, app.js, styles.css, sw.js** with the updated files at the repository root. No need to delete sessions or change the URL. When served via Pages, an existing cached app may need to be reloaded twice after the new service worker activates.

Data attribution: [Open-Meteo Weather](https://open-meteo.com/en/docs) and [Open-Meteo Marine](https://open-meteo.com/en/docs/marine-weather-api). See their terms for non-commercial API use and attribution; marine data documentation also calls for DWD acknowledgement.


## DMI station observations (v1.2)

- **DMI Open Data** is attempted first for `tw` (coastal/harbour water temperature),
  `temp_dry`, `wind_speed`, and `wind_dir`. Station IDs, names, observation timestamps,
  and approximate distances accompany each successful result. DMI reports observations,
  **not** exact bathing-spot readings; water gauges can measure below the surface.
- **Open-Meteo** is also requested to provide a model-based sky/weather description
  and to fill the individual fields for which DMI has no sufficiently recent/nearby
  data. A model estimate is never labelled as a DMI measurement.
- Lookup is only initiated by the user, limited to dips in the past seven days, and
  requires a network connection. DMI searches use a 75-minute window around the
  session, with maximum station distances of 45 km (water) and 35 km (air/wind).
- All automatic values are editable, and manually entered values are **never silently overwritten**.
  Each value preserves its source metadata through JSON backups and CSV exports.
- Works with the existing v1.1 IndexedDB records (same schema version, no destructive migration).
- Browser limitations: direct DMI requests from GitHub Pages require DMI's browser
  CORS headers. If the browser blocks DMI or the API is down, DYP falls back to
  Open-Meteo where possible. Live iPhone/browser verification is still required.
- Only GPS coordinates and session time are sent to weather providers, not personal
  notes or the journal's history. No API key or server is required.

DMI documentation:
- https://www.dmi.dk/friedata/dokumentation/apis/oceanographic-observation-and-tidewater-api
- https://www.dmi.dk/friedata/dokumentation/meteorological-observation-api
- https://www.dmi.dk/friedata/dokumentation/authentication
