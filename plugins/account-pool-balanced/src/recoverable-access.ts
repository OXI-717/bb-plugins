/** Recognise persisted edge/network failures without clearing real credential rejection. */
export function isRecoverableAccessError(error: string | null): boolean {
  return error !== null && (
    /^OAuth refresh failed with HTTP 403\.$/u.test(error) ||
    /^OAuth refresh (?:response )?failed due to a network error or timeout\.$/u.test(error) ||
    /^\s*(?:<!doctype html|<html)(?:\s|>)/iu.test(error)
  );
}
