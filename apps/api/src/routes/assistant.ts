import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db";
import { HttpError, getOwnedField, requireAuth } from "../http";
import { answerForField, appendMessage, createSession, getSession, listSessions, sessionMessages } from "../services/assistant";
import { getFieldRow } from "../services/worldModel";
import { buildAiContext, type AiFocus } from "../services/aiContext";

const AI_FOCUSES: AiFocus[] = ["sensors", "satellite", "weather", "soil", "water", "terrain", "crop", "intelligence", "all"];

const newSessionSchema = z.object({
  field_id: z.string().optional().nullable(),
  title: z.string().max(160).optional(),
});

const messageSchema = z.object({
  content: z.string().min(1).max(4000),
});

export function assistantRoutes(db: AppDb): Router {
  const r = Router();
  r.use(requireAuth(db));

  r.get("/fields/:id/ai-context", (req, res, next) => {
    try {
      // Field isolation: only the owner (or an admin) may read a field's context.
      const f = getOwnedField(db, req.params.id, req.user!);
      const rawFocus = typeof req.query.focus === "string" ? req.query.focus : "all";
      const focus = (AI_FOCUSES as string[]).includes(rawFocus) ? (rawFocus as AiFocus) : "all";
      res.json({ ai_context: buildAiContext(db, f.id, { focus }) });
    } catch (e) {
      next(e);
    }
  });

  r.get("/assistant/sessions", (req, res) => {
    const fieldId = typeof req.query.field_id === "string" ? req.query.field_id : undefined;
    res.json({ sessions: listSessions(db, req.user!.id, fieldId) });
  });

  r.post("/assistant/sessions", (req, res, next) => {
    try {
      const body = newSessionSchema.parse(req.body);
      let fieldId: string | null = body.field_id ?? null;
      if (fieldId) getOwnedField(db, fieldId, req.user!);
      const id = createSession(db, req.user!.id, fieldId, body.title ?? "New session");
      const session = getSession(db, req.user!.id, id);
      res.status(201).json({ session });
    } catch (e) {
      next(e);
    }
  });

  r.get("/assistant/sessions/:id", (req, res, next) => {
    try {
      const session = getSession(db, req.user!.id, req.params.id);
      if (!session) throw new HttpError(404, "NOT_FOUND", "Session not found");
      res.json({ session, messages: sessionMessages(db, session.id) });
    } catch (e) {
      next(e);
    }
  });

  r.post("/assistant/sessions/:id/messages", async (req, res, next) => {
    try {
      const session = getSession(db, req.user!.id, req.params.id);
      if (!session) throw new HttpError(404, "NOT_FOUND", "Session not found");
      const body = messageSchema.parse(req.body);
      appendMessage(db, session.id, "user", body.content);
      const history = sessionMessages(db, session.id).map((m) => ({ role: m.role, content: m.content }));

      if (!session.field_id) {
        // no field context — ask for one, honestly
        const answer = {
          answer:
            "No field is attached to this conversation yet. Start a session with a field selected, or tell me which field to focus on. I only answer about fields whose evidence I can actually read.",
          mode: "LOCAL_GROUNDED_FALLBACK" as const,
          evidence: [],
          uncertainty: "No field context.",
          next_action: "Pick a field and open a new session.",
        };
        appendMessage(db, session.id, "assistant", answer.answer, answer);
        res.json({ message: { role: "assistant", content: answer.answer, meta: answer, created_at: new Date().toISOString() }, answer });
        return;
      }
      const field = getFieldRow(db, session.field_id);
      if (!field || (field.user_id !== req.user!.id && req.user!.role !== "admin")) {
        throw new HttpError(403, "FORBIDDEN", "Session field is not accessible");
      }
      const answer = await answerForField(db, session.field_id, body.content, history);
      appendMessage(db, session.id, "assistant", answer.answer, answer);
      const messages = sessionMessages(db, session.id);
      res.json({ message: messages[messages.length - 1], answer });
    } catch (e) {
      next(e);
    }
  });

  return r;
}