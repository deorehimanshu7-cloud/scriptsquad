"""
AGRIFUR — EXISTING FARMER AI VOICE BOT (integrated, not rebuilt)
================================================================
This is the user's existing voice bot, preserved as the voice engine:
Gradio web UI (microphone) -> SarvamAI STT (saaras:v3, mr-IN) ->
SarvamAI chat (sarvam-105b) -> SarvamAI TTS (bulbul:v3, ratan) -> play.

AGRIFUR integration is ADDITIVE and OPT-IN via environment variables:
  * SARVAM_API_SUBSCRIPTION_KEY   (required, server-side secret — never commit)
  * AGRIFUR_AI_CONTEXT_URL        optional: AGRIFUR backend base URL, e.g.
                                  http://192.168.1.44:3001
  * AGRIFUR_TOKEN                 optional bearer token for the AGRIFUR API
  * AGRIFUR_DEFAULT_FIELD_ID      optional field used when no field is given
  * VOICE_PORT / VOICE_SHARE      Gradio launch settings

When AGRIFUR_AI_CONTEXT_URL is configured, every answer is grounded on the
field's COMPLETE AGRIFUR context (GET /api/fields/{id}/ai-context): world
model, live sensors, satellite catalog, weather, soil, water, terrain, crop,
risks/anomalies/uncertainties/contradictions, investigations, actions and farm
history. The briefing is assembled from whatever the endpoint returns —
missing items stay missing (NO_DATA / UNKNOWN / NOT_CONFIGURED) and the prompt
forbids inventing values — so any question about the farm can be answered from
the recorded data, and questions about unavailable data are answered honestly.
Without any AGRIFUR env vars this file behaves exactly like the original
standalone bot (local ESP32 sink only).

HTTP endpoints (Flask, port 5000):
  POST/GET /sensor-data   ESP32 live sensor sink (original)
  POST /voice/query       JSON {field_id?, message} -> text answer (adapter)
  GET  /voice/health      status for integration checks
Gradio UI: http://0.0.0.0:7860 (or VOICE_PORT).
"""

import os
import threading
import time

import gradio as gr
from flask import Flask, request, jsonify

try:
    import requests  # for the optional AGRIFUR context fetch
except Exception:  # pragma: no cover - only needed when AGRIFUR context is used
    requests = None

from sarvamai import SarvamAI
from sarvamai.play import save

# =========================================
# CONFIG (env — never hardcode secrets)
# =========================================

SARVAM_API_KEY = os.environ.get("SARVAM_API_SUBSCRIPTION_KEY", "").strip()
AGRIFUR_CONTEXT_URL = os.environ.get("AGRIFUR_AI_CONTEXT_URL", "").strip().rstrip("/")
AGRIFUR_TOKEN = os.environ.get("AGRIFUR_TOKEN", "").strip()
AGRIFUR_DEFAULT_FIELD_ID = os.environ.get("AGRIFUR_DEFAULT_FIELD_ID", "").strip()

if not SARVAM_API_KEY:
    print("\n⚠️  SARVAM_API_SUBSCRIPTION_KEY is not set — set it in the environment")
    print("   before using the voice bot (export SARVAM_API_SUBSCRIPTION_KEY=...)\n")

client = SarvamAI(api_subscription_key=SARVAM_API_KEY) if SARVAM_API_KEY else None

# =========================================
# LIVE ESP32 SENSOR SERVER (original)
# =========================================

sensor_server = Flask(__name__)

latest_sensor_data = {
    "soil_moisture": None,
    "temperature": None,
    "humidity": None,
    "light": None,
    "updated_at": None,
}


@sensor_server.post("/sensor-data")
def receive_sensor_data():
    global latest_sensor_data
    data = request.get_json(force=True)
    latest_sensor_data = {
        "soil_moisture": data.get("soil_moisture"),
        "temperature": data.get("temperature"),
        "humidity": data.get("humidity"),
        "light": data.get("light"),
        "updated_at": time.time(),
    }
    print("\n📡 LIVE ESP32 DATA:")
    print(latest_sensor_data)
    return jsonify({"status": "ok"})


@sensor_server.get("/sensor-data")
def get_sensor_data():
    return jsonify(latest_sensor_data)


# Start ESP32 sensor server
threading.Thread(
    target=lambda: sensor_server.run(
        host="0.0.0.0",
        port=5000,
        debug=False,
        use_reloader=False,
    ),
    daemon=True,
).start()

print("📡 ESP32 sensor server running on port 5000")


# =========================================
# AGRIFUR CONTEXT (optional, additive)
# =========================================

def live_sensor_context() -> str:
    """Local ESP32 sink context (original behaviour)."""
    if latest_sensor_data["soil_moisture"] is not None:
        return f"""
LIVE ESP32 SENSOR DATA (local sink):
Soil moisture: {latest_sensor_data["soil_moisture"]}%
Temperature: {latest_sensor_data["temperature"]}°C
Air humidity: {latest_sensor_data["humidity"]}%
"""
    return ""


def fetch_agrifur_context(field_id: str):
    """Fetch the controlled AGRIFUR context for a field. Never raw DB access."""
    if not AGRIFUR_CONTEXT_URL:
        return None
    if not field_id and AGRIFUR_DEFAULT_FIELD_ID:
        field_id = AGRIFUR_DEFAULT_FIELD_ID
    if not field_id:
        return None
    if requests is None:
        return None
    try:
        headers = {"Content-Type": "application/json"}
        if AGRIFUR_TOKEN:
            headers["Authorization"] = f"Bearer {AGRIFUR_TOKEN}"
        resp = requests.get(
            f"{AGRIFUR_CONTEXT_URL}/api/fields/{field_id}/ai-context",
            headers=headers,
            timeout=12,
        )
        if resp.status_code != 200:
            print(f"⚠️  AGRIFUR context fetch failed: HTTP {resp.status_code}")
            return None
        return resp.json()
    except Exception as exc:  # network/timeouts — never block the farmer
        print(f"⚠️  AGRIFUR context fetch error: {exc}")
        return None


# ---------------------------------------------------------------------------
# Complete field briefing — assembled from EVERY section the AGRIFUR endpoint
# returns. Only recorded values appear; each carries its truth state.
# ---------------------------------------------------------------------------

def _d(v, fallback="—"):
    return v if v is not None and v != "" else fallback


def _ev_lines(entries, limit=8, prefix="  "):
    lines = []
    for e in (entries or [])[:limit]:
        if not isinstance(e, dict):
            continue
        label = e.get("sub_type") or e.get("sensor_type") or e.get("description") or e.get("domain") or "item"
        val = e.get("value")
        unit = e.get("unit") or ""
        state = e.get("state") or e.get("freshness") or "UNKNOWN"
        when = str(e.get("observed_at") or e.get("last_at") or e.get("acquired_at") or "")[:19]
        src = e.get("source") or e.get("device_id") or e.get("satellite") or ""
        lines.append(f"{prefix}- {label} = {_d(val)} {unit} [{state}] @ {when}{(' (' + str(src) + ')') if src else ''}")
    return lines


def build_agrifur_briefing(ctx) -> str:
    """Complete, evidence-only briefing of the field from the AGRIFUR context."""
    if not ctx or not isinstance(ctx, dict):
        return ""

    lines = ["AGRIFUR FIELD DATA (complete recorded picture of the selected field):"]

    # --- field & farm ------------------------------------------------------
    f = ctx.get("field") or {}
    farm = ctx.get("farm") or {}
    area_ha = round(float(f["area_m2"]) / 10_000.0, 2) if f.get("area_m2") else None
    header = f"Field: {_d(f.get('name'))} (id {_d(f.get('id'))})"
    if f.get("crop_name"):
        header += f", crop: {f['crop_name']}"
    if farm.get("name"):
        header += f", farm: {farm['name']}"
    if f.get("centroid_lat") is not None:
        header += f", centre: {f['centroid_lat']}, {f['centroid_lon']}"
    if area_ha:
        header += f", area: {area_ha} ha"
    lines.append(header)

    # --- world model states ------------------------------------------------
    wm = ctx.get("world_model") or {}
    for d in (wm.get("domains") or [])[:12]:
        if isinstance(d, dict):
            lines.append(f"- world model {d.get('domain')}: state {_d(d.get('state'))} ({_d(d.get('count'), 0)} item(s)) — {_d(d.get('summary'))}")

    # --- sensors -----------------------------------------------------------
    s = ctx.get("sensors") or {}
    lines.append(f"Sensors: state {_d(s.get('state'))} — {_d(s.get('reason'))}")
    obs = s.get("observations") or []
    if obs:
        lines.append("  Latest real sensor readings (OBSERVED):")
        lines.extend(_ev_lines(obs, limit=12))

    # --- satellite ---------------------------------------------------------
    sat = ctx.get("satellite") or {}
    products = sat.get("products") or []
    lines.append(f"Satellite: state {_d(sat.get('state'))} — {_d(sat.get('reason'))}")
    if products:
        latest = products[0]
        if isinstance(latest, dict):
            lines.append(
                f"  Latest product: {_d(latest.get('satellite'))} {_d(latest.get('processing_level'))} "
                f"acquired {str(latest.get('acquired_at'))[:10]} cloud {_d(latest.get('cloud_cover'))}% "
                f"type {_d(latest.get('product_type'))} resolution {_d(latest.get('resolution_m'))} m "
                f"source {_d(latest.get('source_url'))}"
            )
        lines.append(f"  {len(products)} real product(s) catalogued (newest shown); metadata is OBSERVED.")

    # --- evidence domains --------------------------------------------------
    for key, label in (("weather", "Weather"), ("soil", "Soil"), ("water", "Water"), ("terrain", "Terrain"), ("crop", "Crop")):
        block = ctx.get(key) or {}
        if not block:
            continue
        lines.append(f"{label}: state {_d(block.get('state'))} — {_d(block.get('summary'))}")
        if block.get("entries"):
            lines.extend(_ev_lines(block.get("entries"), limit=6))

    # --- intelligence ------------------------------------------------------
    intel = ctx.get("intelligence") or {}
    for r in (intel.get("risks") or [])[:6]:
        if isinstance(r, dict):
            lines.append(f"- risk {r.get('risk_type')}: level {r.get('level')} — {_d(r.get('reason'))} (status {_d(r.get('status'))})")
    for a in (intel.get("anomalies") or [])[:5]:
        if isinstance(a, dict):
            lines.append(f"- anomaly {a.get('kind')}: severity {_d(a.get('severity'))} — {_d(a.get('description'))} (detected {str(a.get('detected_at'))[:10]})")
    for u in (intel.get("uncertainties") or [])[:5]:
        if isinstance(u, dict):
            lines.append(f"- uncertainty ({_d(u.get('domain'))}): {_d(u.get('kind'))} level {_d(u.get('level'))} — {_d(u.get('reason'))}")
    for c in (intel.get("contradictions") or [])[:5]:
        if isinstance(c, dict):
            lines.append(f"- contradiction: {_d(c.get('reason'))} (relationship {_d(c.get('relationship'))}, status {_d(c.get('status'))})")

    # --- investigations ----------------------------------------------------
    for inv in (ctx.get("investigations") or [])[:2]:
        if not isinstance(inv, dict):
            continue
        lines.append(f"- investigation [{inv.get('status')}]: {_d(inv.get('title'))} — {_d(inv.get('problem'))}")
        for h in (inv.get("hypotheses") or [])[:3]:
            if isinstance(h, dict):
                lines.append(f"    hypothesis ({_d(h.get('status'))}): {_d(h.get('statement'))}")
        for n in (inv.get("next_observations") or [])[:2]:
            if isinstance(n, dict):
                lines.append(f"    next observation ({_d(n.get('rank'))}): {_d(n.get('observation'))}")

    # --- actions -----------------------------------------------------------
    for a in (ctx.get("actions") or [])[:6]:
        if isinstance(a, dict):
            lines.append(f"- action {_d(a.get('kind'))} ({_d(a.get('status'))}): {_d(a.get('title'))} — {_d(a.get('description'))}")

    # --- farm history ------------------------------------------------------
    mem = (ctx.get("memory") or [])[:6]
    for m in mem:
        if isinstance(m, dict):
            lines.append(f"- history ({_d(m.get('kind'))}, {str(m.get('happened_at'))[:10]}): {_d(m.get('title'))} — {_d(m.get('summary'))}")

    lines.append(
        "RULES: Everything above is the ONLY real data for this field. If the farmer asks "
        "about something not listed — or listed as NO_DATA / NOT_CONFIGURED / UNKNOWN — say it "
        "is currently unavailable and what that means for the advice. Never invent a sensor "
        "reading, weather, soil, satellite, risk or confidence number. When indicators "
        "conflict, say you are not confident instead of averaging them into false certainty."
    )
    return "\n".join(lines)


# =========================================
# SHARED ANSWER PATH (one AI, two entries)
# =========================================

def generate_answer(question: str, context_text: str) -> str:
    """Original SarvamAI chat call — reused by the audio UI and /voice/query."""
    if client is None:
        return "माफ करा, AI सेवा सुरू नाही (API key चुकत आहे)."

    response = client.chat.completions(
        model="sarvam-105b",
        reasoning_effort=None,
        temperature=0.2,
        max_tokens=500,
        messages=[
            {
                "role": "system",
                "content": """
तुम्ही महाराष्ट्रातील शेतकऱ्यांसाठी कृषी सहाय्यक आहात.

शेतकऱ्यांच्या प्रश्नांची उत्तरे सोप्या,
नैसर्गिक आणि समजण्यास सोप्या मराठी भाषेत द्या.

नियम:
- उत्तर थोडक्यात आणि स्पष्ट द्या.
- प्रत्यक्ष उपयोगी माहिती द्या.
- अनावश्यक तांत्रिक भाषा टाळा.
- माहिती निश्चित नसेल तर अंदाज लावू नका.
- धोकादायक औषधांची मात्रा अंदाजाने सांगू नका.
- शक्य असल्यास कारण आणि पुढील कृती सांगा.
- उत्तर मोठ्याने ऐकवण्यासाठी योग्य असावे.
""",
            },
            {
                "role": "user",
                "content": f"""
FARMER QUESTION:
{question}

{context_text}

Use the supplied context when it is relevant to the farmer's question.

Important:
- Do not invent sensor values, weather, soil, satellite or risk values.
- If the question asks about current soil moisture, temperature, humidity, weather, crop condition, etc., use the recorded value from the context.
- If that value is missing or marked NO_DATA / NOT_CONFIGURED / UNKNOWN, say it is currently unavailable and explain what that means for the advice.
- Clearly distinguish a measured value from an agricultural recommendation.
- When indicators conflict, say you are not confident instead of averaging them into false certainty.
""",
            },
        ],
    )

    answer = response.choices[0].message.content
    if not answer:
        answer = "माफ करा, मला सध्या योग्य उत्तर मिळाले नाही."
    return answer


def gather_context(field_id: str):
    """Returns (context_text, ctx_dict, used_local)."""
    ctx = fetch_agrifur_context(field_id)
    if ctx:
        return build_agrifur_briefing(ctx), ctx, False
    return live_sensor_context(), None, True


# =========================================
# VOICE / TEXT ENTRY POINTS
# =========================================

def farmer_ai(audio_file):
    """Original Gradio entry: audio -> STT -> grounded AI -> Marathi TTS."""
    if audio_file is None:
        return "कृपया आधी प्रश्न विचारा.", None

    try:
        print("\n🎙️ Processing voice...")

        with open(audio_file, "rb") as f:
            stt = client.speech_to_text.transcribe(
                file=f,
                model="saaras:v3",
                mode="transcribe",
                language_code="mr-IN",
            )
        question = stt.transcript

        print("👨‍🌾 Farmer:")
        print(question)

        context_text, ctx, used_local = gather_context(AGRIFUR_DEFAULT_FIELD_ID)
        if used_local and not context_text:
            context_text = "No sensor data is currently available."

        print("🧠 AI thinking...")
        answer = generate_answer(question, context_text)

        print("🤖 AI:")
        print(answer)

        print("🔊 Creating Marathi audio...")
        audio = client.text_to_speech.convert(
            text=answer,
            model="bulbul:v3",
            language_code="mr-IN",
            speaker="ratan",
        )
        output_file = "farmer_answer.wav"
        save(audio, output_file)

        print("✅ Complete!")
        return answer, output_file

    except Exception as e:
        print("\n❌ ERROR:")
        print(e)
        return f"Error: {e}", None


@sensor_server.post("/voice/query")
def voice_query():
    """Text adapter: AGRIFUR (or any client) -> this bot's existing AI.

    Body: {"field_id": "fld_...", "message": "Should I irrigate?"}
    Returns the same grounded answer the mic path would produce (no second AI).
    TTS stays in the Gradio UI; this endpoint is for chat/typing integrations.
    """
    body = request.get_json(silent=True) or {}
    message = (body.get("message") or "").strip()
    if not message:
        return jsonify({"error": "message is required"}), 400

    field_id = (body.get("field_id") or AGRIFUR_DEFAULT_FIELD_ID or "").strip()
    context_text, ctx, used_local = gather_context(field_id)
    answer = generate_answer(message, context_text)

    return jsonify(
        {
            "answer": answer,
            "mode": "SARVAM_105B",
            "source_context": "agrifur_full" if ctx else ("local_sensors" if used_local else "none"),
            "field_id": field_id or None,
            "data_state": (ctx.get("world_model") or {}).get("domains") if ctx else {},
            "investigations": len((ctx or {}).get("investigations") or []),
            "actions": len((ctx or {}).get("actions") or []),
        }
    )


@sensor_server.get("/voice/health")
def voice_health():
    return jsonify(
        {
            "ok": True,
            "service": "agrifur-voice-bot",
            "sarvam_configured": bool(client),
            "agrifur_context_configured": bool(AGRIFUR_CONTEXT_URL),
            "sensor_data_available": latest_sensor_data["soil_moisture"] is not None,
            "time": time.time(),
        }
    )


# =========================================
# USER INTERFACE (original Gradio UI)
# =========================================

with gr.Blocks(title="Farmer AI") as app:

    gr.Markdown(
        """
        # 🌾 Farmer AI

        ### शेतकीबद्दल तुमचा प्रश्न विचारा

        **मराठीत बोला → AI उत्तर देईल → उत्तर ऐका**
        """
    )

    microphone = gr.Audio(
        sources=["microphone"],
        type="filepath",
        format="wav",
        label="🎙️ तुमचा प्रश्न रेकॉर्ड करा",
    )

    ask_button = gr.Button("🌾 प्रश्न विचारा", variant="primary")

    answer_text = gr.Textbox(label="🤖 AI चे उत्तर", lines=5)

    answer_audio = gr.Audio(label="🔊 मराठी उत्तर", type="filepath", autoplay=True)

    ask_button.click(fn=farmer_ai, inputs=microphone, outputs=[answer_text, answer_audio])


# =========================================
# START (bind 0.0.0.0 so the browser/iframe on the LAN can reach it)
# =========================================

if __name__ == "__main__":
    app.launch(
        share=os.environ.get("VOICE_SHARE", "0") == "1",
        server_name="0.0.0.0",
        server_port=int(os.environ.get("VOICE_PORT", "7860")),
    )
