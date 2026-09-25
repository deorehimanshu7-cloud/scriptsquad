/**
 * Grounded local answer engine.
 *
 * Why this exists: with no LLM key configured the assistant used to reply with
 * the SAME world-model dump for every question. The evidence was real, but it
 * never answered what was asked — a farmer asking "will it rain tomorrow?" and
 * "should I irrigate?" got byte-identical text, which reads as a broken bot.
 *
 * This module classifies the question's INTENT and composes a direct answer from
 * the recorded evidence. The honesty rules are unchanged and non-negotiable:
 *   - every number carries its truth state (OBSERVED / DERIVED / ESTIMATED /
 *     PREDICTED / SIMULATED / HISTORICAL / UNKNOWN);
 *   - a missing dataset is named, with what would unlock it, instead of guessed;
 *   - general agronomy that is not derived from this field's data is labelled
 *     as such.
 */
import type { AiContextPayload } from "./aiContext";

// ---------------------------------------------------------------------------
// small readers over the evidence rows
// ---------------------------------------------------------------------------

type Ent = Record<string, unknown>;

function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function row(entries: Ent[], subType: string): Ent | null {
  return entries.find((e) => String(e.sub_type) === subType) ?? null;
}

function numOf(entries: Ent[], subType: string): number | null {
  const r = row(entries, subType);
  return r ? asNum(r.value) : null;
}

function stateOf(entries: Ent[], subType: string): string | null {
  const r = row(entries, subType);
  return r ? String(r.state) : null;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

interface DayRow {
  date: string;
  tmax: number | null;
  tmin: number | null;
  rain: number | null;
  prob: number | null;
  et0: number | null;
  rad: number | null;
  sun: number | null;
}

/** Rebuild the REAL daily weather series (provider rows are stored newest-first). */
function dailySeries(ctx: AiContextPayload): DayRow[] {
  const map = new Map<string, DayRow>();
  for (const e of ctx.weather.entries) {
    const date = String(e.observed_at).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const sub = String(e.sub_type);
    const n = asNum(e.value);
    const cur = map.get(date) ?? { date, tmax: null, tmin: null, rain: null, prob: null, et0: null, rad: null, sun: null };
    if (sub === "temperature_2m_max") cur.tmax = n;
    else if (sub === "temperature_2m_min") cur.tmin = n;
    else if (sub === "precipitation_sum") cur.rain = n;
    else if (sub === "precipitation_probability_max") cur.prob = n;
    else if (sub === "et0_fao_evapotranspiration") cur.et0 = n;
    else if (sub === "shortwave_radiation_sum") cur.rad = n;
    else if (sub === "sunshine_duration") cur.sun = n;
    else continue;
    map.set(date, cur);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * "Today" in the FIELD's timezone, not the server's.
 *
 * The provider is queried with timezone=auto, so its daily dates are the field's
 * local dates. The current-conditions row carries that local timestamp, so it is
 * the honest reference. Falling back to UTC puts an India-based field a day
 * behind for most of the working day — the forecast then starts on yesterday.
 */
function localToday(ctx: AiContextPayload): string {
  const current = ctx.weather.entries.find((e) => String(e.sub_type).startsWith("current_") && e.observed_at);
  const iso = current ? String(current.observed_at).slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : new Date().toISOString().slice(0, 10);
}

function upcoming(days: DayRow[], count: number, today: string): DayRow[] {
  return days.filter((d) => d.date >= today).slice(0, count);
}

interface SensorReading {
  sensor_type: string;
  value: number | null;
  unit: string | null;
  freshness: string;
  observed_at: string;
}

/** Latest reading per sensor type (observations are stored newest-first). */
function latestSensors(ctx: AiContextPayload): SensorReading[] {
  const seen = new Map<string, SensorReading>();
  for (const o of ctx.sensors.observations) {
    const t = String(o.sensor_type);
    if (seen.has(t)) continue;
    seen.set(t, {
      sensor_type: t,
      value: asNum(o.value),
      unit: o.unit == null ? null : String(o.unit),
      freshness: String(o.freshness ?? "UNKNOWN"),
      observed_at: String(o.observed_at ?? ""),
    });
  }
  return [...seen.values()];
}

const sensorLine = (s: SensorReading[]) =>
  s.length === 0
    ? "no sensor telemetry has ever been recorded"
    : s
        .map(
          (x) =>
            `${x.sensor_type} ${x.value ?? "—"}${x.unit ? ` ${x.unit}` : ""} [OBSERVED · ${x.freshness}, ${x.observed_at.slice(0, 16).replace("T", " ")}]`,
        )
        .join(" · ");

/** Freshness values where a probe reading is still sound enough to act on. */
const USABLE_FRESHNESS = new Set(["LIVE", "RECENT"]);

function riskOf(ctx: AiContextPayload, type: string): Ent | null {
  return ctx.intelligence.risks.find((r) => String(r.risk_type) === type) ?? null;
}

const fieldName = (ctx: AiContextPayload) => String((ctx.field as { name?: string }).name ?? "this field");

// ---------------------------------------------------------------------------
// intent routing
// ---------------------------------------------------------------------------

export type AnswerIntent =
  | "identity"
  | "greeting"
  | "rain"
  | "weather"
  | "irrigation"
  | "fertiliser"
  | "pest"
  | "soil"
  | "crop_health"
  | "risk"
  | "sensor"
  | "water"
  | "terrain"
  | "market"
  | "overview";

const INTENT_RULES: { intent: AnswerIntent; words: string[] }[] = [
  // Short Latin tokens are matched as whole words by matchesToken(), so "hi"
  // can no longer fire on "this" or "high".
  { intent: "greeting", words: ["hi", "hey", "hello", "नमस्कार", "नमस्ते", "हॅलो", "good morning", "good evening"] },
  {
    intent: "identity",
    words: ["who are you", "what can you do", "your name", "तुम्ही कोण", "तू कोण", "आप कौन", "काय करू शकता", "what do you do", "help me use"],
  },
  {
    intent: "rain",
    words: ["rain", "पाऊस", "वर्षा", "बरसात", "will it rain", "rainfall", "पाऊस पडेल", "पाऊस पडणार", "shower"],
  },
  {
    intent: "irrigation",
    words: ["irrigat", "सिंचन", "सिंचाई", "पाणी द्यावे", "पानी देना", "should i water", "do i need water", "watering", "पाणी दे", "irrigate", "बांध", "पाणी किती"],
  },
  { intent: "fertiliser", words: ["fertil", "खत", "खाद", "urea", "युरिया", "npk", "nutrient", "पोषक", "डीएपी", "dap", "potash"] },
  { intent: "pest", words: ["pest", "कीड", "किड", "कीट", "disease", "रोग", "fungus", "बुरशी", "spray", "फवारणी", "छिड़काव", "insect", "caterpillar", "अळी"] },
  { intent: "soil", words: ["soil", "माती", "मिट्टी", "ph", "जमिन", "जमीन", "organic carbon", "मृदा", "texture", "मातीचा"] },
  {
    intent: "crop_health",
    words: ["ndvi", "vegetation", "हिरव", "crop health", "उपग्रह", "satellite", "पिकाची स्थिती", "crop condition", "biomass", "drone", "imagery", "फसल की स्थिति"],
  },
  {
    intent: "risk",
    words: ["risk", "धोका", "जोखिम", "जोखम", "anomaly", "विसंगती", "advice", "सल्ला", "काय करू", "काय करावे", "क्या करूं", "recommend", "biggest problem", "worried", "warning"],
  },
  {
    intent: "sensor",
    // "moisture" belongs here rather than under weather: the field's own
    // wetness is a probe reading, and this answer quotes it alongside humidity.
    words: [
      "sensor",
      "सेन्सर",
      "सेंसर",
      "telemetry",
      "device",
      "उपकरण",
      "instrument",
      "टेलिमेट्री",
      "ओलावा",
      "नमी",
      "moisture",
      "आर्द्रता किती",
    ],
  },
  { intent: "water", words: ["water source", "पाण्याचा स्रोत", "borewell", "बोअरवेल", "well", "विहीर", "कुआं", "groundwater", "भूजल", "canal", "कालवा", "नहर", "तलाव"] },
  { intent: "terrain", words: ["terrain", "उतार", "ढाल", "slope", "elevation", "उंची", "ऊंचाई", "aspect", "contour", "soil erosion", "धूप"] },
  { intent: "market", words: ["price", "भाव", "भाव काय", "मंडी", "मंडई", "mandi", "market", "बाजार", "sell", "विक्री", "rate", "msp", "किंमत"] },
  { intent: "weather", words: ["weather", "हवामान", "मौसम", "temperature", "तापमान", "humidity", "आर्द्रता", "wind", "वारा", "heat", "गरम", "उष्णता", "मौसम कैसा"] },
];

const ASCII_TOKEN = /^[a-z0-9][a-z0-9 '-]*$/;
const tokReCache = new Map<string, RegExp>();

/**
 * Keyword matching that respects word boundaries for Latin script.
 *
 * A plain `includes()` here is actively harmful: the greeting token "hi" also
 * matches inside "tHIs", "wHIChever" and "hIGH", so a real question like
 * "What is the soil moisture in this field?" was classified as a greeting and
 * answered with a hello. Devanagari has no reliable \b boundary and compounds
 * freely, so those terms keep substring matching.
 *
 * Tokens of 4+ characters are treated as stems and allowed a suffix
 * ("irrigat" → irrigation, "pest" → pests, "recommend" → recommended);
 * shorter tokens must match a whole word ("hi", "ph").
 */
function matchesToken(haystack: string, token: string): boolean {
  const w = token.toLowerCase();
  if (!ASCII_TOKEN.test(w)) return haystack.includes(w);
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffix = w.length >= 4 ? "" : "(?![a-z0-9])";
  const key = `${escaped}|${suffix}`;
  let re = tokReCache.get(key);
  if (!re) {
    re = new RegExp(`(^|[^a-z0-9])${escaped}${suffix}`, "i");
    tokReCache.set(key, re);
  }
  return re.test(haystack);
}

/** Route a farmer question (en/hi/mr) to the intent that answers it. */
export function classifyIntent(question: string): AnswerIntent {
  const q = question.toLowerCase().replace(/[?!.,;:]/g, " ");
  for (const rule of INTENT_RULES) {
    if (rule.words.some((w) => matchesToken(q, w))) return rule.intent;
  }
  return "overview";
}

// ---------------------------------------------------------------------------
// answer composition
// ---------------------------------------------------------------------------

const SOURCE_WEATHER = "Open-Meteo model output — PREDICTED nowcast/forecast, not a field sensor";

function answerWeather(ctx: AiContextPayload): string {
  const w = ctx.weather.entries;
  const temp = numOf(w, "current_temperature_2m");
  const rh = numOf(w, "current_relative_humidity_2m");
  const wind = numOf(w, "current_wind_speed_10m");
  const precip = numOf(w, "current_precipitation");
  const days = dailySeries(ctx);
  const nowLocal = localToday(ctx);
  const todayRow = upcoming(days, 1, nowLocal)[0] ?? null;
  const next = upcoming(days, 8, nowLocal);
  const warmest = next.length ? next.reduce((a, b) => ((b.tmax ?? -99) > (a.tmax ?? -99) ? b : a)) : null;
  const sensors = latestSensors(ctx);

  const lines: string[] = [`Weather at "${fieldName(ctx)}" — ${SOURCE_WEATHER}:`];
  if (temp !== null || rh !== null || wind !== null) {
    lines.push(
      `• Right now: ${temp ?? "—"} °C · humidity ${rh ?? "—"} % · wind ${wind ?? "—"} km/h · rainfall ${precip ?? "—"} mm [PREDICTED]`,
    );
  } else {
    lines.push("• No current-conditions row is stored for this field yet — run a refresh to pull the latest model run.");
  }
  if (todayRow) {
    lines.push(
      `• Today (${dayLabel(todayRow.date)}): ${todayRow.tmin ?? "—"}–${todayRow.tmax ?? "—"} °C` +
        (todayRow.prob !== null ? ` · ${todayRow.prob} % chance of rain · ${todayRow.rain ?? 0} mm expected` : "") +
        (todayRow.et0 !== null ? ` · ET0 ${todayRow.et0} mm` : ""),
    );
  }
  if (warmest && warmest.tmax !== null) {
    lines.push(`• Warmest of the next ${next.length} day(s): ${warmest.tmax} °C on ${dayLabel(warmest.date)} [PREDICTED]`);
  }
  const apparent = numOf(w, "current_apparent_temperature");
  const vpd = numOf(w, "current_vapour_pressure_deficit");
  const gust = numOf(w, "current_wind_gusts_10m");
  if (apparent !== null || vpd !== null || gust !== null) {
    lines.push(
      `• Field conditions: feels-like ${apparent ?? "—"} °C · vapour pressure deficit ${vpd ?? "—"} kPa · gusts ${gust ?? "—"} km/h [PREDICTED]`,
    );
  }
  if (todayRow && (todayRow.rad !== null || todayRow.sun !== null)) {
    lines.push(
      `• Today's energy: solar radiation ${todayRow.rad ?? "—"} MJ/m²${todayRow.sun !== null ? ` over ${todayRow.sun} sunshine hour(s)` : ""} [PREDICTED] — drives both crop growth and how fast the soil dries.`,
    );
  }
  lines.push("");
  lines.push(
    sensors.length
      ? `Unlike the model numbers above, your field sensor is a real measurement — ${sensorLine(sensors)}.`
      : "No field sensor has reported, so everything here is model output rather than a measurement at your farm.",
  );
  return lines.join("\n");
}

function answerRain(ctx: AiContextPayload): string {
  const days = upcoming(dailySeries(ctx), 5, localToday(ctx));
  if (days.length === 0) {
    return `No forecast rainfall rows are stored for "${fieldName(ctx)}" yet, so I cannot honestly tell you whether rain is coming. Run a field refresh to pull the current Open-Meteo model run, then ask me again.`;
  }
  const wet = days.filter((d) => (d.rain ?? 0) >= 1 || (d.prob ?? 0) >= 50);
  const total = days.reduce((a, b) => a + (b.rain ?? 0), 0);
  const peak = days.reduce((a, b) => ((b.prob ?? -1) > (a.prob ?? -1) ? b : a));

  const lead =
    wet.length === 0
      ? `No meaningful rain is forecast for "${fieldName(ctx)}" over the next ${days.length} day(s) — every day is under 1 mm with a low chance.`
      : wet.length === 1
        ? `Rain is likely on ${dayLabel(wet[0].date)} only — ${wet[0].prob ?? "—"} % chance, about ${wet[0].rain ?? 0} mm.`
        : `Rain is likely on ${wet.length} of the next ${days.length} day(s), starting ${dayLabel(wet[0].date)}.`;

  const table = days
    .map(
      (d) =>
        `• ${dayLabel(d.date)}: ${d.prob ?? "—"} % chance · ${d.rain ?? "—"} mm · ${d.tmin ?? "—"}–${d.tmax ?? "—"} °C`,
    )
    .join("\n");

  return [
    lead,
    "",
    `Daily forecast (${SOURCE_WEATHER}):`,
    table,
    `• 5-day total: ${r1(total)} mm expected · highest chance ${peak.prob ?? "—"} % on ${dayLabel(peak.date)} [PREDICTED]`,
    "",
    "These are model predictions, not rain gauge readings. If you have a rain gauge or sensor on the field, its reading is the authoritative one.",
  ].join("\n");
}

function answerIrrigation(ctx: AiContextPayload): string {
  const stress = riskOf(ctx, "water_stress");
  const days = upcoming(dailySeries(ctx), 3, localToday(ctx));
  const rain3 = days.reduce((a, b) => a + (b.rain ?? 0), 0);
  const sensors = latestSensors(ctx);
  const sm = sensors.find((s) => s.sensor_type === "soil_moisture") ?? null;
  const sim = ctx.world_model.domains.find((d) => String(d.domain) === "simulation") ?? null;

  const lines = [`Irrigation check for "${fieldName(ctx)}":`, ""];
  if (stress) {
    lines.push(`• Water-stress engine reading: ${String(stress.level)} — ${String(stress.reason)}`);
  } else {
    lines.push("• The water-stress engine has no open assessment for this field, so there is no computed balance to quote.");
  }
  lines.push(
    sm
      ? `• Latest soil-moisture sensor: ${sm.value ?? "—"}${sm.unit ? ` ${sm.unit}` : ""} [OBSERVED · ${sm.freshness}, ${sm.observed_at.slice(0, 16).replace("T", " ")}] — this is a real probe reading.`
      : "• No soil-moisture probe has ever reported for this field, so root-zone wetness is UNKNOWN.",
  );
  lines.push(
    days.length
      ? `• Forecast rain over the next ${days.length} day(s): ${r1(rain3)} mm [PREDICTED]`
      : "• No forecast rows stored — refresh the field to include forecast rain in this answer.",
  );
  // Modelled root-zone moisture (free land-surface model). Second to a probe,
  // but a real depth profile rather than a single unknown number.
  const modelled = ["0-1cm", "3-9cm", "9-27cm"]
    .map((d) => ({ d, v: numOf(ctx.soil.entries, `modelled_volumetric_water_${d}`) }))
    .filter((x) => x.v !== null);
  if (modelled.length) {
    lines.push(
      `• Modelled root-zone moisture: ${modelled.map((x) => `${x.d} ${x.v} m³/m³`).join(" · ")} [PREDICTED — land-surface model, not your probe]`,
    );
  }
  const vpdNow = numOf(ctx.weather.entries, "current_vapour_pressure_deficit");
  if (vpdNow !== null) {
    lines.push(
      `• Atmospheric demand (VPD): ${vpdNow} kPa [PREDICTED]${vpdNow >= 1.5 ? " — high, the crop pulls water fast" : vpdNow <= 0.4 ? " — low, little evaporative demand right now" : ""}`,
    );
  }
  if (sim && Number(sim.count) > 0) {
    lines.push("• A simulation scenario exists for this field [SIMULATED — your own scenario, kept separate from observed reality]");
  }
  lines.push("");
  lines.push(
    "Verdict: " +
      (sm && sm.value !== null && USABLE_FRESHNESS.has(sm.freshness)
        ? `your probe reads ${sm.value}${sm.unit ? ` ${sm.unit}` : ""} and is ${sm.freshness.toLowerCase()} (${sm.observed_at.slice(0, 16).replace("T", " ")}), so treat that as the authoritative wetness signal rather than the modelled balance — and re-check after the ${r1(rain3)} mm of forecast rain arrives.`
        : sm && sm.value !== null
          ? `your probe last reported ${sm.observed_at.slice(0, 16).replace("T", " ")} (${sm.freshness}), which is too old to base a watering decision on.`
          : "I cannot recommend a specific watering decision because no soil-moisture probe has reported for this field — the balance above is model-and-engine output only."),
  );
  lines.push("");
  lines.push(
    "What is missing for a real schedule: soil water-holding capacity and root depth for this field are not measured, so this is a balance check, not an irrigation plan.",
  );
  return lines.join("\n");
}

function answerFertiliser(ctx: AiContextPayload): string {
  const s = ctx.soil.entries;
  const ph = numOf(s, "ph@0-5cm");
  const soc0 = numOf(s, "soc@0-5cm");
  const soc60 = numOf(s, "soc@30-60cm");
  const clay = numOf(s, "clay@0-5cm");
  const silt = numOf(s, "silt@0-5cm");
  const sand = numOf(s, "sand@0-5cm");
  const n = numOf(s, "nitrogen@0-5cm");
  const cec = numOf(s, "cec@0-5cm");

  const texture =
    clay === null || sand === null
      ? null
      : clay >= 400
        ? "clay-heavy"
        : clay >= 250
          ? "clay loam"
          : sand >= 600
            ? "sandy"
            : "loam";

  const lines = [`Soil nutrients at "${fieldName(ctx)}" — SoilGrids v2.0 model estimates [ESTIMATED, not a lab test on your soil]:`, ""];
  if (ph !== null) lines.push(`• pH (0–5 cm): ${r1(ph)} ${ph >= 6.5 && ph <= 7.5 ? "— near neutral, suitable for most field crops" : ph < 6.5 ? "— acidic" : "— alkaline"}`);
  if (soc0 !== null) lines.push(`• Organic carbon: ${soc0} g/kg at 0–5 cm${soc60 !== null ? `, ${soc60} g/kg at 30–60 cm` : ""}`);
  if (clay !== null) lines.push(`• Texture (0–5 cm): clay ${clay} g/kg · silt ${silt ?? "—"} · sand ${sand ?? "—"}${texture ? ` → ${texture}` : ""}`);
  if (n !== null) lines.push(`• Total nitrogen (0–5 cm): ${n} g/kg — note this is TOTAL nitrogen, not plant-available N`);
  if (cec !== null) lines.push(`• Cation exchange capacity (0–5 cm): ${cec} mmol(c)/kg`);
  if (lines.length === 2) lines.push("• No soil property rows are stored for this field yet.");

  lines.push("");
  lines.push(
    "I cannot give you a fertiliser dose in kg per acre from this. Available N-P-K, a target yield and a crop nutrient-removal figure are not measured for this field, and inventing a number would be worse than saying so.",
  );
  lines.push("");
  lines.push(
    "To make this answer real: have the soil tested at a lab and record the result as a farmer observation on this field, or connect a crop-nutrient model. The declared crop (" +
      (ctx.crop.crop_name ?? "none declared") +
      ") would then drive the dose.",
  );
  return lines.join("\n");
}

function answerPest(ctx: AiContextPayload): string {
  const days = upcoming(dailySeries(ctx), 7, localToday(ctx));
  const hi = days.length ? Math.max(...days.map((d) => d.tmax ?? -99)) : null;
  const lo = days.length ? Math.min(...days.map((d) => d.tmin ?? 99)) : null;
  const sensors = latestSensors(ctx);
  const rhSensor = sensors.find((s) => s.sensor_type === "humidity") ?? null;
  const w = ctx.weather.entries;
  const rhModel = numOf(w, "current_relative_humidity_2m");
  const tempModel = numOf(w, "current_temperature_2m");
  const sat = ctx.satellite.latest;

  return [
    `Pest and disease question for "${fieldName(ctx)}":`,
    "",
    "No pest, disease or crop-growth model is connected to this field, so I cannot give you a specific pest risk computed from your data. Here is what the field actually shows:",
    `• Crop declared: ${ctx.crop.crop_name ?? "none declared"} (your own field metadata — not independently verified)`,
    `• Humidity: ${rhSensor ? `${rhSensor.value}${rhSensor.unit ? ` ${rhSensor.unit}` : ""} [OBSERVED · ${rhSensor.freshness}]` : "no humidity sensor reporting"}` +
      (rhModel !== null ? ` · model ${rhModel} % [PREDICTED]` : ""),
    `• Temperature now ${tempModel ?? "—"} °C [PREDICTED]${hi !== null && lo !== null ? ` · next 7 days ${lo}–${hi} °C` : ""}`,
    (() => {
      const dust = numOf(ctx.environment.entries, "air_quality_dust");
      const pm25 = numOf(ctx.environment.entries, "air_quality_pm2_5");
      return dust !== null || pm25 !== null
        ? `• Airborne load: PM2.5 ${pm25 ?? "—"} μg/m³ · dust ${dust ?? "—"} μg/m³ [PREDICTED — CAMS atmospheric model] — relevant to spray timing and drift`
        : "";
    })(),
    sat
      ? `• Imagery: latest real acquisition ${String(sat.satellite)} on ${String(sat.acquired_at).slice(0, 10)} (cloud ${sat.cloud_cover ?? "—"} %) [OBSERVED metadata]`
      : "• Imagery: no acquisition catalogued yet",
    "• Vegetation indices (NDVI/NDRE) that would show crop stress are AUTH_REQUIRED — Copernicus OAuth is not configured — so no stress reading can be derived from imagery.",
    "",
    "General agronomy, NOT field data — verify locally before acting:",
    "• Warm humid spells with a wet canopy favour fungal disease; walking the rows and checking the underside of leaves is the fastest confirmation.",
    "• Scout the crop you declared; if you see lesions or insects, record it as a farmer observation so the pattern becomes part of this field's history.",
    "• For a treatment decision, confirm with your local KVK / agriculture officer — I will not name a dose without a real diagnosis.",
    "",
    "What would make this real: Copernicus OAuth (free) for NDVI, a pest degree-day model, or your own scouting observations.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function answerSoil(ctx: AiContextPayload): string {
  const s = ctx.soil.entries;
  // sort depths numerically (0-5, 5-15, 15-30, 30-60) — a string sort puts
  // "15-30cm" before "5-15cm", which reads as a scrambled profile
  const depths = [...new Set(s.map((e) => String(e.sub_type).split("@")[1]).filter(Boolean))].sort(
    (a, b) => Number.parseFloat(a) - Number.parseFloat(b),
  );
  const lines = [`Soil profile for "${fieldName(ctx)}" (${ctx.soil.state}) — ${ctx.soil.summary ?? ""}`, ""];
  for (const d of depths) {
    const clay = numOf(s, `clay@${d}`);
    const sand = numOf(s, `sand@${d}`);
    const soc = numOf(s, `soc@${d}`);
    const bd = numOf(s, `bdod@${d}`);
    const bits = [
      clay !== null ? `clay ${clay} g/kg` : null,
      sand !== null ? `sand ${sand} g/kg` : null,
      soc !== null ? `organic carbon ${soc} g/kg` : null,
      bd !== null ? `bulk density ${bd} cg/cm³` : null,
    ].filter(Boolean);
    if (bits.length) lines.push(`• ${d}: ${bits.join(" · ")} [ESTIMATED]`);
  }
  const ph = numOf(s, "ph@0-5cm");
  if (ph !== null) lines.push(`• pH (0–5 cm): ${r1(ph)} [ESTIMATED]`);
  const moisture = ["0-1cm", "3-9cm", "9-27cm"]
    .map((d) => ({ d, v: numOf(s, `modelled_volumetric_water_${d}`) }))
    .filter((x) => x.v !== null);
  if (moisture.length) {
    lines.push(
      `• Modelled volumetric water content: ${moisture.map((x) => `${x.d} = ${x.v} m³/m³`).join(" · ")} [PREDICTED — land-surface model for this location, not a probe reading]`,
    );
  }
  if (lines.length === 2) lines.push("• No soil rows stored yet — run a field refresh.");
  lines.push("");
  lines.push(
    "These are SoilGrids global-model estimates for the location, not a laboratory analysis of your soil. A lab test is the only source that can settle nutrient questions. Terrain for the same parcel: " +
      `${numOf(ctx.terrain.entries, "elevation_mean_m") ?? "—"} m mean elevation, slope ${numOf(ctx.terrain.entries, "slope_degrees") ?? "—"}° [DERIVED].`,
  );
  return lines.join("\n");
}

function answerCropHealth(ctx: AiContextPayload): string {
  const latest = ctx.satellite.latest;
  const best = ctx.satellite.best;
  const idxState = stateOf(ctx.crop.entries, "ndvi") ?? "AUTH_REQUIRED";
  return [
    `Crop condition for "${fieldName(ctx)}" (crop declared: ${ctx.crop.crop_name ?? "none"}):`,
    "",
    latest
      ? `• Latest real acquisition: ${String(latest.satellite)} on ${String(latest.acquired_at).slice(0, 10)} — cloud cover ${latest.cloud_cover ?? "—"} % [OBSERVED metadata]`
      : "• No satellite acquisition is catalogued for this field yet.",
    best && latest && best.id !== latest.id
      ? `• Least-cloudy acquisition on record: ${String(best.acquired_at).slice(0, 10)} (cloud ${best.cloud_cover ?? "—"} %)`
      : "",
    `• Vegetation indices (NDVI/NDRE/SAVI/NDWI): ${idxState} — raster access needs Copernicus OAuth credentials (COPERNICUS_CLIENT_ID / COPERNICUS_CLIENT_SECRET).`,
    "",
    "So: I can tell you what was imaged and when, but I cannot yet show you how green the crop is. Any NDVI-style number presented without that credential would be fabricated, and this system does not do that.",
    "",
    "To unlock real crop-condition monitoring: sign up free at Copernicus Data Space Ecosystem and set the two credential variables — then this endpoint returns real index rasters, not just acquisition metadata.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function answerRisk(ctx: AiContextPayload): string {
  const risks = ctx.intelligence.risks;
  const anomalies = ctx.intelligence.anomalies;
  const unc = ctx.intelligence.uncertainties;
  const actions = ctx.actions;
  const lines = [`Open assessments for "${fieldName(ctx)}" (from the intelligence engines — real engine output, not a guess):`, ""];
  if (risks.length === 0 && anomalies.length === 0) lines.push("• No open risk or anomaly is recorded for this field.");
  for (const r of risks) lines.push(`• RISK ${String(r.level)} — ${String(r.risk_type).replace(/_/g, " ")}: ${String(r.reason)}`);
  for (const a of anomalies) lines.push(`• ANOMALY ${String(a.severity ?? "")} — ${String(a.kind).replace(/_/g, " ")}: ${String(a.description)}`);
  if (unc.length) {
    lines.push("");
    lines.push("Uncertainty the system itself flags:");
    for (const u of unc.slice(0, 4)) lines.push(`• ${String(u.kind)} (${String(u.domain ?? "field")}, ${String(u.level)}): ${String(u.reason)}`);
  }
  if (actions.length) {
    lines.push("");
    lines.push("Recorded actions:");
    for (const a of actions.slice(0, 4)) lines.push(`• ${String(a.kind)} (${String(a.status)}): ${String(a.title)}`);
  }
  lines.push("");
  lines.push(
    "These assessments are bounded by the data above — where a domain is NO_DATA or AUTH_REQUIRED the engines say so rather than widening the claim.",
  );
  return lines.join("\n");
}

function answerSensor(ctx: AiContextPayload): string {
  const sensors = latestSensors(ctx);
  const devices = ctx.sensors.devices;
  return [
    `Field sensors at "${fieldName(ctx)}":`,
    "",
    `• Overall sensor state: ${ctx.sensors.state} — ${ctx.sensors.reason}`,
    `• Registered devices: ${devices.length}`,
    sensors.length ? `• Latest reading per type:\n${sensors.map((s) => `   – ${s.sensor_type}: ${s.value ?? "—"}${s.unit ? ` ${s.unit}` : ""} [OBSERVED · ${s.freshness} · ${s.observed_at.slice(0, 16).replace("T", " ")}]`).join("\n")}` : "• No telemetry has ever been ingested for this field.",
    "",
    devices.length
      ? "Note on placement: registered devices carry no latitude/longitude in this deployment, so they cannot be drawn at a real position — the twin marks them at the field centroid and says so."
      : "Register a device and POST telemetry (or enable MQTT) to make this a live sensor field.",
  ].join("\n");
}

function answerWater(ctx: AiContextPayload): string {
  const feats = numOf(ctx.water.entries, "mapped_water_features_6km");
  const near = numOf(ctx.water.entries, "nearest_water_distance_km");
  return [
    `Water context around "${fieldName(ctx)}":`,
    "",
    feats !== null
      ? `• ${feats} mapped water feature(s) within 6 km [DERIVED — OpenStreetMap]`
      : "• No mapped water features recorded.",
    near !== null ? `• Nearest mapped water feature: ${near} km [DERIVED — OpenStreetMap]` : "",
    "",
    "Important limit: the OpenStreetMap query records how many features and how far, but not their DIRECTION — so this is context, not a location you can walk to.",
    "",
    `• Groundwater / aquifer / irrigation-scheme layers: ${ctx.water.state === "PARTIAL" ? "NOT_CONFIGURED" : ctx.water.state} — they need India-WRIS / CGWB credentials.`,
    "• Rainfall that feeds these sources is covered on the weather side — ask me about rain and I will give you the forecast series.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function answerTerrain(ctx: AiContextPayload): string {
  const t = ctx.terrain.entries;
  const mean = numOf(t, "elevation_mean_m");
  const min = numOf(t, "elevation_min_m");
  const max = numOf(t, "elevation_max_m");
  const range = numOf(t, "elevation_range_m");
  const slope = numOf(t, "slope_degrees");
  const aspect = numOf(t, "aspect_degrees");
  const samples = numOf(t, "dem_sample_count");
  return [
    `Terrain of "${fieldName(ctx)}" — DEM samples inside the parcel [DERIVED]:`,
    "",
    mean !== null ? `• Mean elevation ${mean} m${min !== null && max !== null ? ` (range ${min}–${max} m, relief ${range ?? "—"} m)` : ""}` : "• No DEM samples stored yet.",
    samples !== null ? `• Computed from ${samples} real raster sample(s) — not a single centroid point` : "",
    slope !== null ? `• Slope ${slope}°${slope < 2 ? " — nearly level" : slope < 5 ? " — gentle, generally workable" : " — significant; check for erosion risk"}` : "",
    aspect !== null ? `• Aspect ${aspect}° — the downslope direction the parcel faces` : "",
    "",
    "Slope and aspect here come from interpolated open DEM raster data, so treat them as good planning guidance rather than a survey. Nothing about soil erosion risk should rest on this alone.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function answerMarket(): string {
  return [
    "Market and price question:",
    "",
    "No market or mandi price source is connected to this project, so I cannot tell you today's price for anything. I could guess, but a guessed price is worse than no price when you are deciding when to sell.",
    "",
    "What it takes: a data.gov.in API key gives access to the Agmarknet daily mandi price feed, which would let this answer quote real arrivals and modal prices for your district and commodity.",
  ].join("\n");
}

function answerIdentity(ctx: AiContextPayload): string {
  return [
    "I am the AGRIFUR2 field assistant. I answer only from this field's recorded evidence — sensors, weather model runs, satellite metadata, SoilGrids estimates, DEM terrain and the intelligence engines — and I label every number with how it was obtained.",
    "",
    `I currently have a real picture of "${fieldName(ctx)}": ${ctx.world_model.domains.map((d) => `${String(d.domain)}=${String(d.state)}`).join(", ")}.`,
    "",
    "Ask me things like:",
    "• Will it rain in the next few days?",
    "• Should I irrigate?",
    "• What is my soil like?",
    "• What are the biggest risks right now?",
    "• Is my sensor working?",
    "",
    "When something is not measured I will tell you what is missing and what would unlock it, rather than filling the gap with a plausible number.",
  ].join("\n");
}

function answerOverview(ctx: AiContextPayload, question: string): string {
  const sensors = latestSensors(ctx);
  const stress = riskOf(ctx, "water_stress");
  const days = upcoming(dailySeries(ctx), 3, localToday(ctx));
  const rain3 = days.reduce((a, b) => a + (b.rain ?? 0), 0);
  const lines = [
    `Field "${fieldName(ctx)}" — what is actually recorded right now:`,
    "",
    `• Coverage: ${ctx.world_model.domains.filter((d) => Number(d.count) > 0).length} domain(s) with data out of ${ctx.world_model.domains.length}. ${ctx.world_model.domains.filter((d) => Number(d.count) === 0).map((d) => String(d.domain)).join(", ") || "Nothing empty."} ${ctx.world_model.domains.filter((d) => Number(d.count) === 0).length ? "have no data yet" : ""}`,
    stress ? `• Water stress: ${String(stress.level)} — ${String(stress.reason)}` : "• Water stress: no open assessment.",
    sensors.length ? `• Sensors: ${sensorLine(sensors)}` : "• Sensors: no telemetry recorded.",
    days.length ? `• Next ${days.length} day(s) rain: ${r1(rain3)} mm [PREDICTED]` : "• No forecast rows stored.",
  ];
  lines.push("");
  lines.push(
    `I did not find a specific question in "${question.trim()}". Ask me something concrete — rain, irrigation, soil, pests, sensors, terrain or risks — and I will answer it directly from the evidence above.`,
  );
  return lines.join("\n");
}

/** Compose a direct, grounded answer for the question that was actually asked. */
export function composeAnswer(ctx: AiContextPayload, question: string): string {
  switch (classifyIntent(question)) {
    case "greeting":
      return `Namaskar. I am the field assistant for "${fieldName(ctx)}". Ask me about rain, irrigation, soil, pests, your sensors, terrain or risks, and I will answer from this field's recorded evidence only.`;
    case "identity":
      return answerIdentity(ctx);
    case "rain":
      return answerRain(ctx);
    case "weather":
      return answerWeather(ctx);
    case "irrigation":
      return answerIrrigation(ctx);
    case "fertiliser":
      return answerFertiliser(ctx);
    case "pest":
      return answerPest(ctx);
    case "soil":
      return answerSoil(ctx);
    case "crop_health":
      return answerCropHealth(ctx);
    case "risk":
      return answerRisk(ctx);
    case "sensor":
      return answerSensor(ctx);
    case "water":
      return answerWater(ctx);
    case "terrain":
      return answerTerrain(ctx);
    case "market":
      return answerMarket();
    default:
      return answerOverview(ctx, question);
  }
}
