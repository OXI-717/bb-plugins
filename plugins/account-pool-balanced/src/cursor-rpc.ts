export const CURSOR_RPC_PATH_HEADER = "x-bb-cursor-rpc-path";

// Keep the upstream host fixed. Accept new methods within Cursor RPC namespaces,
// never arbitrary URLs, traversal, encoded separators or authentication endpoints.
export function isCursorRpcPath(path: string): boolean {
  return /^(?:aiserver|agent)\.v[0-9]+\.[A-Za-z][A-Za-z0-9]*\/[A-Za-z][A-Za-z0-9]*$/.exec(path)?.[0] === path
    || ["settings", "v1/traces", "v1/bundle/archive"].includes(path);
}
