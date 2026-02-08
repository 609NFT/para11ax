/**
 * Error handling utilities
 */

/**
 * Safely extract an error message from unknown error types
 * @param error - The error object (unknown type)
 * @returns A string representation of the error
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Safely extract error stack trace from unknown error types
 * @param error - The error object (unknown type)
 * @returns The stack trace or undefined if not available
 */
export function getErrorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}