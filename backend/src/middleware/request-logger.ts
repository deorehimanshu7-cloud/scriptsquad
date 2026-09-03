import { Request, Response, NextFunction } from 'express';

export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const requestId = req.headers['x-request-id'] as string;

  // Log request
  console.log(`[${requestId}] ${req.method} ${req.path}`, {
    query: req.query,
    ip: req.ip,
    user_agent: req.get('user-agent')
  });

  // Log response
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${requestId}] ${req.method} ${req.path} ${res.statusCode}`, {
      duration: `${duration}ms`,
      content_length: res.get('content-length')
    });
  });

  next();
};
