import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public isOperational = true
  ) {
    super(message);
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const error = err as AppError;
  const requestId = req.headers['x-request-id'] as string;

  console.error(`[${requestId}] Error:`, {
    message: error.message,
    stack: error.stack,
    statusCode: error.statusCode
  });

  // Handle specific error types
  if (error.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      error: 'Validation error',
      message: error.message,
      request_id: requestId
    });
  }

  if (error.name === 'UnauthorizedError') {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Invalid or missing authentication token',
      request_id: requestId
    });
  }

  if (error.name === 'NotFoundError') {
    return res.status(404).json({
      success: false,
      error: 'Not found',
      message: error.message,
      request_id: requestId
    });
  }

  // Default server error
  const statusCode = error.statusCode || 500;
  const message = error.isOperational ? error.message : 'Internal server error';

  res.status(statusCode).json({
    success: false,
    error: message,
    request_id: requestId,
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
  });
};
