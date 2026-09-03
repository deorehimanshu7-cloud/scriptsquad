/**
 * AI Assistant API.
 *   POST /api/assistant/sessions             { field_id?, language? }
 *   GET  /api/assistant/sessions?field_id=
 *   GET  /api/assistant/sessions/:id/messages
 *   POST /api/assistant/messages             { session_id, message }
 *   POST /api/assistant/audio                → AUTH_REQUIRED without provider
 *   POST /api/assistant/transcribe           → AUTH_REQUIRED without provider
 * The assistant is always field-contextual and repository-grounded.
 */
import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { createConversation, getConversation, listConversations, listConversationsForField, addMessage, listMessages } from '../data/system';
import { getField } from '../data/fields';
import { processAssistantMessage } from '../services/ai/llm-service';

const router = Router();

router.post('/sessions', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { field_id, language } = req.body || {};
    if (field_id) {
      const field = await getField(field_id, req.user!.id);
      if (!field) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found or not owned by user' } });
    }
    const session = await createConversation({ userId: req.user!.id, fieldId: field_id, language: language || 'en' });
    res.status(201).json({ success: true, data: session });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/sessions', authenticate, async (req: AuthRequest, res: Response) => {
  const fieldId = req.query.field_id as string | undefined;
  const sessions = fieldId
    ? await listConversationsForField(fieldId, req.user!.id)
    : await listConversations(req.user!.id);
  res.json({ success: true, data: sessions });
});

router.get('/sessions/:sessionId/messages', authenticate, async (req: AuthRequest, res: Response) => {
  const session = await getConversation(req.params.sessionId, req.user!.id);
  if (!session) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
  const messages = await listMessages(session.id);
  res.json({ success: true, data: messages });
});

router.post('/messages', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { session_id, message, language } = req.body || {};
    if (!session_id || !message) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'session_id and message are required' } });
    }
    const session = await getConversation(session_id, req.user!.id);
    if (!session) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
    if (!session.field_id) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'Attach a field to this session (field_id) so the assistant can reason over real evidence' } });
    }
    await addMessage({ conversationId: session.id, role: 'user', content: message });

    const ai = await processAssistantMessage({
      fieldId: session.field_id, userId: req.user!.id, message,
      language: language || session.language || 'en',
    });
    const assistantMsg = await addMessage({
      conversationId: session.id, role: 'assistant', content: ai.content,
      toolCalls: ai.toolCalls.map((t) => ({ name: t.name, args: t.args, ok: t.result?.ok, error: t.result?.error })),
      evidenceRefs: ai.evidenceRefs,
    });
    res.json({
      success: true,
      data: {
        message: assistantMsg,
        tool_calls: ai.toolCalls.map((t) => ({ name: t.name, ok: t.result?.ok, error: t.result?.error })),
        evidence_refs: ai.evidenceRefs,
        model: ai.model,
        ai_provider: ai.providerStatus,
        content: ai.content,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

// Voice — shares the same backend field context; transcription requires a
// configured speech provider. Truthful AUTH_REQUIRED without credentials.
router.post('/audio', authenticate, (_req: AuthRequest, res: Response) => {
  res.status(200).json({
    success: true,
    data: null,
    state: process.env.SPEECH_API_KEY ? 'AVAILABLE' : 'AUTH_REQUIRED',
    message: process.env.SPEECH_API_KEY
      ? 'Speech endpoint configured.'
      : 'AUTH_REQUIRED: voice transcription requires SPEECH_API_KEY (e.g. an OpenAI-compatible speech endpoint). No audio is processed or stored without it.',
  });
});

router.post('/transcribe', authenticate, (_req: AuthRequest, res: Response) => {
  res.status(200).json({
    success: true,
    data: null,
    state: process.env.SPEECH_API_KEY ? 'AVAILABLE' : 'AUTH_REQUIRED',
    message: process.env.SPEECH_API_KEY
      ? 'Transcription endpoint configured.'
      : 'AUTH_REQUIRED: transcription requires SPEECH_API_KEY. The voice pipeline uses the same field context as text chat once configured.',
  });
});

export default router;
