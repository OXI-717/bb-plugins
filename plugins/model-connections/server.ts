import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash } from "node:crypto";
import { z } from "zod";
import { classifyConnections, pooledRoutes } from "./catalog";
import { contract, catalogInput } from "./contract";
import { knownSpawnRejection } from "./spawn-rejection";

const poolOutput = z.object({
  routing: z.object({
    codex: z.boolean(),
    claude: z.boolean(),
    kimi: z.boolean(),
    zai: z.boolean(),
    cursor: z.boolean(),
    devin: z.boolean(),
    "opencode-go": z.boolean(),
  }),
  accounts: z
    .array(z.object({ provider: z.string(), enabled: z.boolean() }))
    .max(4096),
});
const hiddenSchema = z.array(z.string().min(1).max(160)).max(512);
export default function plugin(bb: BbPluginApi) {
  const creations = z
    .array(
      z.object({
        id: z.string().uuid(),
        hash: z.string(),
        threadId: z.string().nullable(),
      }),
    )
    .max(64);
  let journalTail: Promise<void> = Promise.resolve();
  function journal<T>(action: () => Promise<T>): Promise<T> {
    const result = journalTail.then(action);
    journalTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async function catalog(input: z.infer<typeof catalogInput>) {
    const signal = AbortSignal.timeout(6000);
    const thread = input.threadId
      ? await bb.sdk.threads.get({ threadId: input.threadId, signal })
      : null;
    const environment = thread?.environmentId
      ? await bb.sdk.environments.get({
          environmentId: thread.environmentId,
          signal,
        })
      : null;
    if (thread && !environment) throw Error("Рабочая среда треда недоступна");
    if (thread && (thread.deletedAt !== null || thread.archivedAt !== null))
      throw Error("Тред недоступен");
    const hosts = await bb.sdk.hosts.list({ signal });
    const hostId =
      environment?.hostId ??
      input.hostId ??
      (await bb.sdk.system.config({ signal })).primaryHostId;
    if (!hostId || !hosts.some((h) => h.id === hostId))
      throw Error("Выберите доступную машину");
    if (thread && input.hostId && input.hostId !== hostId)
      throw Error("Машина треда изменилась");
    const routing = thread?.environmentId
      ? { environmentId: thread.environmentId }
      : { hostId };
    const [providers, states, poolResult, hiddenRaw] = await Promise.all([
      bb.sdk.providers.list({ ...routing, signal }),
      bb.sdk.system.providerStates({ ...routing, signal }),
      bb.sdk.plugins
        .callRpc({
          pluginId: "account-pool-balanced",
          method: "status.get",
          input: null,
          outputSchema: poolOutput,
          signal,
        })
        .then(
          (value) => value,
          () => null,
        ),
      bb.storage.kv.get(`hidden:${hostId}`),
    ]);
    let bypassedProvider: string | null = null;
    let threadRouteUnknown = false;
    if (thread && poolResult) {
      const status = await bb.sdk.plugins
        .callRpc({
          pluginId: "account-pool-balanced",
          method: "thread.account",
          input: { threadId: thread.id },
          outputSchema: z.object({
            state: z.enum([
              "observed",
              "unobserved",
              "bypassed",
              "unsupported",
            ]),
          }),
          signal,
        })
        .catch(() => null);
      if (status?.state === "bypassed") bypassedProvider = thread.providerId;
      if (status === null && pooledRoutes[thread.providerId] !== undefined)
        threadRouteUnknown = true;
    }
    const hidden = hiddenSchema.safeParse(hiddenRaw);
    const connections = classifyConnections(
      providers.map((p) => ({
        id: p.id,
        name: p.displayName,
        available: p.available,
        logoUrl: p.logoUrl,
        icon: p.icon?.glyph ?? "Bot",
      })),
      new Map(states.providers.map((p) => [p.providerId, p.status])),
      poolResult,
      hidden.success ? hidden.data : [],
      bypassedProvider,
    );
    if (threadRouteUnknown)
      for (const row of connections)
        if (row.id === thread?.providerId) {
          row.selectable = false;
          row.detail = "Маршрут треда не подтверждён";
        }
    return {
      hostId,
      hosts: hosts.map((h) => ({ id: h.id, name: h.name })),
      environmentId: thread?.environmentId ?? null,
      projectId: thread?.projectId ?? null,
      currentProviderId: thread?.providerId ?? null,
      poolAvailable: poolResult !== null,
      connections,
    };
  }
  async function apply(input: z.infer<typeof contract.apply.input>) {
    const current = await catalog({ threadId: input.threadId });
    if (current.currentProviderId !== input.providerId)
      throw Error("Другой движок запускается в новом треде");
    const row = current.connections.find((r) => r.id === input.providerId);
    if (!row?.selectable || row.group !== input.expectedGroup)
      throw Error("Подключение изменилось. Обновите список");
    await bb.sdk.threads.update({
      threadId: input.threadId,
      model: input.model,
      reasoningLevel: input.reasoningLevel,
    });
    return { ok: true as const };
  }
  bb.rpc.register(contract, {
    catalog,
    apply,
    visibility: async ({ hostId, providerId, hidden }) => {
      const snapshot = await catalog({ hostId });
      if (!snapshot.connections.some((row) => row.id === providerId))
        throw Error("Подключение не найдено");
      await journal(async () => {
        const stored = await bb.storage.kv.get(`hidden:${hostId}`);
        const ids = (
          stored === null || stored === undefined
            ? []
            : hiddenSchema.parse(stored)
        ).filter((value) => value !== providerId);
        if (hidden) ids.push(providerId);
        await bb.storage.kv.set(`hidden:${hostId}`, hiddenSchema.parse(ids));
      });
      return { ok: true as const };
    },
    create: async ({
      request,
      requestId,
      expectedProviderId,
      expectedGroup,
      sourceThreadId,
    }) => {
      const hash = createHash("sha256")
        .update(
          JSON.stringify({
            request,
            expectedProviderId,
            expectedGroup,
            sourceThreadId,
          }),
        )
        .digest("hex");
      const prior = await journal(async () => {
        const stored = await bb.storage.kv.get("creation-claims");
        const rows =
          stored === null || stored === undefined
            ? []
            : creations.parse(stored);
        return (
          rows.find((row) => row.id === requestId) ??
          rows.find((row) => row.hash === hash && row.threadId === null) ??
          null
        );
      });
      if (prior) {
        if (prior.hash !== hash)
          throw Error("Запрос изменился. Проверьте уже созданные треды");
        if (prior.threadId) return { threadId: prior.threadId };
        throw Error(
          "Запуск уже запрошен. Проверьте список тредов перед повтором",
        );
      }
      if (request.providerId !== expectedProviderId)
        throw Error("Выбрано другое подключение. Вернитесь к списку");
      let hostId: string | undefined;
      if (request.environment.type === "reuse")
        hostId = (
          await bb.sdk.environments.get({
            environmentId: request.environment.environmentId,
          })
        ).hostId;
      else if (
        request.environment.type === "provider" &&
        request.environment.machine?.type === "existing"
      )
        hostId = request.environment.machine.hostId;
      else if (request.environment && "hostId" in request.environment)
        hostId = request.environment.hostId;
      if (!hostId) throw Error("Выберите рабочую среду на конкретной машине");
      const snapshot = await catalog({ hostId });
      const row = snapshot.connections.find((r) => r.id === expectedProviderId);
      if (!row?.selectable || row.group !== expectedGroup)
        throw Error("Подключение изменилось. Обновите список");
      if (sourceThreadId) {
        const source = await bb.sdk.threads.get({ threadId: sourceThreadId });
        if (
          source.projectId !== request.projectId ||
          source.deletedAt !== null ||
          source.archivedAt !== null
        )
          throw Error(
            "Исходный тред недоступен или находится в другом проекте",
          );
      }
      for (const key of ["providerId", "model", "reasoningLevel"] as const)
        if (!request.executionInputSources[key])
          throw Error("Подтвердите выбор модели в форме создания");
      await journal(async () => {
        const stored = await bb.storage.kv.get("creation-claims");
        let rows =
          stored === null || stored === undefined
            ? []
            : creations.parse(stored);
        if (
          rows.some(
            (row) =>
              row.id === requestId ||
              (row.hash === hash && row.threadId === null),
          )
        )
          throw Error("Этот запрос уже отправляется");
        const pending = rows.filter((row) => row.threadId === null);
        if (pending.length >= 64)
          throw Error("Есть неподтверждённые запуски. Проверьте список тредов");
        const capacity = Math.min(47, 63 - pending.length);
        rows = [
          ...pending,
          ...(capacity > 0
            ? rows.filter((row) => row.threadId !== null).slice(-capacity)
            : []),
        ];
        rows.push({ id: requestId, hash, threadId: null });
        await bb.storage.kv.set("creation-claims", rows);
      });
      const created = await bb.sdk.threads
        .spawn({
          ...request,
          ...(sourceThreadId ? { parentThreadId: sourceThreadId } : {}),
        })
        .catch(async (error) => {
          if (knownSpawnRejection(error))
            await journal(async () => {
              const rows = creations.parse(
                await bb.storage.kv.get("creation-claims"),
              );
              await bb.storage.kv.set(
                "creation-claims",
                rows.filter(
                  (row) =>
                    !(
                      row.id === requestId &&
                      row.hash === hash &&
                      row.threadId === null
                    ),
                ),
              );
            });
          throw error;
        });
      await journal(async () => {
        const rows = creations.parse(
          await bb.storage.kv.get("creation-claims"),
        );
        await bb.storage.kv.set(
          "creation-claims",
          rows.map((row) =>
            row.id === requestId ? { ...row, threadId: created.id } : row,
          ),
        );
      });
      return { threadId: created.id };
    },
  });
  bb.cli.register({
    name: "model-connections",
    summary: "Inspect grouped model connections",
    commands: [
      {
        name: "list",
        summary: "List connections on one machine or thread",
        usage: "bb model-connections list [--host ID | --thread ID] [--json]",
      },
    ],
    run: async (argv) => {
      const args = argv.filter((x) => x !== "--json");
      if (
        args[0] !== "list" ||
        ![1, 3].includes(args.length) ||
        (args.length === 3 && !["--host", "--thread"].includes(args[1]))
      )
        return {
          exitCode: 1,
          stderr:
            "bb model-connections list [--host ID | --thread ID] [--json]",
        };
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          await catalog(
            args[1] === "--thread"
              ? { threadId: args[2] }
              : args[1] === "--host"
                ? { hostId: args[2] }
                : {},
          ),
        ),
      };
    },
  });
}
