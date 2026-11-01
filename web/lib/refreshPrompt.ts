/**
 * Copy and decisions shared by the refresh password dialog and the refresh
 * API. No Node imports, so the browser bundle can use it.
 */

/** `code` of the 429 sent while wrong-password lockout is in force. */
export const TOO_MANY_ATTEMPTS_CODE = "too_many_attempts";

export const WRONG_PASSWORD_MESSAGE = "Wrong password";

export function tooManyAttemptsMessage(minutes: number): string {
  const n = Math.max(1, Math.ceil(minutes));
  return `Too many wrong attempts. Try again in ${n} ${n === 1 ? "minute" : "minutes"}.`;
}

export interface RefreshRejection {
  error?: string;
  code?: string;
  minutesLeft?: number;
}

/**
 * The inline error the password dialog shows for a refresh response, or null
 * when the response is not about the password (the dialog then closes and the
 * usual toast or progress panel takes over).
 */
export function passwordError(status: number, payload: RefreshRejection, sentKey: boolean): string | null {
  if (status === 401) return sentKey ? WRONG_PASSWORD_MESSAGE : "Enter the password.";
  if (status === 429 && payload.code === TOO_MANY_ATTEMPTS_CODE) {
    return tooManyAttemptsMessage(payload.minutesLeft ?? 15);
  }
  return null;
}
