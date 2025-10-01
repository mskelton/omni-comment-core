import assert from "node:assert"
import { Octokit } from "@octokit/rest"
import { acquireLock } from "./acquireLock"
import { createComment, findComment, updateComment } from "./comments"
import { Logger } from "./logger"
import { Context, parseRepo } from "./utils"

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

  let comment = await findComment(options.issueNumber, ctx)

  if (comment) {
    const commentId = comment.id
    await using _ = await acquireLock("comment", commentId, ctx)

    const updatedComment = await updateComment(
      commentId,
      options.title || "",
      options.section,
      options.message || "",
      options.collapsed ?? false,
      ctx,
    )

    return {
      html_url: updatedComment.html_url,
      id: updatedComment.id,
      status: "updated",
    }
  } else if (options.message) {
    await using _ = await acquireLock("issue", options.issueNumber, ctx)

    comment = await createComment(
      options.issueNumber,
      options.title || "",
      options.section,
      options.message,
      options.collapsed ?? false,
      options.configPath ?? "omni-comment.yml",
      ctx,
    )

    return {
      html_url: comment.html_url,
      id: comment.id,
      status: "created",
    }
  }

  return null
}
