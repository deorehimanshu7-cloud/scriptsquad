/**
 * One-tap voice control, shared by the AI assistant workspace and the dedicated
 * voice-bot page.
 *
 *   ONE TAP → LISTENING → (VAD silence detection) → AUTO-STOP →
 *   STT (browser Web Speech API, mr-IN/hi-IN/en-IN) → AUTO-SEND →
 *   grounded AGRIFUR answer → AUTO-TTS (Marathi/Hindi/English voice) → play
 *
 * No second "Ask/Submit" button exists in the voice path. The text input in the
 * assistant workspace remains only as an accessibility fallback for typing.
 *
 * VAD: the microphone stream feeds an AnalyserNode; when RMS energy stays below
 * the threshold for SILENCE_DURATION_MS the recording auto-stops.
 * SpeechRecognition also ends on end-of-speech — whichever fires first wins,
 * guarded so a question is only ever sent once.
 *
 * Extracted verbatim from the assistant page so the voice bot is the same engine
 * rather than a second, divergent implementation.
 */
import { useEffect, useRef } from "react";

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

export type VoicePhase = "idle" | "listening" | "processing" | "answering" | "error";

/** BCP-47 speech tags follow the active UI language. */
export const SPEECH_BCP47: Record<string, string> = { en: "en-IN", hi: "hi-IN", mr: "mr-IN" };

/** Prefer a Marathi voice, then Hindi, then any Indian-English voice. */
export function pickVoice(lang: string): SpeechSynthesisVoice | null {
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
export function OneTapVoice({ lang, disabled, phase, interim, onPhase, onInterim, onError, onTranscript, t }: OneTapVoiceProps) {
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
        {listening
          ? `🔴 ${phaseLabel.listening}`
          : phase === "processing"
            ? `🧠 ${phaseLabel.processing}`
            : phase === "answering"
              ? `🔊 ${phaseLabel.answering}`
              : `🎙️ ${phaseLabel.idle}`}
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
