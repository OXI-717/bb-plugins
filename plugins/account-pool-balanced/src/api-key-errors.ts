import { AccountAuthorizationRequiredError } from "./provider-adapter.js";

export class ApiKeyRejectedError extends AccountAuthorizationRequiredError {
  constructor(readonly expired: boolean) {
    super(expired ? "API key expired." : "API key rejected.");
  }
  override get accountMessage(): string {
    return this.expired
      ? "[API_KEY_EXPIRED] Срок ключа истёк. Создайте новый ключ в кабинете провайдера и замените его в пуле. Повторный вход не продлевает ключ."
      : "[API_KEY_REJECTED] Провайдер отклонил ключ. Проверьте или замените его в пуле.";
  }
}

// Never retain upstream messages: they can contain account and credential data.
// Bound both bytes and time even when an error response never finishes streaming.
export async function apiKeyFailure(response: Response): Promise<ApiKeyRejectedError | null> {
  if (response.status !== 401 && response.status !== 403) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body?.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let code: unknown;
    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (reader && (mediaType === "application/json" || mediaType?.endsWith("+json"))) {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Error response deadline")), 2000);
      });
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await Promise.race([reader.read(), deadline]);
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 8192) throw new Error("Error response too large");
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (data && typeof data === "object" && "error" in data) {
        const error = data.error;
        if (error && typeof error === "object" && "code" in error) code = error.code;
      }
    }
    if (code === "api_key_expired") return new ApiKeyRejectedError(true);
    if (response.status === 401 || code === "invalid_api_key" || code === "api_key_revoked")
      return new ApiKeyRejectedError(false);
    return null;
  } catch {
    return response.status === 401 ? new ApiKeyRejectedError(false) : null;
  } finally {
    clearTimeout(timer);
    void reader?.cancel().catch(() => undefined);
  }
}
