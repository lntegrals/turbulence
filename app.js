const REFRESH_MS = 15000;
const OPENSKY_URL = 'https://opensky-network.org/api/states/all';
const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';

const state = {
  map: null,
  markersByIcao: new Map(),
  selectedIcao: null,
  selectedAircraftSnapshot: null,
  refreshTimer: null,
};

const ui = {
  panel: document.getElementById('side-panel'),
  panelContent: document.getElementById('panel-content'),
  status: document.getElementById('status-message'),
  closeBtn: document.getElementById('close-panel'),
};

function initMap() {
  state.map = L.map('map', {
    worldCopyJump: true,
    preferCanvas: true,
  }).setView([20, 0], 2);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 8,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(state.map);
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
  const cs = aircraft.callsign === 'N/A' ? aircraft.icao24 : aircraft.callsign;
  return `<b>${cs}</b><br>${aircraft.originCountry}`;
}

function renderPanelBase(aircraft) {
  ui.panel.classList.remove('collapsed');
  ui.panelContent.innerHTML = `
    <div class="data-grid">
      <div><div class="key">Callsign</div><div class="value">${aircraft.callsign}</div></div>
      <div><div class="key">Origin Country</div><div class="value">${aircraft.originCountry}</div></div>
      <div><div class="key">Altitude</div><div class="value">${formatAltitudeMetersToFeet(aircraft.baroAltitudeM)}</div></div>
      <div><div class="key">Velocity</div><div class="value">${formatSpeedMsToKnots(aircraft.velocityMs)}</div></div>
      <div><div class="key">Latitude</div><div class="value">${(aircraft.latitude ?? NaN).toFixed(4)}</div></div>
      <div><div class="key">Longitude</div><div class="value">${(aircraft.longitude ?? NaN).toFixed(4)}</div></div>
    </div>
    <div class="risk" id="risk-box">
      <div class="key">Turbulence Estimate</div>
      <p>Fetching local weather and estimating risk…</p>
    </div>
  `;
}

function setStatus(text) {
  ui.status.textContent = text;
}

function isValidCoord(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon);
}

function upsertMarker(aircraft) {
  const existing = state.markersByIcao.get(aircraft.icao24);
  if (existing) {
    existing.setLatLng([aircraft.latitude, aircraft.longitude]);
    existing.setPopupContent(markerHtml(aircraft));
    existing.aircraft = aircraft;
    return;
  }

  const marker = L.circleMarker([aircraft.latitude, aircraft.longitude], {
    radius: 4,
    weight: 1,
    color: '#0ea5e9',
    fillColor: '#38bdf8',
    fillOpacity: 0.85,
  })
    .bindPopup(markerHtml(aircraft))
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

async function refreshAircraft() {
  try {
    setStatus('Updating aircraft positions…');
    const aircraft = await fetchAircraftStates();
    syncMarkers(aircraft);
    setStatus(`Updated ${aircraft.length} aircraft at ${new Date().toLocaleTimeString()}.`);

    if (state.selectedIcao) {
      const updated = aircraft.find((a) => a.icao24 === state.selectedIcao);
      if (updated) {
        state.selectedAircraftSnapshot = updated;
        renderPanelBase(updated);
        await fetchAndRenderWeatherRisk(updated);
      }
    }
  } catch (err) {
    console.error(err);
    setStatus(`Unable to refresh aircraft data: ${err.message}`);
  }
}

function weatherUrl(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'wind_speed_10m,wind_gusts_10m,cloud_cover,cape',
    hourly:
      'wind_speed_500hPa,wind_speed_700hPa,wind_speed_850hPa,cloud_cover,cape',
    wind_speed_unit: 'ms',
    forecast_days: '1',
    timezone: 'UTC',
  });

  return `${OPEN_METEO_BASE}?${params.toString()}`;
}

function firstValue(arr) {
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}

function toNumberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function extractWeatherFeatures(weatherJson) {
  const current = weatherJson.current || {};
  const hourly = weatherJson.hourly || {};

  const features = {
    windSpeed10m: toNumberOrNull(current.wind_speed_10m),
    gusts10m: toNumberOrNull(current.wind_gusts_10m),
    cloudCover: toNumberOrNull(current.cloud_cover ?? firstValue(hourly.cloud_cover)),
    cape: toNumberOrNull(current.cape ?? firstValue(hourly.cape)),
    wind850: toNumberOrNull(firstValue(hourly.wind_speed_850hPa)),
    wind700: toNumberOrNull(firstValue(hourly.wind_speed_700hPa)),
    wind500: toNumberOrNull(firstValue(hourly.wind_speed_500hPa)),
  };

  return features;
}

/**
 * Turbulence scoring algorithm section.
 * Inputs: weather features in m/s (% for cloud cover, J/kg for CAPE).
 * Output: numeric score 0-100, label, and explanation bullets.
 */
function estimateTurbulenceRisk(features) {
  let score = 0;
  const reasons = [];

  const {
    windSpeed10m,
    gusts10m,
    cloudCover,
    cape,
    wind850,
    wind700,
    wind500,
  } = features;

  if (windSpeed10m != null) {
    if (windSpeed10m >= 25) {
      score += 22;
      reasons.push('Very strong low-level wind.');
    } else if (windSpeed10m >= 15) {
      score += 12;
      reasons.push('Elevated low-level wind speed.');
    }
  }

  if (gusts10m != null) {
    if (gusts10m >= 30) {
      score += 20;
      reasons.push('Strong gust potential.');
    } else if (gusts10m >= 18) {
      score += 10;
      reasons.push('Noticeable surface gusts.');
    }
  }

  const shear1 =
    wind850 != null && wind700 != null ? Math.abs(wind700 - wind850) : null;
  const shear2 =
    wind700 != null && wind500 != null ? Math.abs(wind500 - wind700) : null;

  if (shear1 != null) {
    if (shear1 >= 12) {
      score += 14;
      reasons.push('Strong wind shear (850–700 hPa).');
    } else if (shear1 >= 7) {
      score += 8;
      reasons.push('Moderate wind shear (850–700 hPa).');
    }
  }

  if (shear2 != null) {
    if (shear2 >= 15) {
      score += 16;
      reasons.push('Strong wind shear (700–500 hPa).');
    } else if (shear2 >= 9) {
      score += 9;
      reasons.push('Moderate wind shear (700–500 hPa).');
    }
  }

  if (cape != null) {
    if (cape >= 1200) {
      score += 18;
      reasons.push('High convective energy (CAPE).');
    } else if (cape >= 400) {
      score += 9;
      reasons.push('Some convective energy present.');
    }
  }

  if (cloudCover != null) {
    if (cloudCover >= 85) {
      score += 10;
      reasons.push('Dense cloud cover suggests active weather.');
    } else if (cloudCover >= 55) {
      score += 5;
      reasons.push('Moderate cloud cover contribution.');
    }
  }

  score = Math.max(0, Math.min(100, score));

  let label = 'Low';
  if (score >= 60) label = 'High';
  else if (score >= 30) label = 'Moderate';

  if (reasons.length === 0) {
    reasons.push('No strong turbulence indicators found in available weather fields.');
  }

  return { score, label, reasons };
}

function riskBadgeClass(label) {
  switch (label) {
    case 'High':
      return 'high';
    case 'Moderate':
      return 'moderate';
    default:
      return 'low';
  }
}

function renderRiskResult(result, features) {
  const riskBox = document.getElementById('risk-box');
  if (!riskBox) return;

  riskBox.innerHTML = `
    <div>
      <span class="badge ${riskBadgeClass(result.label)}">${result.label}</span>
      <strong style="margin-left:0.4rem;">Score: ${result.score}/100</strong>
    </div>
    <ul>
      ${result.reasons.map((r) => `<li>${r}</li>`).join('')}
    </ul>
    <div class="status">
      Inputs — wind: ${features.windSpeed10m ?? 'N/A'} m/s, gusts: ${features.gusts10m ?? 'N/A'} m/s,
      CAPE: ${features.cape ?? 'N/A'} J/kg, cloud cover: ${features.cloudCover ?? 'N/A'}%
    </div>
  `;
}

async function fetchAndRenderWeatherRisk(aircraft) {
  try {
    setStatus('Fetching weather near selected aircraft…');
    const res = await fetch(weatherUrl(aircraft.latitude, aircraft.longitude));
    if (!res.ok) throw new Error(`Open-Meteo request failed (${res.status})`);

    const weatherJson = await res.json();
    const features = extractWeatherFeatures(weatherJson);
    const risk = estimateTurbulenceRisk(features);

    renderRiskResult(risk, features);
    setStatus('Weather loaded and risk estimated.');
  } catch (err) {
    console.error(err);
    const riskBox = document.getElementById('risk-box');
    if (riskBox) {
      riskBox.innerHTML =
        '<p>Unable to load weather data. Turbulence estimate unavailable for this aircraft.</p>';
    }
    setStatus(`Weather lookup failed: ${err.message}`);
  }
}

async function onAircraftSelected(aircraft) {
  state.selectedIcao = aircraft.icao24;
  state.selectedAircraftSnapshot = aircraft;
  renderPanelBase(aircraft);
  await fetchAndRenderWeatherRisk(aircraft);
}

function setupUiHandlers() {
  ui.closeBtn.addEventListener('click', () => {
    ui.panel.classList.add('collapsed');
  });
}

async function init() {
  initMap();
  setupUiHandlers();
  await refreshAircraft();

  state.refreshTimer = setInterval(() => {
    refreshAircraft();
  }, REFRESH_MS);
}

init();
