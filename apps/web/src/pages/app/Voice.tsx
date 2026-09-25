import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../../lib/state";
import { useI18n } from "../../lib/i18n";
import { assistantApi, toast } from "../../lib/api";
import { Badge, Card, Hint, Spinner } from "../../components/ui";
import { OneTapVoice, SPEECH_BCP47, pickVoice, type VoicePhase } from "../../components/voice/OneTapVoice";
import { RequireField } from "./AppLayout";
import type { AssistantMessage } from "../../lib/types";

/**
 * Farmer voice bot.
 *
 * Two modes, chosen by configuration:
 *  - VITE_VOICE_BOT_URL set → embed that external bot (Sarvam Farmer AI, see
 *    voicebot/) unchanged, exactly as before.
 *  - otherwise → the BUILT-IN grounded voice bot. This used to be a dead card
 *    that only apologised and linked away, so "voice bot not working" was the
 *    honest reading of it. It now runs the same one-tap speech loop as the
 *    assistant workspace and answers from this field's recorded evidence.
 */
const VOICE_BOT_URL = (import.meta.env.VITE_VOICE_BOT_URL as string | undefined)?.trim() ?? "";

export default function VoicePage() {
  return (
    <RequireField>
      {VOICE_BOT_URL ? <EmbeddedBot url={VOICE_BOT_URL} /> : <BuiltInVoiceBot />}
    </RequireField>
  );
}

/** External bot embed (unchanged behaviour when the URL is configured). */
function EmbeddedBot({ url }: { url: string }) {
  const { activeField } = useApp();
  const { lang, t } = useI18n();
  const field = activeField!;
  const src = `${url}/?field=${encodeURIComponent(field.id)}&lang=${lang}`;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">
            {t("voice.title")} — {field.name}
          </div>
          <div className="page-sub">{t("voice.sub")}</div>
        </div>
      </div>
      <Card className="col" style={{ flex: 1, minHeight: 560, padding: 0, overflow: "hidden", display: "flex" }}>
        <iframe title="Farmer voice bot" src={src} allow="microphone; autoplay" style={{ width: "100%", height: "100%", border: 0, minHeight: 560 }} />
      </Card>
      <div className="row" style={{ gap: 8, marginTop: 10, alignItems: "center" }}>
        <span className="faint">{t("voice.typeInstead")}</span>
        <Link className="btn btn-ghost btn-sm" to="/app/assistant">
          {t("nav.assistant")}
        </Link>
      </div>
    </div>
  );
}

/** Built-in grounded voice bot: one tap, spoken question, grounded spoken answer. */
function BuiltInVoiceBot() {
  const { activeField, refreshToken } = useApp();
  const field = activeField!;
  const { lang, t } = useI18n();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [interim, setInterim] = useState("");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [asked, setAsked] = useState("");
  const [reply, setReply] = useState<AssistantMessage | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [ttsMuted, setTtsMuted] = useState(false);

  const sessionRef = useRef<string | null>(null);
  sessionRef.current = sessionId;
  const langRef = useRef(lang);
  langRef.current = lang;
  const mutedRef = useRef(ttsMuted);
  mutedRef.current = ttsMuted;

  // Reuse the newest session for this field, or open one. The voice bot and the
  // assistant workspace then share history instead of diverging.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setReply(null);
    setAsked("");
    setPhase("idle");
    void assistantApi
      .sessions(field.id)
      .then(async (r) => {
        if (!alive) return;
        const existing = r.sessions[0];
        if (existing) {
          setSessionId(existing.id);
          const full = await assistantApi.getSession(existing.id);
          if (!alive) return;
          const lastAnswer = [...full.messages].reverse().find((m) => m.role === "assistant") ?? null;
          const lastAsk = [...full.messages].reverse().find((m) => m.role === "user") ?? null;
          setReply(lastAnswer);
          setAsked(lastAsk?.content ?? "");
        } else {
          const created = await assistantApi.createSession({ field_id: field.id, title: "Voice session" });
          if (!alive) return;
          setSessionId(created.session.id);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field.id, refreshToken]);

  const speak = (text: string) => {
    if (mutedRef.current) {
      setPhase("idle");
      return;
    }
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setPhase("idle");
      setVoiceError("This browser has no speech synthesis — the answer is shown as text.");
      return;
    }
    const utter = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(langRef.current);
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang;
    } else {
      utter.lang = SPEECH_BCP47[langRef.current] ?? "en-IN";
    }
    utter.rate = 0.95;
    setPhase("answering");
    utter.onend = () => setPhase("idle");
    utter.onerror = () => setPhase("idle");
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  };

  const ask = async (text: string) => {
    const clean = text.trim();
    const sid = sessionRef.current;
    if (!clean || !sid) return;
    setAsked(clean);
    setDraft("");
    setVoiceError(null);
    setPhase("processing");
    try {
      const res = await assistantApi.send(sid, clean);
      setReply(res.message);
      setMode(res.answer.mode);
      speak(res.message.content);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Ask failed";
      toast(msg, "error");
      setVoiceError(msg);
      setPhase("error");
    }
  };

  const stopSpeaking = () => {
    window.speechSynthesis?.cancel();
    setPhase("idle");
  };

  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <div className="page-head">
        <div>
          <div className="page-title">
            {t("voice.title")} — {field.name}
          </div>
          <div className="page-sub">{t("voice.builtInSub")}</div>
        </div>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <button
            className={`btn btn-sm ${ttsMuted ? "" : "btn-primary"}`}
            onClick={() => { setTtsMuted((m) => !m); window.speechSynthesis?.cancel(); }}
            type="button"
            title={ttsMuted ? t("voice.voiceOn") : t("voice.voiceOff")}
          >
            {ttsMuted ? `🔇 ${t("voice.voiceOff")}` : `🔊 ${t("voice.voiceOn")}`}
          </button>
          {phase === "answering" && (
            <button className="btn btn-sm" onClick={stopSpeaking} type="button">
              {t("assist.stop")}
            </button>
          )}
        </div>
      </div>

      <Card className="col" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span className="badge ps-AVAILABLE">{t("voice.builtIn")}</span>
          {mode && <Badge className={`ps-${mode === "LLM" ? "AVAILABLE" : "NO_DATA"}`}>{mode === "LLM" ? "LLM mode" : "local grounded fallback"}</Badge>}
        </div>

        {loading || !sessionId ? (
          <Spinner label={t("assist.processing")} />
        ) : (
          <OneTapVoice
            lang={lang}
            disabled={false}
            phase={phase}
            interim={interim}
            onPhase={setPhase}
            onInterim={setInterim}
            onError={setVoiceError}
            onTranscript={(text) => void ask(text)}
            t={t}
          />
        )}

        {voiceError && <div className="err-text" style={{ fontSize: 12.5 }}>{voiceError}</div>}

        {/* Typing stays available: speech recognition needs a supported browser
            and a microphone, and the bot must still be usable without either. */}
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="faint" style={{ fontSize: 12.5 }}>{t("assist.typeInstead")}</span>
          <input
            className="input"
            style={{ flex: 1, minWidth: 220 }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void ask(draft);
            }}
            placeholder={t("voice.sub")}
          />
          <button className="btn btn-primary" onClick={() => void ask(draft)} disabled={!draft.trim() || phase === "processing"} type="button">
            {t("assist.send")}
          </button>
        </div>
      </Card>

      {asked && (
        <Card title={t("voice.yourQuestion")} className="mt-12">
          <div style={{ fontSize: 14 }}>{asked}</div>
        </Card>
      )}

      {reply && (
        <Card title={t("voice.lastAnswer")} className="mt-12">
          <div className="row" style={{ gap: 8, marginBottom: 8, alignItems: "center" }}>
            <span className="faint" style={{ fontSize: 12 }}>{t("assist.fieldDataUsed")}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => speak(reply.content)} type="button">
              🔁 Replay
            </button>
          </div>
          <pre style={{ whiteSpace: "pre-wrap", font: "inherit", margin: 0, fontSize: 14, lineHeight: 1.55 }}>{reply.content}</pre>
          <Hint>{t("voice.sub")}</Hint>
        </Card>
      )}
    </div>
  );
}
