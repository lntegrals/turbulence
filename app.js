import {
  buildRouteSamplePoints,
  extractWeatherFeatures,
  riskToColor,
  scoreTurbulenceRisk,
} from './turbulence.js';

const REFRESH_MS = 15000;
const OPENSKY_URL = 'https://opensky-network.org/api/states/all';
const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
const WEATHER_TTL_MS = 3 * 60 * 1000;
const MAX_LEADERBOARD_ROWS = 8;
const MAX_LEADERBOARD_ASYNC_FETCH = 20;

const state = {
  map: null,
  markersByIcao: new Map(),
  selectedIcao: null,
  aircraftByIcao: new Map(),
  aircraftRiskByIcao: new Map(),
  weatherCache: new Map(),
  refreshTimer: null,
};

const ui = {
  statusText: document.getElementById('status-text'),
  liveCount: document.getElementById('live-count'),
  selectedFlight: document.getElementById('selected-flight'),
  mode: document.getElementById('mode-pill'),
  panel: document.getElementById('sheet'),
  sheetContent: document.getElementById('sheet-content'),
  sheetHandle: document.getElementById('sheet-handle'),
  leaderboardList: document.getElementById('leaderboard-list'),
  leaderboardToggle: document.getElementById('leaderboard-toggle'),
};

function initMap() {
  state.map = L.map('map', {
    worldCopyJump: true,
    preferCanvas: true,
    zoomControl: false,
    tapTolerance: 25,
  }).setView([20, 0], 2);

  L.control.zoom({ position: 'topright' }).addTo(state.map);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 8,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(state.map);
}

function setStatus(text) {
  ui.statusText.textContent = text;
}

function setTopBarMeta({ count, selected, mode } = {}) {
  if (typeof count === 'number') ui.liveCount.textContent = String(count);
  if (typeof selected === 'string') ui.selectedFlight.textContent = selected || 'None';
  if (typeof mode === 'string') ui.mode.textContent = mode;
}

function isValidCoord(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon);
}

function getAircraftRecord(raw) {
  return {
    icao24: raw[0],
    callsign: (raw[1] || '').trim() || 'N/A',
    originCountry: raw[2] || 'Unknown',
    longitude: raw[5],
    latitude: raw[6],
    baroAltitudeM: raw[7],
    velocityMs: raw[9],
    trueTrack: raw[10],
  };
}

function formatAltitudeMetersToFeet(meters) {
  if (typeof meters !== 'number') return 'N/A';
  return `${Math.round(meters * 3.28084).toLocaleString()} ft`;
}

function formatSpeedMsToKnots(speedMs) {
  if (typeof speedMs !== 'number') return 'N/A';
  return `${Math.round(speedMs * 1.94384)} kt`;
}

function markerHtml(aircraft) {
  const risk = state.aircraftRiskByIcao.get(aircraft.icao24);
  const badge = risk ? `${risk.label} (${risk.score})` : 'Estimating…';
  return `<b>${aircraft.callsign === 'N/A' ? aircraft.icao24 : aircraft.callsign}</b><br>${badge}`;
}

function roundedCoordKey(lat, lon) {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

function weatherUrl(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current:
      'wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,cape',
    hourly:
      'wind_speed_500hPa,wind_speed_700hPa,wind_speed_850hPa,cloud_cover,cape',
    wind_speed_unit: 'ms',
    forecast_days: '1',
    timezone: 'UTC',
  });
  return `${OPEN_METEO_BASE}?${params.toString()}`;
}

async function fetchWeatherFeatures(lat, lon) {
  const key = roundedCoordKey(lat, lon);
  const now = Date.now();
  const cached = state.weatherCache.get(key);

  if (cached && cached.expiresAt > now && cached.features) {
    return cached.features;
  }

  if (cached?.promise) {
    return cached.promise;
  }

  const promise = (async () => {
    const res = await fetch(weatherUrl(lat, lon));
    if (!res.ok) throw new Error(`Open-Meteo request failed (${res.status})`);
    const weatherJson = await res.json();
    const features = extractWeatherFeatures(weatherJson);

    state.weatherCache.set(key, {
      features,
      expiresAt: Date.now() + WEATHER_TTL_MS,
    });

    return features;
  })();

  state.weatherCache.set(key, {
    promise,
    expiresAt: now + 30_000,
  });

  try {
    return await promise;
  } finally {
    const latest = state.weatherCache.get(key);
    if (latest?.promise === promise && !latest.features) {
      state.weatherCache.delete(key);
    }
  }
}

async function estimateCurrentRisk(aircraft) {
  const features = await fetchWeatherFeatures(aircraft.latitude, aircraft.longitude);
  const risk = scoreTurbulenceRisk(features);
  return { risk, features };
}

async function estimateRiskAhead(aircraft) {
  const points = buildRouteSamplePoints(aircraft, [0, 25, 50, 100]);
  const results = await Promise.all(
    points.map(async (point) => {
      const features = await fetchWeatherFeatures(point.latitude, point.longitude);
      const risk = scoreTurbulenceRisk(features);
      return { ...point, risk, features };
    })
  );

  return results;
}

function markerStyleFor(aircraft) {
  const risk = state.aircraftRiskByIcao.get(aircraft.icao24);
  const isSelected = state.selectedIcao === aircraft.icao24;
  const color = risk ? riskToColor(risk.label) : '#94a3b8';

  return {
    radius: isSelected ? 8 : 6,
    weight: isSelected ? 2.5 : 1.5,
    color,
    fillColor: color,
    fillOpacity: isSelected ? 1 : 0.85,
  };
}

function upsertMarker(aircraft) {
  const existing = state.markersByIcao.get(aircraft.icao24);
  if (existing) {
    existing.aircraft = aircraft;
    existing.setLatLng([aircraft.latitude, aircraft.longitude]);
    existing.setPopupContent(markerHtml(aircraft));
    existing.setStyle(markerStyleFor(aircraft));
    return;
  }

  const marker = L.circleMarker(
    [aircraft.latitude, aircraft.longitude],
    markerStyleFor(aircraft)
  )
    .bindPopup(markerHtml(aircraft), { closeButton: false, offset: [0, -6] })
    .addTo(state.map);

  marker.aircraft = aircraft;
  marker.on('click', () => onAircraftSelected(marker.aircraft));
  state.markersByIcao.set(aircraft.icao24, marker);
}

function syncMarkers(activeAircraft) {
  const seen = new Set();

  activeAircraft.forEach((aircraft) => {
    if (!isValidCoord(aircraft.latitude, aircraft.longitude)) return;
    seen.add(aircraft.icao24);
    upsertMarker(aircraft);
  });

  for (const [icao, marker] of state.markersByIcao.entries()) {
    if (!seen.has(icao)) {
      marker.remove();
      state.markersByIcao.delete(icao);
      state.aircraftRiskByIcao.delete(icao);
      state.aircraftByIcao.delete(icao);
    }
  }
}

async function fetchAircraftStates() {
  const res = await fetch(OPENSKY_URL);
  if (!res.ok) throw new Error(`OpenSky request failed (${res.status})`);

  const payload = await res.json();
  const records = Array.isArray(payload.states)
    ? payload.states.map(getAircraftRecord)
    : [];

  return records.filter((a) => isValidCoord(a.latitude, a.longitude));
}

function riskBadgeClass(label) {
  if (label === 'High') return 'high';
  if (label === 'Moderate') return 'moderate';
  return 'low';
}

function renderLoading(message = 'Loading…') {
  ui.sheetContent.innerHTML = `<div class="state-card">${message}</div>`;
}

function renderError(message) {
  ui.sheetContent.innerHTML = `<div class="state-card error">${message}</div>`;
}

function renderEmpty(message) {
  ui.sheetContent.innerHTML = `<div class="state-card">${message}</div>`;
}

function renderAircraftDetails(aircraft, currentRisk, features, aheadSamples) {
  const summary = aheadSamples
    .map(
      (sample) =>
        `<div class="ahead-stop ${riskBadgeClass(sample.risk.label)}">
          <span>${sample.distanceKm}km</span>
          <strong>${sample.risk.score}</strong>
        </div>`
    )
    .join('');

  ui.sheetContent.innerHTML = `
    <section class="card">
      <h2>${aircraft.callsign === 'N/A' ? aircraft.icao24 : aircraft.callsign}</h2>
      <p class="subtle">${aircraft.originCountry}</p>
      <div class="data-grid">
        <div><div class="key">Altitude</div><div class="value">${formatAltitudeMetersToFeet(aircraft.baroAltitudeM)}</div></div>
        <div><div class="key">Speed</div><div class="value">${formatSpeedMsToKnots(aircraft.velocityMs)}</div></div>
        <div><div class="key">Track</div><div class="value">${Number.isFinite(aircraft.trueTrack) ? `${Math.round(aircraft.trueTrack)}°` : 'N/A'}</div></div>
        <div><div class="key">Current Risk</div><div class="value"><span class="badge ${riskBadgeClass(currentRisk.label)}">${currentRisk.label} ${currentRisk.score}</span></div></div>
      </div>
    </section>

    <section class="card">
      <h3>Risk Ahead</h3>
      <div class="ahead-strip">${summary}</div>
      <p class="subtle">Projected along current track at 0 / +25 / +50 / +100 km.</p>
    </section>

    <section class="card">
      <h3>Why this score?</h3>
      <ul class="explain-list">${currentRisk.factors.map((item) => `<li>${item}</li>`).join('')}</ul>
      <p class="subtle">Inputs: wind ${features.windSpeed10m ?? 'N/A'} m/s, gust ${features.gusts10m ?? 'N/A'} m/s, cloud ${features.cloudCover ?? 'N/A'}%, CAPE ${features.cape ?? 'N/A'} J/kg.</p>
      <p class="disclaimer">Estimated turbulence-risk visualization only. Not a flight-safety or operational aviation system.</p>
    </section>
  `;
}

function updateLeaderboard() {
  const rows = [...state.aircraftByIcao.values()]
    .map((aircraft) => {
      const risk = state.aircraftRiskByIcao.get(aircraft.icao24);
      return risk ? { aircraft, risk } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.risk.score - a.risk.score)
    .slice(0, MAX_LEADERBOARD_ROWS);

  if (!rows.length) {
    ui.leaderboardList.innerHTML = '<li class="empty-row">No ranked flights yet.</li>';
    return;
  }

  ui.leaderboardList.innerHTML = rows
    .map(({ aircraft, risk }) => {
      const callsign = aircraft.callsign === 'N/A' ? aircraft.icao24 : aircraft.callsign;
      return `<li>
        <button class="leader-item" data-icao="${aircraft.icao24}">
          <div>
            <strong>${callsign}</strong>
            <span>${aircraft.originCountry}</span>
          </div>
          <div>
            <span>${formatAltitudeMetersToFeet(aircraft.baroAltitudeM)}</span>
            <span class="badge ${riskBadgeClass(risk.label)}">${risk.score}</span>
          </div>
        </button>
      </li>`;
    })
    .join('');
}

async function hydrateVisibleAircraftRisk() {
  const bounds = state.map.getBounds();
  const visibles = [...state.aircraftByIcao.values()]
    .filter((a) => bounds.contains([a.latitude, a.longitude]))
    .slice(0, MAX_LEADERBOARD_ASYNC_FETCH);

  await Promise.all(
    visibles.map(async (aircraft) => {
      if (state.aircraftRiskByIcao.has(aircraft.icao24)) return;
      try {
        const { risk } = await estimateCurrentRisk(aircraft);
        state.aircraftRiskByIcao.set(aircraft.icao24, risk);
        const marker = state.markersByIcao.get(aircraft.icao24);
        if (marker) {
          marker.setStyle(markerStyleFor(aircraft));
          marker.setPopupContent(markerHtml(aircraft));
        }
      } catch (_) {
        // Skip failures silently for non-selected flights.
      }
    })
  );

  updateLeaderboard();
}

async function onAircraftSelected(aircraft) {
  state.selectedIcao = aircraft.icao24;
  setTopBarMeta({ selected: aircraft.callsign === 'N/A' ? aircraft.icao24 : aircraft.callsign });
  renderLoading('Calculating turbulence indicators…');
  ui.panel.classList.add('open');

  for (const [icao, marker] of state.markersByIcao.entries()) {
    marker.setStyle(markerStyleFor(marker.aircraft));
    if (icao === aircraft.icao24) marker.bringToFront();
  }

  try {
    const [{ risk, features }, aheadSamples] = await Promise.all([
      estimateCurrentRisk(aircraft),
      estimateRiskAhead(aircraft),
    ]);

    state.aircraftRiskByIcao.set(aircraft.icao24, risk);
    const marker = state.markersByIcao.get(aircraft.icao24);
    if (marker) {
      marker.setStyle(markerStyleFor(aircraft));
      marker.setPopupContent(markerHtml(aircraft));
    }

    renderAircraftDetails(aircraft, risk, features, aheadSamples);
    setStatus('Weather loaded and turbulence risk estimated.');
    updateLeaderboard();
  } catch (err) {
    console.error(err);
    renderError('Unable to load weather for this flight right now.');
    setStatus(`Weather lookup failed: ${err.message}`);
  }
}

async function refreshAircraft() {
  try {
    setStatus('Updating aircraft positions…');
    const aircraftList = await fetchAircraftStates();
    state.aircraftByIcao = new Map(aircraftList.map((a) => [a.icao24, a]));

    syncMarkers(aircraftList);
    setTopBarMeta({ count: aircraftList.length, mode: 'Heuristic v2' });
    setStatus(`Updated at ${new Date().toLocaleTimeString()}`);

    if (!aircraftList.length) {
      renderEmpty('No live flights available in the current feed.');
    }

    if (state.selectedIcao) {
      const updated = state.aircraftByIcao.get(state.selectedIcao);
      if (updated) {
        await onAircraftSelected(updated);
      } else {
        setTopBarMeta({ selected: 'None' });
        state.selectedIcao = null;
        renderEmpty('Selected flight left the current feed.');
      }
    }

    hydrateVisibleAircraftRisk();
  } catch (err) {
    console.error(err);
    setStatus(`Unable to refresh aircraft data: ${err.message}`);
    renderError('Live data failed to load. Please retry in a moment.');
  }
}

function setupUiHandlers() {
  ui.sheetHandle.addEventListener('click', () => {
    ui.panel.classList.toggle('open');
  });

  ui.leaderboardToggle.addEventListener('click', () => {
    document.getElementById('leaderboard').classList.toggle('collapsed');
  });

  ui.leaderboardList.addEventListener('click', (event) => {
    const button = event.target.closest('.leader-item');
    if (!button) return;

    const aircraft = state.aircraftByIcao.get(button.dataset.icao);
    if (!aircraft) return;

    state.map.flyTo([aircraft.latitude, aircraft.longitude], Math.max(5, state.map.getZoom()));
    onAircraftSelected(aircraft);
  });

  state.map?.on('moveend', () => {
    hydrateVisibleAircraftRisk();
  });
}

async function init() {
  initMap();
  renderLoading('Loading live aircraft…');
  setupUiHandlers();
  await refreshAircraft();
  state.refreshTimer = setInterval(refreshAircraft, REFRESH_MS);
}

init();
