import { expect, it } from "vitest";
import { isCursorRpcPath } from "./cursor-rpc.js";

it.each(["aiserver.v2.FutureService/NewMethod", "agent.v1.AgentService/RunSSE", "settings", "v1/traces", "v1/bundle/archive"])("accepts Cursor RPC %s", path => {
  expect(isCursorRpcPath(path)).toBe(true);
});
it.each(["", "https://other.example/path", "//other.example/path", "../auth/login", "auth/exchange_user_api_key", "agent.v1.AgentService/../Login", "agent.v1.AgentService/Run?redirect=x", "agent.v1.AgentService/Run%2FLogin", "other.v1.Service/Run", "agent.v1.AgentService/Run\n"])("rejects unsafe or unrelated path %s", path => {
  expect(isCursorRpcPath(path)).toBe(false);
});
