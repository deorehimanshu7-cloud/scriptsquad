/**
 * Event system — persisted system events + in-process pub/sub for SSE.
 * Every meaningful state change emits an event (FIELD_CREATED,
 * OBSERVATION_RECEIVED, SATELLITE_ACQUIRED, ANOMALY_DETECTED, ...).
 */
import { insertEvent, listEvents } from '../data/system';

type Listener = (event: { id: string; type: string; field_id?: string | null; user_id?: string | null; data: any; created_at: string }) => void;

const listeners = new Set<Listener>();
const sseClients = new Set<(event: string) => void>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerSseClient(send: (payload: string) => void): () => void {
  sseClients.add(send);
  return () => sseClients.delete(send);
}

export async function emitEvent(type: string, data: Record<string, unknown>, context?: { fieldId?: string; userId?: string }): Promise<any> {
  const event = await insertEvent({
    type,
    fieldId: context?.fieldId,
    userId: context?.userId,
    data,
  });
  const payload = JSON.stringify({
    id: event.id,
    type: event.type,
    field_id: event.field_id,
    user_id: event.user_id,
    data: event.data,
    created_at: event.created_at,
  });
  for (const l of listeners) l(JSON.parse(payload));
  for (const send of sseClients) send(`data: ${payload}\n\n`);
  return event;
}

export function queryEvents(input: { fieldId?: string; type?: string; limit?: number }): Promise<any[]> {
  return listEvents(input);
}
