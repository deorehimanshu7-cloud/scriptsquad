import { useEffect, useRef, useState } from "react";
import { useApp } from "../../lib/state";
import { useI18n } from "../../lib/i18n";
import { assistantApi, toast } from "../../lib/api";
import { Badge, Card, EmptyState, Hint, Spinner } from "../../components/ui";
import { RequireField } from "./AppLayout";
import { timeAgo } from "../../lib/format";
import type { AssistantMessage, AssistantSession } from "../../lib/types";

/**
 * AGRIFUR AI Assistant — one-tap natural voice interaction.
 *
 *   ONE TAP → LISTENING → (VAD silence detection) → AUTO-STOP →
 *   STT (browser Web Speech API, mr-IN/hi-IN/en-IN) → AUTO-SEND →
 *   grounded AGRIFUR answer → AUTO-TTS (Marathi/Hindi/English voice) → play
 *
 * No second "Ask/Submit" button exists in the voice path. The text input
 * remains only as an accessibility fallback for typing.
 *
 * VAD: the microphone stream feeds an AnalyserNode; when RMS energy stays
 * below the threshold for SILENCE_DURATION_MS the recording auto-stops.
 * SpeechRecognition also ends on end-of-speech — whichever fires first wins,
 * guarded so a question is only ever sent once.
 */

// Voice-activity-detection configuration (milliseconds). Keep honest: these are
// tunable constants, not "AI" — the rules are printed nowhere as intelligence.
const VAD = {
  ENABLED: true,
  SILENCE_DURATION_MS: 1200,
  MIN_SPEECH_DURATION_MS: 500,
  PRE_SPEECH_PADDING_MS: 200,
  POST_SPEECH_PADDING_MS: 300,
  NO_SPEECH_TIMEOUT_MS: 15_000,
  MAX_LISTEN_MS: 60_000,
  /** RMS (0..1) above which audio counts as speech */
  RMS_THRESHOLD: 0.018,
};

type VoicePhase = "idle" | "listening" | "processing" | "answering" | "error";

export default function Assistant() {
  return (
    <RequireField>
      <AssistantInner />
    </RequireField>
  );
}

function AssistantInner() {
  const { activeField, refreshToken } = useApp();
  const field = activeField!;
  const { lang, t } = useI18n();
  const [sessions, setSessions] = useState<AssistantSession[] | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<string | null>(null);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [interim, setInterim] = useState("");
  const [ttsMuted, setTtsMuted] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const langRef = useRef(lang);
  langRef.current = lang;
  const ttsMutedRef = useRef(ttsMuted);
  ttsMutedRef.current = ttsMuted;
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;
  const fieldIdRef = useRef(field.id);
  fieldIdRef.current = field.id;

  useEffect(() => {
    setSessions(null);
    void assistantApi.sessions(field.id).then((r) => {
      setSessions(r.sessions);
      if (r.sessions.length > 0) openSession(r.sessions[0].id);
      else setSessionId(null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field.id, refreshToken]);

  const openSession = async (id: string) => {
    setSessionId(id);
    setBusy(false);
    setVoicePhase("idle");
    const res = await assistantApi.getSession(id);
    setMessages(res.messages);
    setMode(null);
  };

  const newSession = async () => {
    const res = await assistantApi.createSession({ field_id: field.id, title: "Field session" });
    setSessions((s) => [res.session, ...(s ?? [])]);
    setSessionId(res.session.id);
    setMessages([]);
    setMode(null);
  };

  const send = async (text: string) => {
    const clean = text.trim();
    const sid = sessionIdRef.current;
    if (!clean || !sid) return;
    setInput("");
    setBusy(true);
    setVoicePhase("processing");
    setVoiceError(null);
    try {
      const res = await assistantApi.send(sid, clean);
      setMessages((m) => [
        ...m,
        { id: crypto.randomUUID(), session_id: sid, role: "user", content: clean, meta: null, created_at: new Date().toISOString() },
        res.message,
      ]);
      setMode(res.answer.mode);
      speak(res.message.content);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Send failed", "error");
      setVoicePhase("error");
      setVoiceError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(false);
    }
  };

  /** Auto-play the Marathi/Hindi/English answer. Falls back to text only. */
  const speak = (text: string) => {
    if (ttsMutedRef.current) {
      setVoicePhase("idle");
      return;
    }
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setVoicePhase("idle");
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
    setVoicePhase("answering");
    utter.onend = () => setVoicePhase("idle");
    utter.onerror = () => setVoicePhase("idle");
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  if (!sessions) return <div className="page"><Spinner label="Loading sessions…" /></div>;

  return (
    <div className="page" style={{ maxWidth: 1200 }}>
      <div className="page-head">
        <div>
          <div className="page-title">AI assistant — {field.name}</div>
          <div className="page-sub">
            Answers are grounded in this field's actual evidence. Without an LLM key the assistant falls back to a
            local grounded mode and says so — it never invents data.
          </div>
        </div>
        <button className="btn btn-primary" onClick={newSession} type="button">+ New session</button>
      </div>

      {sessions.length === 0 && !sessionId ? (
        <EmptyState
          emoji="💬"
          title="No assistant sessions for this field"
          body="Start a session to ask grounded questions about this field's world model and evidence."
          action={<button className="btn btn-primary" onClick={newSession} type="button">Start session</button>}
        />
      ) : (
        <div className="grid" style={{ gridTemplateColumns: "240px 1fr", alignItems: "start", height: "calc(100vh - 210px)", minHeight: 420 }}>
          <div className="col" style={{ gap: 6, maxHeight: "100%", overflowY: "auto", paddingRight: 4 }}>
            {sessions.map((s) => (
              <button
                key={s.id}
                className={`btn ${sessionId === s.id ? "btn-primary" : ""}`}
                style={{ justifyContent: "flex-start", textAlign: "left", whiteSpace: "normal" }}
                onClick={() => openSession(s.id)}
                type="button"
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: 12.5 }}>{s.title}</div>
                  <div className="faint" style={{ fontSize: 10.5 }}>{timeAgo(s.created_at)}</div>
                </div>
              </button>
            ))}
          </div>

          <Card className="col" style={{ height: "100%", padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {sessionId ? (
              <>
                <div className="row spread" style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
                  <span className="faint" style={{ fontSize: 12 }}>session {sessionId.slice(0, 8)}…</span>
                  <div className="row" style={{ gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ padding: "3px 8px", fontSize: 12 }}
                      onClick={() => setTtsMuted((m) => !m)}
                      title={t("assist.ttsMuted")}
                    >
                      {ttsMuted ? "🔇" : "🔊"}
                    </button>
                    {mode && (
                      <Badge className={`ps-${mode === "LLM" ? "AVAILABLE" : "NO_DATA"}`}>
                        {mode === "LLM" ? "LLM mode" : mode === "AUTH_REQUIRED" ? "LLM AUTH_REQUIRED" : "local grounded fallback"}
                      </Badge>
                    )}
                  </div>
                </div>
                <div ref={scrollRef} className="chat-scroll" style={{ padding: 14 }}>
                  {messages.length === 0 && (
                    <Hint>Ask about this field: “माझ्या शेतात सध्या ओलावा किती आहे?” · “What is the current water situation?” · “Is there any evidence of heat stress?”</Hint>
                  )}
                  {messages.map((m) => (
                    <div key={m.id} className={`msg ${m.role === "user" ? "msg-user" : "msg-bot"}`}>
                      {m.content}
                      {m.role === "assistant" && <AssistantMeta meta={m.meta} t={t} />}
                    </div>
                  ))}
                  {voicePhase === "processing" && (
                    <div className="row" style={{ gap: 8, padding: 4 }}><span className="spinner" /><span className="faint">{t("assist.processing")}</span></div>
                  )}
                </div>
                <div className="col" style={{ padding: "10px 12px", borderTop: "1px solid var(--border)", gap: 8 }}>
                  <OneTapVoice
                    lang={langRef.current}
                    disabled={busy}
                    phase={voicePhase}
                    interim={interim}
                    onPhase={setVoicePhase}
                    onInterim={setInterim}
                    onError={setVoiceError}
                    onTranscript={(text) => {
                      void send(text);
                    }}
                    t={t}
                  />
                  <div className="row" style={{ gap: 8 }}>
                    <input
                      ref={inputRef}
                      className="input grow"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) void send(input);
                      }}
                      placeholder={t("assist.typeInstead")}
                      disabled={busy || voicePhase === "listening"}
                    />
                    <button className="btn" onClick={() => void send(input)} disabled={busy || !input.trim()} type="button">
                      {t("assist.send")}
                    </button>
                  </div>
                  {(voiceError || interim) && (
                    <div className="faint" style={{ fontSize: 11.5, fontStyle: "italic" }}>
                      {voiceError ?? (voicePhase === "listening" ? `“${interim}”` : "")}
                    </div>
                  )}
                  <div className="faint" style={{ fontSize: 10.5 }}>
                    🎙 One tap → speak → silence stops recording automatically → transcript is sent through the same
                    grounded field pipeline as typed questions (language: {SPEECH_BCP47[lang]}).
                  </div>
                </div>
              </>
            ) : (
              <EmptyState emoji="💬" title="No session selected" action={<button className="btn btn-primary" onClick={newSession} type="button">Start session</button>} />
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

/** BCP-47 speech tags follow the active UI language. */
const SPEECH_BCP47: Record<string, string> = { en: "en-IN", hi: "hi-IN", mr: "mr-IN" };

/** Prefer a Marathi voice, then Hindi, then any Indian-English voice. */
function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  if (voices.length === 0) return null;
  const want = [SPEECH_BCP47[lang], lang, "hi-IN", "mr-IN", "en-IN"];
  for (const w of want) {
    const v = voices.find((v) => v.lang.replace("_", "-").toLowerCase() === w.toLowerCase());
    if (v) return v;
  }
  return voices.find((v) => /^(mr|hi|en)-/i.test(v.lang)) ?? null;
}

/** Minimal typing for the Web Speech API — not part of the TS DOM lib. */
type SpeechRecResult = { isFinal: boolean; 0: { transcript: string } };
type SpeechRecEvent = { results: { length: number; [i: number]: SpeechRecResult } };
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: SpeechRecEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

function speechCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

interface OneTapVoiceProps {
  lang: string;
  disabled: boolean;
  phase: VoicePhase;
  interim: string;
  onPhase: (p: VoicePhase) => void;
  onInterim: (s: string) => void;
  onError: (s: string | null) => void;
  onTranscript: (text: string) => void;
  t: (key: string) => string;
}

/**
 * One-tap voice control.
 *
 * Tap → LISTENING. The browser recogniser transcribes while a Web Audio
 * AnalyserNode watches energy: after SILENCE_DURATION_MS of quiet the
 * recording auto-stops, the transcript auto-sends, and the phase machine
 * (LISTENING → PROCESSING → ANSWERING → IDLE) runs without any second click.
 */
function OneTapVoice({ lang, disabled, phase, interim, onPhase, onInterim, onError, onTranscript, t }: OneTapVoiceProps) {
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef("");
  const sentRef = useRef(false);
  const stopRef = useRef<() => void>(() => {});
  const phaseRef = useRef<VoicePhase>(phase);
  phaseRef.current = phase;

  useEffect(() => () => {
    stopRef.current();
    recRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopAll = () => {
    stopRef.current();
    try {
      recRef.current?.stop();
    } catch {
      /* already stopped */
    }
  };

  const finalize = () => {
    const text = finalRef.current.trim();
    finalRef.current = "";
    if (text && !sentRef.current) {
      sentRef.current = true;
      onTranscript(text);
    } else if (!text && phaseRef.current === "listening") {
      onPhase("idle");
    }
  };

  const startVad = async (): Promise<() => void> => {
    if (!VAD.ENABLED) return () => {};
    let mediaStream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let raf = 0;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(mediaStream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const startMs = performance.now();
      let speechStartMs = 0;
      let silenceMs = 0;
      let lastTick = startMs;
      const tick = (nowMs: number) => {
        const dt = nowMs - lastTick;
        lastTick = nowMs;
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const talking = rms > VAD.RMS_THRESHOLD;
        const elapsed = nowMs - startMs;
        if (talking) {
          if (speechStartMs === 0) speechStartMs = nowMs;
          silenceMs = 0;
        } else if (speechStartMs > 0) {
          silenceMs += dt;
        }
        const speechMs = speechStartMs > 0 ? nowMs - speechStartMs : 0;
        if (speechMs >= VAD.MIN_SPEECH_DURATION_MS && silenceMs >= VAD.SILENCE_DURATION_MS) {
          stopAll(); // end of speech → auto-stop
          return;
        }
        if (speechStartMs === 0 && elapsed > VAD.NO_SPEECH_TIMEOUT_MS) {
          onError(t("assist.noSpeech"));
          stopAll();
          return;
        }
        if (elapsed > VAD.MAX_LISTEN_MS) {
          stopAll();
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => {
        cancelAnimationFrame(raf);
        mediaStream?.getTracks().forEach((tr) => tr.stop());
        void audioCtx?.close().catch(() => {});
      };
    } catch {
      // No mic stream (denied/unavailable) — SpeechRecognition still works in
      // most browsers and ends on its own end-of-speech; degrade honestly.
      return () => {};
    }
  };

  const start = async () => {
    const Ctor = speechCtor();
    if (!Ctor) {
      onError("Voice input is not supported by this browser (no Web Speech API)");
      onPhase("error");
      return;
    }
    if (disabled || phase === "processing" || phase === "answering") return;
    sentRef.current = false;
    finalRef.current = "";
    onInterim("");
    onError(null);
    onPhase("listening");

    stopRef.current = await startVad();

    const rec = new Ctor();
    rec.lang = SPEECH_BCP47[lang] ?? "en-IN";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let interimText = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalRef.current += r[0].transcript;
        else interimText += r[0].transcript;
      }
      onInterim(interimText);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        onError(t("assist.micDenied"));
        onPhase("error");
      } else if (e.error === "no-speech") {
        onError(t("assist.noSpeech"));
        onPhase("error");
      } else if (e.error !== "aborted") {
        onError(`Voice: ${e.error}`);
        onPhase("error");
      }
    };
    rec.onend = () => {
      stopRef.current();
      onInterim("");
      if (phaseRef.current === "listening") finalize();
    };
    recRef.current = rec;
    try {
      rec.start();
    } catch {
      stopRef.current();
      onPhase("idle");
      onError(t("assist.micError"));
    }
  };

  const stop = () => {
    onInterim("");
    finalize();
    stopAll();
  };

  const phaseLabel: Record<VoicePhase, string> = {
    idle: t("assist.tapToTalk"),
    listening: t("assist.listening"),
    processing: t("assist.processing"),
    answering: t("assist.answering"),
    error: t("assist.tapToTalk"),
  };

  const listening = phase === "listening";
  return (
    <div className="row" style={{ gap: 10, alignItems: "center" }}>
      <button
        type="button"
        className={`btn ${listening ? "btn-danger" : "btn-primary"}`}
        onClick={listening ? stop : () => void start()}
        disabled={disabled && !listening}
        style={{ minWidth: 220, justifyContent: "center", padding: "10px 14px", fontSize: 15, fontWeight: 600 }}
        title={listening ? t("assist.stop") : t("assist.tapToTalk")}
      >
        {listening ? `🔴 ${phaseLabel.listening}` : phase === "processing" ? `🧠 ${phaseLabel.processing}` : phase === "answering" ? `🔊 ${phaseLabel.answering}` : `🎙️ ${phaseLabel.idle}`}
      </button>
      {(phase === "processing" || phase === "answering") && <span className="spinner" />}
      {listening && (
        <span className="faint" style={{ fontSize: 12, fontStyle: "italic", maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {interim ? `“${interim}”` : t("assist.listening")}
        </span>
      )}
    </div>
  );
}

function AssistantMeta({ meta, t }: { meta: unknown; t: (key: string) => string }) {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as { mode?: string; evidence?: { id: string; domain: string; sub_type: string; state: string }[]; uncertainty?: string };
  if (!m.evidence && !m.uncertainty) return null;
  return (
    <div style={{ marginTop: 8, borderTop: "1px dashed var(--border)", paddingTop: 8, fontSize: 12 }}>
      {m.evidence && m.evidence.length > 0 && (
        <div className="row" style={{ gap: 4 }}>
          <span className="faint">{t("assist.fieldDataUsed")}:</span>
          {m.evidence.slice(0, 5).map((e) => (
            <Badge key={e.id} className={`ts-${e.state}`}>{e.domain}:{e.sub_type}</Badge>
          ))}
        </div>
      )}
      {m.uncertainty && <div className="faint mt-8">uncertainty: {m.uncertainty}</div>}
      {m.mode && <div className="faint mt-8">mode: {m.mode}</div>}
    </div>
  );
}