import { Octokit } from "@octokit/rest"
import assert from "node:assert"
import { acquireLock } from "./acquireLock.js"
import {
  createComment,
  findComment,
  formatSectionContent,
  getSectionContent,
  updateComment,
} from "./comments.js"
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
  status: "created" | "unchanged" | "updated"
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

  // Check for existing comment before acquiring lock
  const existingComment = await findComment(options.issueNumber, ctx)

  // If comment exists, check if the section content is unchanged
  if (existingComment?.body) {
    const currentContent = getSectionContent(existingComment.body, options.section)
    const newContent = formatSectionContent(
      options.message || "",
      options.title,
      options.collapsed ?? false,
    )

    if (currentContent === newContent) {
      ctx.logger?.debug("Section content unchanged, skipping update")
      return { html_url: existingComment.html_url, id: existingComment.id, status: "unchanged" }
    }
  }

  // Content changed or no existing comment - acquire lock and proceed
  await using _ = await acquireLock(options.issueNumber, ctx)

  // Re-fetch comment after acquiring lock to get latest state
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
