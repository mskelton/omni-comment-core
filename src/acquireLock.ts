import { retry } from "./retry"
import { Context } from "./utils"

export function acquireLock(
  type: "comment" | "issue",
  id: number,
  { logger, octokit, repo }: Context,
): Promise<AsyncDisposable> {
  return retry(
    async ({ attempt, maxAttempts }) => {
      logger?.debug(`Attempting to acquire lock (attempt ${attempt + 1}/${maxAttempts})...`)

      const args = {
        ...repo,
        content: "eyes" as const,
      }

      const { data: reaction, status } =
        type === "issue"
          ? await octokit.reactions.createForIssue({ ...args, issue_number: id })
          : await octokit.reactions.createForIssueComment({ ...args, comment_id: id })

      const unlock = async () => {
        logger?.debug("Releasing lock...")

        const args = {
          ...repo,
          reaction_id: reaction.id,
        }

        if (type === "issue") {
          await octokit.reactions.deleteForIssue({ ...args, issue_number: id })
        } else {
          await octokit.reactions.deleteForIssueComment({ ...args, comment_id: id })
        }
      }

      if (status === 201) {
        logger?.debug("Lock acquired")
      } else {
        // If the lock has not been acquired after 9 attempts, it's probably due
        // to some error in another job that prevented the lock from being
        // released. To prevent a dead-lock that the user is unable to easily
        // recover from, let's automatically release the lock in this case.
        //
        // Is this dangerous? Technical yes, but if for some reason the comment
        // gets updated slightly incorrectly, it's better than a dead-lock.
        if (attempt + 1 === maxAttempts) {
          await unlock()
        }

        throw new Error("Lock not acquired")
      }

      return {
        async [Symbol.asyncDispose]() {
          await unlock()
        },
      }
    },
    10,
    1000,
  )
}
