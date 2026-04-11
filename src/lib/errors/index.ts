export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'PERMISSION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVARIANT_VIOLATION'
  | 'PROVIDER_INTEGRATION_ERROR'
  | 'INTERNAL_SERVER_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, statusCode: number, details?: unknown) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details?: unknown) {
    super('VALIDATION_ERROR', message, 400, details);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required', details?: unknown) {
    super('AUTHENTICATION_ERROR', message, 401, details);
  }
}

export class PermissionError extends AppError {
  constructor(message = 'You do not have permission to perform this action', details?: unknown) {
    super('PERMISSION_ERROR', message, 403, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', details?: unknown) {
    super('NOT_FOUND', message, 404, details);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict detected', details?: unknown) {
    super('CONFLICT', message, 409, details);
  }
}

export class InvariantViolationError extends AppError {
  constructor(message = 'Business invariant violated', details?: unknown) {
    super('INVARIANT_VIOLATION', message, 422, details);
  }
}

export class ProviderIntegrationError extends AppError {
  constructor(message = 'Provider integration failed', details?: unknown) {
    super('PROVIDER_INTEGRATION_ERROR', message, 502, details);
  }
}

export class InternalServerError extends AppError {
  constructor(message = 'Internal server error', details?: unknown) {
    super('INTERNAL_SERVER_ERROR', message, 500, details);
  }
}
