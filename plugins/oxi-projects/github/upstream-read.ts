// Derived from get-bb/bb plugins/github/server.ts (MIT); see LICENSE.upstream.
interface GhListEntry {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  author?: { login?: unknown };
  labels?: Array<{ name?: unknown }>;
  assignees?: Array<{ login?: unknown }>;
  url?: unknown;
  body?: unknown;
  updatedAt?: unknown;
}
export function parsePaginatedGhApi(raw: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("GitHub API pagination returned a non-array response");
  }
  const rows: Record<string, unknown>[] = [];
  for (const page of parsed) {
    if (!Array.isArray(page)) {
      throw new Error("GitHub API pagination returned a malformed page");
    }
    for (const row of page) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new Error("GitHub API pagination returned a malformed row");
      }
      rows.push(row as Record<string, unknown>);
    }
  }
  return rows;
}

export function readApi(
  gh: (args: string[], timeout?: number) => Promise<string>,
) {
  return {
    async getIssue({ repo, number }: { repo: string; number: number }) {
      const raw = await gh([
        "issue",
        "view",
        String(number),
        "-R",
        repo,
        "--json",
        "number,title,body,state,author,createdAt,updatedAt,labels,assignees,url,comments",
      ]);
      const detail = JSON.parse(raw) as {
        comments?: Array<{
          author?: { login?: unknown };
          body?: unknown;
          createdAt?: unknown;
        }>;
      } & GhListEntry;
      return {
        issue: {
          repo,
          number,
          title: String(detail.title ?? ""),
          state: String(detail.state ?? ""),
          author: String(detail.author?.login ?? ""),
          body: typeof detail.body === "string" ? detail.body : "",
          labels: (detail.labels ?? []).map((label) =>
            String(label?.name ?? ""),
          ),
          assignees: (detail.assignees ?? []).map((user) =>
            String(user?.login ?? ""),
          ),
          url: String(detail.url ?? ""),
          updatedAt: String(detail.updatedAt ?? ""),
          comments: (detail.comments ?? []).map((comment) => ({
            author: String(comment.author?.login ?? ""),
            body: typeof comment.body === "string" ? comment.body : "",
            createdAt: String(comment.createdAt ?? ""),
          })),
        },
      };
    },

    async getPull({ repo, number }: { repo: string; number: number }) {
      const prFields =
        "number,title,body,state,isDraft,author,createdAt,updatedAt,labels," +
        "assignees,url,baseRefName,headRefName,additions,deletions," +
        "changedFiles,reviewDecision,mergeStateStatus,statusCheckRollup," +
        "comments,reviews,reviewRequests";
      const [viewRaw, reviewCommentsRaw, filesRaw] = await Promise.all([
        gh(
          ["pr", "view", String(number), "-R", repo, "--json", prFields],
          30_000,
        ),
        gh(
          [
            "api",
            "--paginate",
            "--slurp",
            `repos/${repo}/pulls/${number}/comments?per_page=100`,
          ],
          30_000,
        ),
        gh(
          [
            "api",
            "--paginate",
            "--slurp",
            `repos/${repo}/pulls/${number}/files?per_page=100`,
          ],
          30_000,
        ),
      ]);

      interface GhPullView extends GhListEntry {
        isDraft?: unknown;
        createdAt?: unknown;
        baseRefName?: unknown;
        headRefName?: unknown;
        additions?: unknown;
        deletions?: unknown;
        changedFiles?: unknown;
        reviewDecision?: unknown;
        mergeStateStatus?: unknown;
        statusCheckRollup?: Array<{
          __typename?: unknown;
          name?: unknown;
          context?: unknown;
          status?: unknown;
          conclusion?: unknown;
          state?: unknown;
          detailsUrl?: unknown;
          targetUrl?: unknown;
        }>;
        comments?: Array<{
          author?: { login?: unknown };
          body?: unknown;
          createdAt?: unknown;
        }>;
        reviews?: Array<{
          author?: { login?: unknown };
          state?: unknown;
          body?: unknown;
          submittedAt?: unknown;
        }>;
        reviewRequests?: Array<{
          login?: unknown;
          name?: unknown;
          slug?: unknown;
        }>;
      }
      const view = JSON.parse(viewRaw) as GhPullView;

      const checks = (view.statusCheckRollup ?? []).map((entry) => {
        const conclusion = String(
          entry.conclusion ?? entry.state ?? "",
        ).toUpperCase();
        const running =
          entry.conclusion === "" ||
          ["IN_PROGRESS", "QUEUED", "PENDING", "EXPECTED", "WAITING"].includes(
            String(entry.status ?? entry.state ?? "").toUpperCase(),
          );
        const status: "success" | "failure" | "pending" | "neutral" =
          conclusion === "SUCCESS"
            ? "success"
            : conclusion === "FAILURE" ||
                conclusion === "ERROR" ||
                conclusion === "TIMED_OUT"
              ? "failure"
              : running
                ? "pending"
                : "neutral";
        return {
          name: String(entry.name ?? entry.context ?? "check"),
          status,
          url: String(entry.detailsUrl ?? entry.targetUrl ?? ""),
        };
      });

      interface GhReviewComment {
        id?: unknown;
        in_reply_to_id?: unknown;
        path?: unknown;
        line?: unknown;
        original_line?: unknown;
        diff_hunk?: unknown;
        body?: unknown;
        created_at?: unknown;
        user?: { login?: unknown };
      }
      const reviewComments = parsePaginatedGhApi(
        reviewCommentsRaw,
      ) as GhReviewComment[];
      interface ReviewThread {
        path: string;
        line: number | null;
        diffHunk: string;
        comments: Array<{ author: string; body: string; createdAt: string }>;
      }
      const threadByRootId = new Map<number, ReviewThread>();
      for (const comment of reviewComments) {
        const id = Number(comment.id ?? NaN);
        const replyTo = Number(comment.in_reply_to_id ?? NaN);
        const entry = {
          author: String(comment.user?.login ?? ""),
          body: typeof comment.body === "string" ? comment.body : "",
          createdAt: String(comment.created_at ?? ""),
        };
        const rootThread = Number.isFinite(replyTo)
          ? threadByRootId.get(replyTo)
          : undefined;
        if (rootThread !== undefined) {
          rootThread.comments.push(entry);
          if (Number.isFinite(id)) threadByRootId.set(id, rootThread);
          continue;
        }
        const line = Number(comment.line ?? comment.original_line ?? NaN);
        const thread: ReviewThread = {
          path: String(comment.path ?? ""),
          line: Number.isFinite(line) ? line : null,
          diffHunk:
            typeof comment.diff_hunk === "string" ? comment.diff_hunk : "",
          comments: [entry],
        };
        if (Number.isFinite(id)) threadByRootId.set(id, thread);
      }
      const reviewThreads = [...new Set(threadByRootId.values())];

      interface GhPullFile {
        filename?: unknown;
        status?: unknown;
        additions?: unknown;
        deletions?: unknown;
        patch?: unknown;
      }
      const files = (parsePaginatedGhApi(filesRaw) as GhPullFile[]).map(
        (file) => {
          const patch = typeof file.patch === "string" ? file.patch : null;
          return {
            path: String(file.filename ?? ""),
            status: String(file.status ?? "modified"),
            additions: Number(file.additions ?? 0),
            deletions: Number(file.deletions ?? 0),
            patch: patch !== null && patch.length <= 20_000 ? patch : null,
          };
        },
      );

      return {
        pull: {
          repo,
          number,
          title: String(view.title ?? ""),
          state:
            view.isDraft === true && String(view.state ?? "") === "OPEN"
              ? "DRAFT"
              : String(view.state ?? ""),
          author: String(view.author?.login ?? ""),
          body: typeof view.body === "string" ? view.body : "",
          url: String(view.url ?? ""),
          createdAt: String(view.createdAt ?? ""),
          updatedAt: String(view.updatedAt ?? ""),
          baseRefName: String(view.baseRefName ?? ""),
          headRefName: String(view.headRefName ?? ""),
          additions: Number(view.additions ?? 0),
          deletions: Number(view.deletions ?? 0),
          changedFiles: Number(view.changedFiles ?? files.length),
          labels: (view.labels ?? []).map((label) => String(label?.name ?? "")),
          assignees: (view.assignees ?? []).map((user) =>
            String(user?.login ?? ""),
          ),
          reviewDecision: String(view.reviewDecision ?? ""),
          mergeStateStatus: String(view.mergeStateStatus ?? ""),
          reviewRequests: (view.reviewRequests ?? [])
            .map((entry) =>
              String(entry.login ?? entry.name ?? entry.slug ?? ""),
            )
            .filter((name) => name.length > 0),
          checks,
          comments: (view.comments ?? []).map((comment) => ({
            author: String(comment.author?.login ?? ""),
            body: typeof comment.body === "string" ? comment.body : "",
            createdAt: String(comment.createdAt ?? ""),
          })),
          reviews: (view.reviews ?? []).map((review) => ({
            author: String(review.author?.login ?? ""),
            state: String(review.state ?? ""),
            body: typeof review.body === "string" ? review.body : "",
            createdAt: String(review.submittedAt ?? ""),
          })),
          reviewThreads,
          files,
        },
      };
    },
  };
}
