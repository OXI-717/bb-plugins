import { z } from "zod";
const uuid = z.string().uuid();
export function requestIdFor(
  storage: Pick<Storage, "getItem" | "setItem">,
  scope: string,
): string {
  const key = `model-connections-request:${scope}`;
  const previous = storage.getItem(key);
  if (previous !== null) return uuid.parse(previous);
  const id = crypto.randomUUID();
  storage.setItem(key, id);
  if (storage.getItem(key) !== id)
    throw Error("Не удалось сохранить запрос. Проверьте хранилище браузера");
  return id;
}
export function completeRequestId(
  storage: Pick<Storage, "getItem" | "removeItem">,
  scope: string,
  id: string,
) {
  const key = `model-connections-request:${scope}`;
  if (storage.getItem(key) === id) storage.removeItem(key);
}
