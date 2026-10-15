// OpenCode 2.0.29 approval lifecycle, with no model calls. Runner/parity tests verify that the
// workflow creates these linked sessions; this suite checks the real server's permission hooks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createProject, e2eEnabled, startServer, waitForPlugin, type E2EProject, type E2EServer } from "./harness.ts"

const ACTION = "e2e_workflow_approval"
const RULES = [
  { action: ACTION, resource: "*", effect: "ask" },
  { action: ACTION, resource: "blocked", effect: "deny" },
]

async function sessions(server: E2EServer, project: E2EProject, linked = true) {
  await waitForPlugin(server, project)
  const { data: parent } = await server.api(project, "POST", "/api/session", {
    title: "approval parent",
    agent: "build",
    location: { directory: project.dir },
    permissions: RULES,
  })
  const { data: child } = await server.api(project, "POST", "/api/session", {
    title: "[wf:e2e-permissions] child",
    agent: "build",
    ...(linked ? { parentID: parent.id } : { location: { directory: project.dir } }),
    permissions: RULES,
    metadata: { workflowRunId: "e2e-permissions", workflowAgentIndex: 0, parentSessionID: parent.id },
  })
  return { parent, child }
}

async function request(server: E2EServer, project: E2EProject, sessionID: string, resource = "approved", action = ACTION) {
  const { data } = await server.api(project, "POST", `/api/session/${sessionID}/permission`, {
    action,
    resources: [resource],
    save: ["*"],
  })
  return data as { id: string; effect: "ask" | "allow" | "deny" }
}

async function pending(server: E2EServer, project: E2EProject, sessionID: string) {
  const { data } = await server.api(project, "GET", `/api/session/${sessionID}/permission`)
  return data as { id: string; sessionID: string; action: string; resources: string[] }[]
}

describe.skipIf(!e2eEnabled())("e2e native workflow approvals (no model calls)", () => {
  let server: E2EServer
  let unattended: E2EServer
  beforeAll(async () => {
    ;[server, unattended] = await Promise.all([
      startServer({ label: "permissions" }),
      startServer({ label: "permissions-deny", env: { OPENCODE_WORKFLOW_PERMISSION_MODE: "deny" } }),
    ])
  }, 120_000)
  afterAll(async () => {
    await Promise.all([server?.stop(), unattended?.stop()])
  }, 30_000)

  test("P62 P63 linked children keep native requests, replies and configured denies", async () => {
    const project = createProject("permissions-linked")
    const { parent, child } = await sessions(server, project)
    expect(child.parentID).toBe(parent.id)
    expect(child.location.directory).toBe(parent.location.directory)

    for (const decision of ["once", "reject", "always"]) {
      const result = await request(server, project, child.id)
      expect(result.effect).toBe("ask")
      expect(await pending(server, project, child.id)).toEqual([
        expect.objectContaining({ id: result.id, sessionID: child.id, action: ACTION, resources: ["approved"] }),
      ])
      // The native UI collects requests from the parent's family, without moving ownership.
      expect(await pending(server, project, parent.id)).toEqual([])
      await server.api(project, "POST", `/api/session/${child.id}/permission/${result.id}/reply`, { decision })
      expect(await pending(server, project, child.id)).toEqual([])
    }

    expect((await request(server, project, child.id)).effect).toBe("allow")
    expect((await request(server, project, child.id, "blocked")).effect).toBe("deny")
    expect(await pending(server, project, child.id)).toEqual([])
    expect((await server.messages(project, parent.id)).filter((m) => m.type === "assistant")).toEqual([])
  }, 60_000)

  test("P63 unlinked workflow sessions deny asks instead of leaving invisible pending requests", async () => {
    const project = createProject("permissions-unlinked")
    const { child } = await sessions(server, project, false)
    expect(child.parentID).toBeUndefined()
    expect((await request(server, project, child.id)).effect).toBe("deny")
    expect(await pending(server, project, child.id)).toEqual([])
  }, 60_000)

  test("P63 unattended deny mode keeps linked children but creates no approval request", async () => {
    const project = createProject("permissions-unattended")
    const { parent, child } = await sessions(unattended, project)
    expect(child.parentID).toBe(parent.id)
    expect((await request(unattended, project, child.id)).effect).toBe("deny")
    expect((await request(unattended, project, child.id, "README.md", "read")).effect).toBe("allow")
    expect(await pending(unattended, project, child.id)).toEqual([])
  }, 60_000)
})
