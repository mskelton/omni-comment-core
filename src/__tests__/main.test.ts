import yaml from "js-yaml"
import { fs, vol } from "memfs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Octokit } from "@octokit/rest"
import { createBlankComment, editCommentBody } from "../comments"
import { omniComment } from "../main"

vi.mock("node:fs", () => ({ default: fs }))
vi.mock("node:fs/promises", () => ({ default: fs.promises }))
vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    paginate: {
      iterator: vi.fn(),
    },
    reactions: {
      createForIssue: vi.fn(),
      createForIssueComment: vi.fn(),
      deleteForIssue: vi.fn(),
      deleteForIssueComment: vi.fn(),
    },
    issues: {
      listComments: vi.fn(),
      createComment: vi.fn(),
      getComment: vi.fn(),
      updateComment: vi.fn(),
    },
  })),
}))

// The retry mechanism delays for a given amount of time, but we want to run tests as fast as possible
vi.stubGlobal("setTimeout", setImmediate)

const ok = (data: any) => ({ data, headers: {}, status: 200 as const, url: "" })
const created = (data: any) => ({ data, headers: {}, status: 201 as const, url: "" })
const noContent = () => ({ data: undefined as never, headers: {}, status: 204 as const, url: "" })

describe("omni comment", async () => {
  const octokit = new Octokit({ auth: "faketoken" })

  beforeEach(async () => {
    vi.clearAllMocks()
    vol.reset()

    // Throw a sample config file since most tests don't need to do this separately
    fs.writeFileSync("/omni-comment.yml", yaml.dump({ sections: ["test-section"] }))

    // Mock the endpoint so that the `paginate` method can be called
    vi.spyOn(octokit.issues.listComments, "endpoint").mockReturnValue({
      body: null,
      headers: {},
      method: "GET",
      url: "",
    })

    // Mock that all reactions are created. We can override this for testing the locking logic, but
    // for most tests, let's just assume there isn't currently a lock in place.
    vi.spyOn(octokit.reactions, "createForIssue").mockResolvedValue(created({ id: 1 }))
    vi.spyOn(octokit.reactions, "createForIssueComment").mockResolvedValue(created({ id: 2 }))

    // Deleting the reactions is something we'll never need to care about mocking separately
    vi.spyOn(octokit.reactions, "deleteForIssue").mockResolvedValue(noContent())
    vi.spyOn(octokit.reactions, "deleteForIssueComment").mockResolvedValue(noContent())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("should fail if no issue number specified", async () => {
    const result = omniComment({
      configPath: "/omni-comment.yml",
      issueNumber: undefined!,
      repo: "test-repo",
      section: "test-section",
      token: "faketoken",
    })

    expect(result).rejects.toThrow(new Error("Issue number is required"))
  })

  it("should create new comment when none exists", async () => {
    vi.spyOn(octokit.paginate, "iterator").mockImplementation(async function* () {
      yield created([])
    })

    const createCommentSpy = vi
      .spyOn(octokit.issues, "createComment")
      .mockResolvedValue(created({ html_url: "test-url", id: 456 }))

    const result = await omniComment({
      configPath: "/omni-comment.yml",
      issueNumber: 123,
      message: "test message",
      repo: "owner/repo",
      section: "test-section",
      token: "faketoken",
    })

    expect(result).toEqual({
      html_url: "test-url",
      id: 456,
      status: "created",
    })

    const request = createCommentSpy.mock.calls[0][0] as any
    expect(request.issue_number).toBe(123)
    expect(request.body).toMatchInlineSnapshot(`
      "<!-- mskelton/omni-comment id="main" -->

      <!-- mskelton/omni-comment start="test-section" -->
      test message
      <!-- mskelton/omni-comment end="test-section" -->"
    `)
  })

  it("should lock the PR for the first comment", async () => {
    vi.spyOn(octokit.reactions, "createForIssue")
      .mockResolvedValueOnce(ok({ id: 1 }))
      .mockResolvedValueOnce(created({ id: 1 }))

    vi.spyOn(octokit.paginate, "iterator").mockImplementation(async function* () {
      yield created([])
    })

    const createCommentSpy = vi
      .spyOn(octokit.issues, "createComment")
      .mockResolvedValue(created({ html_url: "test-url", id: 456 }))

    const result = await omniComment({
      configPath: "/omni-comment.yml",
      issueNumber: 123,
      message: "test message",
      repo: "owner/repo",
      section: "test-section",
      token: "faketoken",
    })

    expect(result).toEqual({
      html_url: "test-url",
      id: 456,
      status: "created",
    })

    const request = createCommentSpy.mock.calls[0][0] as any
    expect(request.issue_number).toBe(123)
    expect(request.body).toMatchInlineSnapshot(`
      "<!-- mskelton/omni-comment id="main" -->

      <!-- mskelton/omni-comment start="test-section" -->
      test message
      <!-- mskelton/omni-comment end="test-section" -->"
    `)
  })

  it("should update existing comment", async () => {
    vi.spyOn(octokit.paginate, "iterator").mockImplementation(async function* () {
      yield ok([{ body: await createBlankComment("/omni-comment.yml"), id: 456 }])
    })

    vi.spyOn(octokit.issues, "getComment").mockResolvedValue(
      ok({
        body: await createBlankComment("/omni-comment.yml"),
        html_url: "test-url",
        id: 456,
      }),
    )

    const updateCommentSpy = vi
      .spyOn(octokit.issues, "updateComment")
      .mockResolvedValue(ok({ html_url: "test-url", id: 456 }))

    const result = await omniComment({
      configPath: "/omni-comment.yml",
      issueNumber: 123,
      message: "updated message",
      repo: "owner/repo",
      section: "test-section",
      token: "faketoken",
    })

    expect(result).toEqual({
      html_url: "test-url",
      id: 456,
      status: "updated",
    })

    const request = updateCommentSpy.mock.calls[0][0] as any
    expect(request.comment_id).toBe(456)
    expect(request.body).toMatchInlineSnapshot(`
      "<!-- mskelton/omni-comment id="main" -->

      <!-- mskelton/omni-comment start="test-section" -->
      updated message
      <!-- mskelton/omni-comment end="test-section" -->"
    `)
  })

  it("should lock the comment when updating", async () => {
    vi.spyOn(octokit.reactions, "createForIssueComment")
      .mockResolvedValueOnce(ok({ id: 1 }))
      .mockResolvedValueOnce(created({ id: 1 }))

    vi.spyOn(octokit.paginate, "iterator").mockImplementation(async function* () {
      yield ok([{ body: await createBlankComment("/omni-comment.yml"), id: 456 }])
    })

    vi.spyOn(octokit.issues, "getComment").mockResolvedValue(
      ok({
        body: await createBlankComment("/omni-comment.yml"),
        html_url: "test-url",
        id: 456,
      }),
    )

    const updateCommentSpy = vi
      .spyOn(octokit.issues, "updateComment")
      .mockResolvedValue(ok({ html_url: "test-url", id: 456 }))

    const result = await omniComment({
      configPath: "/omni-comment.yml",
      issueNumber: 123,
      message: "updated message",
      repo: "owner/repo",
      section: "test-section",
      token: "faketoken",
    })

    expect(result).toEqual({
      html_url: "test-url",
      id: 456,
      status: "updated",
    })

    const request = updateCommentSpy.mock.calls[0][0] as any
    expect(request.comment_id).toBe(456)
    expect(request.body).toMatchInlineSnapshot(`
      "<!-- mskelton/omni-comment id="main" -->

      <!-- mskelton/omni-comment start="test-section" -->
      updated message
      <!-- mskelton/omni-comment end="test-section" -->"
    `)
  })

  it("should clear the comment when content is empty", async () => {
    vi.spyOn(octokit.paginate, "iterator").mockImplementation(async function* () {
      yield ok([{ body: await createBlankComment("/omni-comment.yml"), id: 456 }])
    })

    vi.spyOn(octokit.issues, "getComment").mockResolvedValue(
      ok({
        body: editCommentBody({
          body: await createBlankComment("/omni-comment.yml"),
          content: "test comment body",
          section: "test-section",
          title: "test title",
        }),
        html_url: "test-url",
        id: 456,
      }),
    )

    const updateCommentSpy = vi
      .spyOn(octokit.issues, "updateComment")
      .mockResolvedValue(ok({ html_url: "test-url", id: 456 }))

    const result = await omniComment({
      configPath: "/omni-comment.yml",
      issueNumber: 123,
      message: "",
      repo: "owner/repo",
      section: "test-section",
      token: "faketoken",
    })

    expect(result).toEqual({
      html_url: "test-url",
      id: 456,
      status: "updated",
    })

    const request = updateCommentSpy.mock.calls[0][0] as any
    expect(request.comment_id).toBe(456)
    expect(request.body).toMatchInlineSnapshot(`
      "<!-- mskelton/omni-comment id="main" -->

      <!-- mskelton/omni-comment start="test-section" -->

      <!-- mskelton/omni-comment end="test-section" -->"
    `)
  })

  it("should noop if the comment doesn't exist and the content is empty", async () => {
    vi.spyOn(octokit.paginate, "iterator").mockImplementation(async function* () {
      yield created([])
    })

    const createCommentSpy = vi
      .spyOn(octokit.issues, "createComment")
      .mockResolvedValue(created({ html_url: "test-url", id: 456 }))

    const result = await omniComment({
      configPath: "/omni-comment.yml",
      issueNumber: 123,
      message: "",
      repo: "owner/repo",
      section: "test-section",
      token: "faketoken",
    })

    expect(result).toBeNull()
    expect(createCommentSpy).not.toHaveBeenCalled()
  })

  it("should render as summary/details when title is specified", async () => {
    vi.spyOn(octokit.paginate, "iterator").mockImplementation(async function* () {
      yield created([])
    })

    const createCommentSpy = vi
      .spyOn(octokit.issues, "createComment")
      .mockResolvedValue(created({ html_url: "test-url", id: 456 }))

    const result = await omniComment({
      configPath: "/omni-comment.yml",
      issueNumber: 123,
      message: "test message",
      repo: "owner/repo",
      section: "test-section",
      title: "test title",
      token: "faketoken",
    })

    expect(result).toEqual({
      html_url: "test-url",
      id: 456,
      status: "created",
    })

    const request = createCommentSpy.mock.calls[0][0] as any
    expect(request.issue_number).toBe(123)
    expect(request.body).toMatchInlineSnapshot(`
      "<!-- mskelton/omni-comment id="main" -->

      <!-- mskelton/omni-comment start="test-section" -->
      <details open>
      <summary><h2>test title</h2></summary>

      test message

      </details>
      <!-- mskelton/omni-comment end="test-section" -->"
    `)
  })

  it("can render a summary/details comment closed", async () => {
    vi.spyOn(octokit.paginate, "iterator").mockImplementation(async function* () {
      yield created([])
    })

    const createCommentSpy = vi
      .spyOn(octokit.issues, "createComment")
      .mockResolvedValue(created({ html_url: "test-url", id: 456 }))

    const result = await omniComment({
      collapsed: true,
      configPath: "/omni-comment.yml",
      issueNumber: 123,
      message: "test message",
      repo: "owner/repo",
      section: "test-section",
      title: "test title",
      token: "faketoken",
    })

    expect(result).toEqual({
      html_url: "test-url",
      id: 456,
      status: "created",
    })

    const request = createCommentSpy.mock.calls[0][0] as any
    expect(request.issue_number).toBe(123)
    expect(request.body).toMatchInlineSnapshot(`
      "<!-- mskelton/omni-comment id="main" -->

      <!-- mskelton/omni-comment start="test-section" -->
      <details>
      <summary><h2>test title</h2></summary>

      test message

      </details>
      <!-- mskelton/omni-comment end="test-section" -->"
    `)
  })
})
