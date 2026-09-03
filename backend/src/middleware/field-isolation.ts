import { Request, Response, NextFunction } from 'express';
import type { AuthRequest } from './auth';
import { fieldBelongsToUser } from '../data/fields';

/**
 * Field Isolation Middleware — server-side enforcement.
 *
 * Every field-scoped route runs behind this middleware, which verifies in the
 * database that the requested field belongs to the authenticated user before
 * the handler runs. Combined with field_id on every query, cross-field data
 * leakage is impossible: A→B→C switches cannot surface another user's field.
 */
export interface FieldIsolatedRequest extends AuthRequest {
  fieldContext?: {
    fieldId: string;
    userId: string;
  };
}

export const fieldIsolation = async (req: FieldIsolatedRequest, res: Response, next: NextFunction) => {
  const { fieldId } = req.params;
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'User authentication required for field operations' } });
  }
  if (!fieldId) {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Field ID is required' } });
  }

  try {
    const owned = await fieldBelongsToUser(fieldId, userId);
    if (!owned) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found' } });
    }
  } catch (e: any) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL', message: `Field access check failed: ${e.message}` } });
  }

  req.fieldContext = { fieldId, userId };
  next();
};
