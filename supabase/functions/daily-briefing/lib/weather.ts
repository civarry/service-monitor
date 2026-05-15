export interface Weather {
  temp_max: number;
  temp_min: number;
  precip_prob: number;
  code: number;
  summary: string;
}

const TAIPEI = { lat: 25.0330, lon: 121.5654 };

const WMO_LABELS: Record<number, string> = {
  0: "Clear",
  1: "Mostly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  80: "Showers",
  81: "Showers",
  82: "Heavy showers",
  95: "Thunderstorm",
  96: "Thunderstorm + hail",
  99: "Severe thunderstorm",
};

export async function getTaipeiWeather(): Promise<Weather | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${TAIPEI.lat}&longitude=${TAIPEI.lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode` +
    `&timezone=Asia/Taipei&forecast_days=1`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const d = data.daily;
    if (!d) return null;
    const code = d.weathercode?.[0] ?? 0;
    return {
      temp_max: d.temperature_2m_max?.[0] ?? 0,
      temp_min: d.temperature_2m_min?.[0] ?? 0,
      precip_prob: d.precipitation_probability_max?.[0] ?? 0,
      code,
      summary: WMO_LABELS[code] ?? "Mixed",
    };
  } catch {
    return null;
  }
}
