export interface Weather {
  temp_max: number;
  temp_min: number;
  precip_prob: number;
  code: number;
  summary: string;
  rain_window: string;
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

function formatHour(h: number): string {
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

function computeRainWindow(times: string[], probs: number[]): string {
  const daytime: { hour: number; prob: number }[] = [];
  for (let i = 0; i < times.length; i++) {
    const h = parseInt(times[i].slice(11, 13), 10);
    if (h >= 6 && h <= 22) daytime.push({ hour: h, prob: probs[i] ?? 0 });
  }
  if (daytime.length === 0) return "Forecast unavailable";

  const peak = daytime.reduce((a, b) => (b.prob > a.prob ? b : a));

  if (peak.prob === 0) return "Dry all day";
  if (peak.prob < 30) return `Mostly dry · peak ${peak.prob}% at ${formatHour(peak.hour)}`;

  const wet = daytime.filter((d) => d.prob >= 60).length;
  if (wet >= 8) return `Wet most of the day · peak ${peak.prob}%`;

  const winThresh = Math.max(20, peak.prob * 0.6);
  const sorted = [...daytime].sort((a, b) => a.hour - b.hour);
  const peakIdx = sorted.findIndex((d) => d.hour === peak.hour && d.prob === peak.prob);
  let start = peakIdx;
  let end = peakIdx;
  while (start > 0 && sorted[start - 1].prob >= winThresh) start--;
  while (end < sorted.length - 1 && sorted[end + 1].prob >= winThresh) end++;

  if (end > start) {
    return `Peak rain ${formatHour(sorted[start].hour)}–${formatHour(sorted[end].hour + 1)} · ${peak.prob}%`;
  }
  return `Peak rain ${formatHour(peak.hour)} · ${peak.prob}%`;
}

export async function getTaipeiWeather(): Promise<Weather | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${TAIPEI.lat}&longitude=${TAIPEI.lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode` +
    `&hourly=precipitation_probability` +
    `&timezone=Asia/Taipei&forecast_days=1`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const d = data.daily;
    const h = data.hourly;
    if (!d) return null;
    const code = d.weathercode?.[0] ?? 0;
    const rain_window = h ? computeRainWindow(h.time, h.precipitation_probability) : "Forecast unavailable";
    return {
      temp_max: d.temperature_2m_max?.[0] ?? 0,
      temp_min: d.temperature_2m_min?.[0] ?? 0,
      precip_prob: d.precipitation_probability_max?.[0] ?? 0,
      code,
      summary: WMO_LABELS[code] ?? "Mixed",
      rain_window,
    };
  } catch {
    return null;
  }
}
