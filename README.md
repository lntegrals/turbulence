# Live Turbulence Risk Estimator (Frontend)

A simple vanilla JavaScript web app that visualizes live aircraft and estimates turbulence risk using nearby weather fields.

## Features

- World map rendered with Leaflet.
- Live aircraft positions from OpenSky Network.
- Marker refresh every 15 seconds.
- Side panel for selected aircraft:
  - callsign
  - origin country
  - altitude
  - velocity
  - latitude / longitude
- On aircraft click, app fetches nearby weather from Open-Meteo.
- Turbulence estimate based on:
  - wind speed
  - wind shear between pressure levels
  - CAPE
  - cloud cover
  - gusts
- Risk label: **Low / Moderate / High**.
- Human-readable explanation of score drivers.
- UI disclaimer that this is not a real aviation safety tool.

## Run locally

Because this app calls external APIs, run it from a local web server (not `file://`).

### Option 1: Python

```bash
python3 -m http.server 8080
```

Open: `http://localhost:8080`

### Option 2: Node (if installed)

```bash
npx serve .
```

## Notes

- OpenSky may rate-limit or reject unauthenticated requests.
- Open-Meteo responses depend on model availability for each coordinate.
- The scoring model is intentionally simple and heuristic.
