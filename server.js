"use strict";

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
app.use(express.json());
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use("/api/", rateLimit({ windowMs: 60_000, max: 30 }));

const PORT = process.env.PORT || 3000;
const OWM_API_KEY = process.env.OWM_API_KEY;
const OWM_BASE_URL = "https://api.openweathermap.org/data/2.5/weather";

if (!OWM_API_KEY) {
  console.error("[FATAL] Brak OWM_API_KEY w zmiennych środowiskowych.");
  process.exit(1);
}

const AREA_CENTER = {
  lat: parseFloat(process.env.AREA_LAT) || 54.352,
  lon: parseFloat(process.env.AREA_LON) || 18.6466,
};

const POI_DATABASE = [
  { id: "plaza_brzezno", name: "Plaża Brzeźno", lat: 54.3955, lon: 18.6382, type: "outdoor", baseWeight: 0.9,  peakHours: [11,12,13,14,15,16,17,18] },
  { id: "plaza_sopot",   name: "Plaża Sopot",   lat: 54.4415, lon: 18.5706, type: "outdoor", baseWeight: 0.95, peakHours: [11,12,13,14,15,16,17,18,19,20] },
  { id: "park_oliwski",  name: "Park Oliwski",  lat: 54.3804, lon: 18.5439, type: "outdoor", baseWeight: 0.75, peakHours: [9,10,11,15,16,17,18] },
  { id: "dlugi_targ",    name: "Długi Targ",    lat: 54.3484, lon: 18.6537, type: "outdoor", baseWeight: 0.8,  peakHours: [10,11,12,13,14,15,16,17,18,19,20,21] },
  { id: "dworzec_gdansk",name: "Dworzec PKP Gdańsk", lat: 54.3566, lon: 18.6432, type: "indoor", baseWeight: 0.6, peakHours: [6,7,8,15,16,17,18] },
];

let weatherCache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchWeather(lat, lon) {
  try {
    const response = await axios.get(OWM_BASE_URL, {
      params: { lat, lon, appid: OWM_API_KEY, units: "metric", lang: "pl" },
      timeout: 5000,
    });
    const weatherId = response.data.weather[0].id;
    const description = response.data.weather[0].description;
    const isBadWeather = weatherId < 700;
    console.log(`[WEATHER] ${description} | Opady: ${isBadWeather}`);
    return { isBadWeather, description };
  } catch (err) {
    console.error("[WEATHER] Błąd API:", err.message);
    return { isBadWeather: false, description: "błąd API" };
  }
}

async function fetchWeatherCached(lat, lon) {
  if (weatherCache.data && Date.now() - weatherCache.fetchedAt < CACHE_TTL_MS) {
    return weatherCache.data;
  }
  const data = await fetchWeather(lat, lon);
  weatherCache = { data, fetchedAt: Date.now() };
  return data;
}

function getLocalHourWarsaw() {
  const str = new Date().toLocaleString("en-US", {
    timeZone: "Europe/Warsaw",
    hour: "numeric",
    hour12: false,
  });
  return parseInt(str, 10) % 24;
}

function applyWeatherModifier(points, isBadWeather) {
  if (!isBadWeather) return points;
  return points.map((p) => ({
    ...p,
    weight: p.type === "outdoor"
      ? parseFloat((p.weight * 0.2).toFixed(4))
      : Math.min(1.0, parseFloat((p.weight * 1.3).toFixed(4))),
  }));
}

function applyGoldenWindowBoost(poi, weight, currentHourLocal) {
  const LOOKBACK_HOURS = [2, 3];
  const BOOST_FACTOR = 1.6;
  if (poi.peakHours.includes(currentHourLocal)) return weight;
  const wasRecentlyPeak = LOOKBACK_HOURS.some((h) => {
    const pastHour = (currentHourLocal - h + 24) % 24;
    return poi.peakHours.includes(pastHour);
  });
  if (wasRecentlyPeak) {
    const boosted = Math.min(1.0, parseFloat((weight * BOOST_FACTOR).toFixed(4)));
    console.log(`[GOLDEN WINDOW] ${poi.name}: ${weight} -> ${boosted}`);
    return boosted;
  }
  return weight;
}

async function computeHeatmapData() {
  const weather = await fetchWeatherCached(AREA_CENTER.lat, AREA_CENTER.lon);
  const currentHourLocal = getLocalHourWarsaw();

  let points = POI_DATABASE.map((poi) => ({
    ...poi,
    weight: poi.peakHours.includes(currentHourLocal)
      ? poi.baseWeight
      : parseFloat((poi.baseWeight * 0.4).toFixed(4)),
  }));

  points = applyWeatherModifier(points, weather.isBadWeather);
  points = points.map((p) => ({
    ...p,
    weight: applyGoldenWindowBoost(p, p.weight, currentHourLocal),
  }));

  return {
    heatmapData: points.map((p) => [p.lat, p.lon, p.weight]),
    meta: {
      generatedAt: new Date().toISOString(),
      weatherDescription: weather.description,
      isBadWeather: weather.isBadWeather,
      currentHourLocal,
    },
  };
}

app.get("/api/lokalizacje", async (req, res) => {
  try {
    const result = await computeHeatmapData();
    res.json(result);
  } catch (err) {
    console.error("[API] Błąd:", err);
    res.status(500).json({ error: "Błąd serwera." });
  }
});

app.get("/api/status", (req, res) => {
  res.json({ status: "ok", hasOWMKey: !!OWM_API_KEY });
});

const server = app.listen(PORT, () => {
  console.log(`Serwer działa na porcie ${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("Zamykanie serwera...");
  server.close(() => process.exit(0));
});
