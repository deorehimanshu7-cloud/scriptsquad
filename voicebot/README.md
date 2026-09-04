# AGRIFUR Voice Bot (existing — integrated, not rebuilt)

This is the **existing Farmer AI voice bot** (Gradio + SarvamAI + Flask). It stays
the voice engine — microphone, STT, conversation and TTS — while AGRIFUR supplies
field evidence. No second AI assistant is created.

```
REAL FIELD
  → ESP32 / sensors → AGRIFUR telemetry → OBSERVED evidence → world model
  → GET /api/fields/{id}/ai-context   (controlled context, no raw DB access)
  → voice bot (SarvamAI saaras:v3 STT → sarvam-105b chat → bulbul:v3 TTS)
  → farmer hears the answer in Marathi
```

## Run it (on the machine that hosts the backend / is on the farmer's LAN)

```bash
cd voicebot
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# server-side secret — never commit it
export SARVAM_API_SUBSCRIPTION_KEY="sk_..."          # Windows: $env:SARVAM_API_SUBSCRIPTION_KEY="sk_..."

# OPTIONAL — ground answers on live AGRIFUR field evidence
export AGRIFUR_AI_CONTEXT_URL="http://192.168.1.44:3001"
# export AGRIFUR_TOKEN="..."                          # only if the AGRIFUR API requires one
# export AGRIFUR_DEFAULT_FIELD_ID="fld_..."           # field used by the mic UI when no field is given

export VOICE_PORT=7860                                # Gradio UI port (default 7860)
python farmer_ai.py
```

- Gradio voice UI: `http://192.168.1.44:7860` (bind `0.0.0.0`, so a browser on
  the same Wi-Fi can use it; ESP32 → Flask sink stays on port 5000).
- `VOICE_SHARE=1` creates a temporary public Gradio tunnel (demo only).

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `SARVAM_API_SUBSCRIPTION_KEY` | yes | Sarvam AI key — **server-side only**, never commit |
| `AGRIFUR_AI_CONTEXT_URL` | no | AGRIFUR backend base URL (e.g. `http://192.168.1.44:3001`); answers then use the field's real evidence |
| `AGRIFUR_TOKEN` | no | bearer token for the AGRIFUR API when auth is on |
| `AGRIFUR_DEFAULT_FIELD_ID` | no | field used by the microphone UI (which has no field picker) |
| `VOICE_PORT` / `VOICE_SHARE` | no | Gradio launch settings |

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST/GET :5000/sensor-data` | live ESP32 sensor sink (original) |
| `POST :5000/voice/query` | `{field_id?, message}` → grounded text answer (adapter for typing/API integrations; reuses the exact same AI call) |
| `GET :5000/voice/health` | integration health |
| `:7860` (Gradio) | original microphone → STT → AI → TTS UI |

## What the bot can answer

When `AGRIFUR_AI_CONTEXT_URL` is set, every question is answered from the field's
**complete** recorded picture (`GET /api/fields/{id}/ai-context`), so the farmer
can ask about anything: current temperature/soil moisture (OBSERVED telemetry),
rain or heat (weather), NDVI/satellite change, soil nutrients, nearby water,
slope/terrain, crop stress, open risks/anomalies/uncertainties/contradictions,
active investigations and hypotheses, recommended actions, or what changed in
the field's history (farm memory).

## Truthfulness

The bot only reports values present in its context. When AGRIFUR context is
configured, a strict briefing is built from every section the endpoint returns
(world model, sensors, satellite, weather, soil, water, terrain, crop,
intelligence, investigations, actions, memory) with rules in Marathi: never
invent a reading; if a value is missing or `NO_DATA`/`UNKNOWN`, say it is
currently unavailable; when indicators conflict, say so instead of averaging
them into false certainty. Without AGRIFUR env vars the bot runs exactly as the
original (local ESP32 sink only).

## Language

The original bot is **Marathi-only** (Sarvam `mr-IN` for STT and TTS). It does
not claim Hindi/English voice. For en/hi/mr typed or browser-voice questions,
AGRIFUR's own Assistant page is the fallback.

## Embedding in AGRIFUR

Set `VITE_VOICE_BOT_URL` (e.g. `http://192.168.1.44:7860`) and rebuild the web
app — a "Voice bot" page appears at `/app/voice`, embedding this UI for the
currently selected field, with a link back to the typed Assistant. When the env
var is empty the page is hidden, so default builds are unchanged.
