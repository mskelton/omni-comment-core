import { Octokit } from "@octokit/rest"
import assert from "node:assert"
import { acquireLock } from "./acquireLock.js"
import { createComment, findComment, updateComment } from "./comments.js"
import { Logger } from "./logger.js"
import { Context, parseRepo } from "./utils.js"

export interface OmniCommentOptions {
  collapsed?: boolean
  configPath?: string
  issueNumber: number
  logger?: Logger
  message?: string
  repo: string
  section: string
  title?: string
  token: string
}

type OmniCommentResult = {
  html_url: string
  id: number
  status: "created" | "updated"
}

export async function omniComment(options: OmniCommentOptions): Promise<OmniCommentResult | null> {
  assert(!!options.issueNumber, "Issue number is required")
  assert(!!options.repo, "Repo is required")
  assert(!!options.section, "Section is required")
  assert(!!options.token, "Token is required")

  const ctx: Context = {
    logger: options.logger,
    octokit: new Octokit({ auth: options.token }),
    repo: parseRepo(options.repo),
  }

  // Acquire a lock on the issue to prevent race conditions
  await using _ = await acquireLock(options.issueNumber, ctx)

  const comment = await findComment(options.issueNumber, ctx)
  if (comment) {
    const { html_url, id } = await updateComment(
      comment.id,
      options.title || "",
      options.section,
      options.message || "",
      options.collapsed ?? false,
      ctx,
    )

    return { html_url, id, status: "updated" }
  } else if (options.message) {
    const { html_url, id } = await createComment(
      options.issueNumber,
      options.title || "",
      options.section,
      options.message,
      options.collapsed ?? false,
      options.configPath ?? "omni-comment.yml",
      ctx,
    )

    return { html_url, id, status: "created" }
  }

  return null
}
