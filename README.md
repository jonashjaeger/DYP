# DYP — Winter Bathing Journal (v1.0)

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

- App shell is cached by a versioned service worker. The app does **not** fetch remote APIs.
- Journal records are in device-local IndexedDB; stopwatch and unsaved new-session draft state are kept in device-local localStorage.
- No account/sync is provided. Clearing Safari's website data, iPhone storage pressure, or deleting an installed web app can erase local data. Export JSON backups routinely (e.g., after every few dips).
- GPS needs user permission and a secure context. Water temperature and weather are **manual entries** in v1; no weather or sea-temperature API is called.
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
