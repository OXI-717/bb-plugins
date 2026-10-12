import {z} from 'zod';

export const TASK_DETAIL_PANEL_ID = 'project-task-detail';

const taskTargetSchema = z.object({
  projectId: z.string().regex(/^proj_[A-Za-z0-9_-]+$/),
  source: z.enum(['linear', 'github', 'jira']),
  locator: z.string().min(1).max(2000)
}).strict();

export function parseTaskPanelTarget(params: unknown): TaskLinkTarget | null {
  const parsed = taskTargetSchema.safeParse(params);
  return parsed.success ? parsed.data : null;
}
export type TaskLinkTarget = z.infer<typeof taskTargetSchema>;

export function parseTaskLink(attributes: Readonly<Record<string, string>>): TaskLinkTarget | null {
  try {
    const parsed = taskTargetSchema.safeParse({
      projectId: attributes.project,
      source: attributes.source,
      locator: decodeURIComponent(attributes.locator ?? '')
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function taskItemSubPath(target: TaskLinkTarget): string {
  const locator = encodeURIComponent(target.locator).replaceAll('~', '%7E').replaceAll('%', '~');
  return `item/${encodeURIComponent(target.projectId)}/${target.source}/${locator}`;
}

export function taskLinkDirective(item: {bbProjectId: string; source: TaskLinkTarget['source']; locator: string; key?: string}): string {
  const target = taskTargetSchema.parse({projectId:item.bbProjectId,source:item.source,locator:item.locator});
  const label = item.key ? ` label="${encodeURIComponent(item.key.slice(0, 120))}"` : '';
  return `::project-task{project="${target.projectId}" source="${target.source}" locator="${encodeURIComponent(target.locator)}"${label}}`;
}

export function taskLinkInstructions(projectId: string): string {
  if (!/^proj_[A-Za-z0-9_-]+$/.test(projectId)) return '';
  return `Задачи Linear, GitHub Issues и Jira открываем в боковой панели текущего треда через плагин oxi-projects.
Текущий BB project ID: ${projectId}. Для подтверждённой задачи в ответе выведи отдельной строкой директиву (без code fence):
::project-task{project="${projectId}" source="linear" locator="canonical-locator" label="TEAM-123"}
Замени source и locator проверенными значениями. locator — encodeURIComponent точного поля locator из bb project-work list; для Linear это UUID, а не видимый ключ DEMO-123. label — необязательный encodeURIComponent короткого ключа задачи. Директива показывает кнопку карточки задачи в боковой панели, сохраняя текущий тред; внешний URL можно дать дополнительно, если пользователь просит.
Сначала найди задачу: bb project-work list --project <BB_ID> --source <source> --query <key> --json. Проверка: bb project-work show <linear|github|jira> '<raw locator>' --project <BB_ID> --json. В CLI передавай исходный locator БЕЗ encodeURIComponent (например 'o/r#1', не 'o%2Fr%231'); учитывай shell quoting. Кодирование нужно только при ручном формировании атрибута директивы. Ответ show содержит готовую projectLink — копируй её точно, без повторного кодирования. CLI и карточка используют подключения oxi-projects, отдельный плагин Linear не требуется.
Не угадывай владельца задачи по совпадению команды Linear или имени проекта. Для чужого проекта явно проверь его BB ID; при неоднозначности уточни выбор. Общий Workspace Hub не определяет предметный проект задачи.
Открытие карточки ничего не запускает. Для новой сессии пользователь нажимает «Подготовить тред», выбирает модель/окружение и отправляет из редактора BB. Не вызывай startThread отдельного Linear-плагина ради такого перехода.`;
}
