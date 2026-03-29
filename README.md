# Live Turbulence Risk Estimator (Frontend)

A lightweight, frontend-first Leaflet app that visualizes live aircraft and estimated turbulence risk using OpenSky + Open-Meteo.

## Highlights (V2)

- Mobile-first responsive layout with:
  - compact top status bar
  - thumb-friendly controls
  - collapsible mobile bottom sheet for flight details
  - collapsible "Roughest Flights Right Now" leaderboard
- Dark aviation-style visual design with subtle radar-like overlays.
- Efficient marker upsert/update flow (no full marker recreation every refresh).
- Color-coded aircraft markers by risk (low/moderate/high).
- Route sampling ahead of selected aircraft at 0 / +25 / +50 / +100 km.
- Explainable turbulence heuristic with plain-English factor descriptions.
- Loading, empty, and error states optimized for small screens.
- Weather lookup cache by rounded coordinates to reduce duplicate requests.

## Data sources

- OpenSky Network: aircraft states.
- Open-Meteo: weather variables used in heuristic scoring.

## Important disclaimer

This tool is an **estimated turbulence-risk visualization** for education and exploration only.
It is **not** a flight-safety, dispatch, or operational aviation system.

## Run locally

Because this app calls external APIs, run from a local web server (not `file://`).

### Option 1: Python

```bash
python3 -m http.server 8080
```

Open: `http://localhost:8080`

### Option 2: Node (if installed)

```bash
npx serve .
```
