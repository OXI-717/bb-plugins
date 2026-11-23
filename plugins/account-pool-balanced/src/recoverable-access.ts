/** Recognise persisted edge/network failures without clearing real credential rejection. */
export function isRecoverableAccessError(error: string | null): boolean {
  return error !== null && (
    /^OAuth refresh failed with HTTP 403\.$/u.test(error) ||
    /^OAuth refresh (?:response )?failed due to a network error or timeout\.$/u.test(error) ||
    /^\s*(?:<!doctype html|<html)(?:\s|>)/iu.test(error)
  );
}

/** Only for an explicit Z.AI API-key quota collection, never routing eligibility. */
export function isRecoverableZaiQuotaNetworkError(error: string): boolean {
  return error === "Z.AI quota collection failed: Network request did not complete." ||
    /^Z\.AI quota collection failed: Network request did not complete; code=(?:[A-Z0-9_]+|unknown); category=(?:dns|connect|tls|headers|body|socket|session|abort|timeout|unknown); phase=(?:dns|connect|tls|headers); elapsedMs=\d+\.$/u.test(error) ||
    /^Z\.AI quota collection failed: HTTP (?:429|5\d\d)\.$/u.test(error) ||
    /^Z\.AI quota collection failed: HTTP 200; (?:application rejected the request|no supported quota measurement); [A-Za-z0-9_=;(), -]+\.$/u.test(error);
}


/** A manual Gemini quota check may revalidate this stored licence refusal.
 * This predicate never changes routing eligibility or clears the refusal. */
export function isGeminiSubscriptionDenial(error: string): boolean {
  if (error.length > 65536) return false;
  try {
    const root: unknown = JSON.parse(error);
    if (!root || typeof root !== "object" || !("error" in root)) return false;
    const detail = root.error;
    if (!detail || typeof detail !== "object" || !("code" in detail) || detail.code !== 403 ||
      !("status" in detail) || detail.status !== "PERMISSION_DENIED" ||
      !("details" in detail) || !Array.isArray(detail.details)) return false;
    return detail.details.some(item => item !== null && typeof item === "object" &&
      "reason" in item && item.reason === "SUBSCRIPTION_REQUIRED");
  } catch { return false; }
}
