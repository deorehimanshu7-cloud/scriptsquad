import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useFieldStore } from '@/lib/state/field';
import { api } from '@/lib/api/client';

interface Message {
  id: string; role: 'user' | 'assistant'; content: string;
  tool_calls?: { name: string; ok?: boolean; error?: string }[];
  evidence_refs?: string[];
}

type VoicePhase = 'idle' | 'listening' | 'processing' | 'answering' | 'unsupported' | 'offline';

declare global {
  interface Window { webkitSpeechRecognition?: any; SpeechRecognition?: any; }
}

const LANG_BY_LOCALE: Record<string, string> = { en: 'en-IN', hi: 'hi-IN', mr: 'mr-IN' };

export default function AssistantPage() {
  const { t, i18n } = useTranslation();
  const { currentField } = useFieldStore();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle');
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const recRef = useRef<any>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // backend reachability (truthful online/offline state)
  const pingBackend = useCallback(async () => {
    try {
      const r = await fetch('/api/health', { method: 'GET' });
      setBackendOk(r.ok);
    } catch { setBackendOk(false); }
  }, []);
  useEffect(() => {
    pingBackend();
    const id = setInterval(pingBackend, 30000);
    return () => clearInterval(id);
  }, [pingBackend]);

  // start/reuse a field-scoped session whenever the field changes
  const ensureSession = useCallback(async () => {
    if (!currentField) return null;
    try {
      const list = await api.get<any>(`/assistant/sessions?field_id=${currentField.id}`);
      const existing = Array.isArray(list.data) ? list.data[0] : null;
      if (existing) {
        setSessionId(existing.id);
        const msgs = await api.get<any>(`/assistant/sessions/${existing.id}/messages`);
        setMessages((msgs.data || []).map((m: any) => ({
          id: m.id, role: m.role, content: m.content || '',
          tool_calls: m.tool_calls || [], evidence_refs: m.evidence_refs || [],
        })));
        return existing.id;
      }
      const r = await api.post<any>('/assistant/sessions', { field_id: currentField.id, language: i18n.language });
      setSessionId(r.data?.id || null);
      setMessages([]);
      return r.data?.id || null;
    } catch { setBackendOk(false); return null; }
  }, [currentField, i18n.language]);

  useEffect(() => {
    if (currentField) { setSessionId(null); setMessages([]); ensureSession(); }
  }, [currentField?.id, ensureSession]);

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || loading) return;
    if (!sessionId) await ensureSession();
    if (!sessionId) {
      setMessages((p) => [...p, { id: `e-${Date.now()}`, role: 'assistant', content: 'No assistant session could be created — check that the backend is running.' }]);
      return;
    }
    const userMsg: Message = { id: Date.now().toString(), role: 'user', content };
    setMessages((p) => [...p, userMsg]);
    setInput('');
    setLoading(true);
    setVoicePhase((v) => (v === 'listening' ? 'processing' : v));
    try {
      const r = await api.post<any>('/assistant/messages', { session_id: sessionId, message: content, language: i18n.language });
      const msg = r.data?.message || r.data;
      const aiMsg: Message = {
        id: (Date.now() + 1).toString(), role: 'assistant',
        content: msg?.content || r.data?.content || 'The assistant returned no content.',
        tool_calls: r.data?.tool_calls || msg?.tool_calls || [],
        evidence_refs: r.data?.evidence_refs || msg?.evidence_refs || [],
      };
      setMessages((p) => [...p, aiMsg]);
    } catch (e: any) {
      const code = e?.response?.data?.error?.code;
      const msg = e?.response?.data?.error?.message;
      setMessages((p) => [...p, {
        id: `e-${Date.now()}`, role: 'assistant',
        content: code === 'VALIDATION' ? `Field context required: ${msg}` : `Connection error: ${msg || e?.message || 'Could not reach the AI backend.'}`,
      }]);
      setBackendOk(false);
    } finally {
      setLoading(false);
      setVoicePhase('idle');
    }
  };

  // ── Push-to-talk (browser SpeechRecognition; language follows the UI) ─────
  const speechSupported = typeof window !== 'undefined' && !!(window.webkitSpeechRecognition || window.SpeechRecognition);

  const stopListening = () => {
    try { recRef.current?.stop(); } catch { /* noop */ }
    setVoicePhase('idle');
  };

  const startListening = () => {
    if (loading) return;
    if (!speechSupported) { setVoicePhase('unsupported'); return; }
    if (!navigator.onLine || backendOk === false) { setVoicePhase('offline'); return; }
    const SR: any = window.webkitSpeechRecognition || window.SpeechRecognition;
    const rec = new SR();
    rec.lang = LANG_BY_LOCALE[i18n.language] || 'en-IN';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    recRef.current = rec;
    rec.onstart = () => setVoicePhase('listening');
    rec.onerror = (ev: any) => setVoicePhase(ev?.error === 'not-allowed' ? 'unsupported' : 'idle');
    rec.onresult = (ev: any) => {
      const transcript = ev.results?.[0]?.[0]?.transcript as string | undefined;
      setVoicePhase('processing');
      if (transcript) send(transcript);
    };
    rec.onend = () => setVoicePhase((v) => (v === 'processing' || v === 'answering' ? v : 'idle'));
    try { rec.start(); } catch { setVoicePhase('unsupported'); }
  };

  if (!currentField) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <div className="text-6xl mb-4">🤖</div>
        <h2 className="text-xl font-semibold text-slate-200 mb-2">{t('assistant.title')}</h2>
        <p className="text-slate-400">{t('world.no_field')}</p>
      </div>
    );
  }

  const voiceLabel = { idle: 'Push to talk', listening: 'Listening…', processing: 'Processing…', answering: 'Answering…', unsupported: 'Voice not supported', offline: 'Offline' }[voicePhase];
  const voiceColor = { idle: 'bg-slate-700 hover:bg-slate-600', listening: 'bg-red-600 animate-pulse', processing: 'bg-amber-600', answering: 'bg-emerald-600', unsupported: 'bg-slate-700', offline: 'bg-slate-800' }[voicePhase];
  const isListening = voicePhase === 'listening';

  return (
    <div className="flex flex-col h-full">
      <div className="bg-slate-800 border-b border-slate-700 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-lg">🤖</div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-slate-200 leading-tight">{t('assistant.title')}</h2>
            <p className="text-xs text-slate-400">Field context: {currentField.name} · {currentField.area_hectares ? `${Number(currentField.area_hectares).toFixed(2)} ha` : 'area unknown'}</p>
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border ${backendOk === false ? 'border-rose-500/40 bg-rose-500/10 text-rose-300' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${backendOk === false ? 'bg-rose-400' : backendOk === true ? 'bg-emerald-400' : 'bg-slate-400'}`} />
              {backendOk === false ? 'backend offline' : backendOk === true ? 'online' : 'checking…'}
            </span>
            <span className="text-slate-500">voice: {speechSupported ? (navigator.onLine ? 'browser STT' : 'offline unavailable') : 'not supported'}</span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center py-10">
            <div className="text-5xl mb-4">🌾</div>
            <h3 className="text-lg font-semibold text-slate-200 mb-2">Ask about {currentField.name}</h3>
            <p className="text-slate-400 text-sm max-w-md mx-auto mb-6">
              The assistant reasons over the World Model, evidence and domain tools for this field only.
              Sensor-aware tools report OBSERVED readings with real timestamps; missing data is never invented.
            </p>
            <div className="flex flex-wrap gap-2 justify-center">
              {[
                'What is the current state of this field?',
                'What are the latest sensor readings?',
                'Are the sensors healthy and calibrated?',
                'What should I observe next?',
                'Why might my crop be stressed?',
              ].map((q) => (
                <button key={q} onClick={() => setInput(q)} className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-300 hover:text-slate-200 hover:border-blue-500/50">{q}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[76%] rounded-xl px-4 py-3 ${msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-slate-800 border border-slate-700 text-slate-200'}`}>
              <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
              {(msg.tool_calls || []).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {(msg.tool_calls || []).map((tc, i) => (
                    <span key={i} title={tc.error ? `tool error: ${tc.error}` : tc.ok === false ? 'tool failed' : ''} className={`px-2 py-0.5 text-[11px] rounded-full ${tc.ok === false ? 'bg-rose-500/20 text-rose-300' : 'bg-purple-500/20 text-purple-300'}`}>🔧 {tc.name}</span>
                  ))}
                </div>
              )}
              {(msg.evidence_refs || []).length > 0 && (
                <div className="mt-1.5 text-[10px] text-slate-500">{msg.evidence_refs!.length} evidence record(s) grounded this answer</div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 flex items-center gap-2">
              <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" /><div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" style={{ animationDelay: '0.15s' }} /><div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" style={{ animationDelay: '0.3s' }} />
              <span className="text-xs text-slate-400 ml-1">Reasoning over field evidence…</span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="bg-slate-800 border-t border-slate-700 px-4 py-3">
        <div className="flex gap-2">
          <textarea value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={t('assistant.placeholder')} rows={1}
            className="flex-1 px-4 py-2.5 bg-slate-700 border border-slate-600 rounded-lg text-slate-200 placeholder-slate-400 focus:outline-none focus:border-blue-500 resize-none text-sm" />
          <button onClick={isListening ? stopListening : startListening}
            title={voiceLabel}
            className={`px-4 py-2 rounded-lg text-sm font-medium text-slate-200 transition-colors ${voiceColor}`}>
            {isListening ? '⏹' : '🎙️'}
          </button>
          <button onClick={() => send()} disabled={!input.trim() || loading}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 text-white font-medium rounded-lg text-sm">Send</button>
        </div>
        {voicePhase !== 'idle' && (
          <div className="text-[11px] text-slate-400 mt-2 flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${voicePhase === 'listening' ? 'bg-red-400 animate-pulse' : 'bg-slate-500'}`} />
            {voiceLabel}{voicePhase === 'unsupported' ? ' — this browser has no SpeechRecognition. Type instead.' : ''}
            {voicePhase === 'offline' ? ' — voice needs the backend; check connectivity.' : ''}
          </div>
        )}
      </div>
    </div>
  );
}
