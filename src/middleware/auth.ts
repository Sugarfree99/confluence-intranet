import { Request, Response, NextFunction } from "express";
import * as jwt from "jsonwebtoken";
import * as winston from "winston";

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";

export interface AuthRequest extends Request {
  user?: {
    id: string;
    role: string;
  };
}

/**
 * Verify JWT token
 */
export function verifyToken(token: string): any {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    logger.error("Invalid token", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Generate JWT token
 */
export function generateToken(userId: string, role: string = "user"): string {
  return jwt.sign(
    { id: userId, role, timestamp: Date.now() },
    JWT_SECRET,
    { expiresIn: "24h" }
  );
}

/**
 * Middleware for authenticating requests
 */
export function authenticateToken(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      error: "Access token required",
    }) as any;
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(403).json({
      success: false,
      error: "Invalid or expired token",
    }) as any;
  }

  req.user = decoded;
  next();
}

/**
 * Middleware for admin-only routes
 */
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({
      success: false,
      error: "Admin access required",
    }) as any;
  }
  next();
}

/**
 * Optional authentication (doesn't block, just extracts user if present)
 */
export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (token) {
    const decoded = verifyToken(token);
    if (decoded) {
      req.user = decoded;
    }
  }

  next();
}
