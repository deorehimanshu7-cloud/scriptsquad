import { useEffect, useRef, useState } from "react";
import { useApp } from "../../lib/state";
import { useI18n } from "../../lib/i18n";
import { assistantApi, toast } from "../../lib/api";
import { Badge, Card, EmptyState, Hint, Spinner } from "../../components/ui";
import { OneTapVoice, SPEECH_BCP47, pickVoice, type VoicePhase } from "../../components/voice/OneTapVoice";
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