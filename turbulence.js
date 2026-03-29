const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function toNumberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function firstValue(arr) {
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}

export function extractWeatherFeatures(weatherJson) {
  const current = weatherJson.current || {};
  const hourly = weatherJson.hourly || {};

  return {
    windSpeed10m: toNumberOrNull(current.wind_speed_10m),
    windDir10m: toNumberOrNull(current.wind_direction_10m),
    gusts10m: toNumberOrNull(current.wind_gusts_10m),
    cloudCover: toNumberOrNull(current.cloud_cover ?? firstValue(hourly.cloud_cover)),
    cape: toNumberOrNull(current.cape ?? firstValue(hourly.cape)),
    wind850: toNumberOrNull(firstValue(hourly.wind_speed_850hPa)),
    wind700: toNumberOrNull(firstValue(hourly.wind_speed_700hPa)),
    wind500: toNumberOrNull(firstValue(hourly.wind_speed_500hPa)),
  };
}

/**
 * Turbulence scoring logic.
 * Input units: m/s, %, J/kg.
 */
export function scoreTurbulenceRisk(features) {
  let score = 0;
  const factors = [];

  const shearLow =
    features.wind850 != null && features.wind700 != null
      ? Math.abs(features.wind700 - features.wind850)
      : null;
  const shearUpper =
    features.wind700 != null && features.wind500 != null
      ? Math.abs(features.wind500 - features.wind700)
      : null;

  if (features.windSpeed10m != null) {
    if (features.windSpeed10m >= 25) {
      score += 23;
      factors.push('High upper-level wind speeds increased risk.');
    } else if (features.windSpeed10m >= 15) {
      score += 12;
      factors.push('Elevated background wind speed increased bumpiness potential.');
    }
  }

  if (features.gusts10m != null) {
    if (features.gusts10m >= 30) {
      score += 18;
      factors.push('Strong gusts suggest more abrupt vertical motion.');
    } else if (features.gusts10m >= 18) {
      score += 9;
      factors.push('Moderate gustiness added turbulence potential.');
    }
  }

  if (shearLow != null) {
    if (shearLow >= 12) {
      score += 15;
      factors.push('Wind differences between sampled layers suggest shear.');
    } else if (shearLow >= 7) {
      score += 8;
      factors.push('Some low-to-mid level wind shear was detected.');
    }
  }

  if (shearUpper != null) {
    if (shearUpper >= 15) {
      score += 16;
      factors.push('Stronger mid/upper level shear increased expected roughness.');
    } else if (shearUpper >= 9) {
      score += 8;
      factors.push('Moderate upper-level shear contributed to the score.');
    }
  }

  if (features.cape != null) {
    if (features.cape >= 1200) {
      score += 18;
      factors.push('Convective instability raised risk.');
    } else if (features.cape >= 400) {
      score += 10;
      factors.push('Some atmospheric instability is present.');
    }
  }

  if (features.cloudCover != null) {
    if (features.cloudCover >= 85) {
      score += 8;
      factors.push('Broad cloud cover hints at active weather nearby.');
    } else if (features.cloudCover >= 55) {
      score += 4;
      factors.push('Moderate cloud cover modestly increased risk.');
    }
  }

  score = clamp(score, 0, 100);

  let label = 'Low';
  if (score >= 60) label = 'High';
  else if (score >= 30) label = 'Moderate';

  if (!factors.length) {
    factors.push('No major turbulence drivers were detected in available weather fields.');
  }

  return { score, label, factors };
}

function destinationPoint(latDeg, lonDeg, bearingDeg, distanceKm) {
  const R = 6371;
  const lat1 = (latDeg * Math.PI) / 180;
  const lon1 = (lonDeg * Math.PI) / 180;
  const brng = (bearingDeg * Math.PI) / 180;
  const angDist = distanceKm / R;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angDist) +
      Math.cos(lat1) * Math.sin(angDist) * Math.cos(brng)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(angDist) * Math.cos(lat1),
      Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2)
    );

  return {
    latitude: (lat2 * 180) / Math.PI,
    longitude: ((((lon2 * 180) / Math.PI) + 540) % 360) - 180,
  };
}

/**
 * Route-sampled risk-ahead estimation using track/heading.
 */
export function buildRouteSamplePoints(aircraft, sampleKm = [0, 25, 50, 100]) {
  const track = Number.isFinite(aircraft.trueTrack) ? aircraft.trueTrack : 0;
  return sampleKm.map((distanceKm) => {
    if (distanceKm === 0) {
      return {
        distanceKm,
        latitude: aircraft.latitude,
        longitude: aircraft.longitude,
      };
    }

    const point = destinationPoint(
      aircraft.latitude,
      aircraft.longitude,
      track,
      distanceKm
    );

    return { distanceKm, ...point };
  });
}

export function riskToColor(label) {
  if (label === 'High') return '#ef4444';
  if (label === 'Moderate') return '#f59e0b';
  return '#22c55e';
}
