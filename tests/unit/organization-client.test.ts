import { afterEach, describe, expect, it, vi } from "vitest";
import { selectAndApplyOrganizationScope } from "../../src/auth/org-scope.js";
import {
  listOrganizations,
  resolveOrganizationRef,
  setActiveOrganization,
} from "../../src/auth/organization-client.js";
import { createOutput } from "../../src/output.js";

const organizations = [
  {
    id: "org-1",
    name: "Aleph featured agents org",
    slug: "aleph-featured-agents-org",
  },
  {
    id: "org-2",
    name: "Other",
    slug: "other",
  },
];

const notFoundMessage = /was not found/;

describe("organization client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves organizations by id or slug", () => {
    expect(resolveOrganizationRef(organizations, "ORG-1")?.slug).toBe(
      "aleph-featured-agents-org"
    );
    expect(
      resolveOrganizationRef(organizations, "aleph-featured-agents-org")?.id
    ).toBe("org-1");
    expect(resolveOrganizationRef(organizations, "missing")).toBeUndefined();
  });

  it("lists and sets the active organization over Bearer auth", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(organizations), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(organizations[0]), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listOrganizations("https://api.example.com", "token")
    ).resolves.toEqual(organizations);
    await expect(
      setActiveOrganization("https://api.example.com", "token", "org-1")
    ).resolves.toEqual(organizations[0]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.example.com/api/auth/organization/list",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer token",
        }),
        method: "GET",
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.example.com/api/auth/organization/set-active",
      expect.objectContaining({
        body: JSON.stringify({ organizationId: "org-1" }),
        method: "POST",
      })
    );
  });

  it("applies --org without prompting", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(organizations), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(organizations[0]), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      selectAndApplyOrganizationScope({
        apiUrl: "https://api.example.com",
        output: createOutput(true),
        selection: { org: "aleph-featured-agents-org" },
        token: "token",
      })
    ).resolves.toEqual({
      organizationId: "org-1",
      organizationName: "Aleph featured agents org",
      scope: "organization",
    });
  });

  it("applies --personal without prompting", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(organizations), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(null), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      selectAndApplyOrganizationScope({
        apiUrl: "https://api.example.com",
        output: createOutput(true),
        selection: { personal: true },
        token: "token",
      })
    ).resolves.toEqual({
      organizationId: null,
      organizationName: null,
      scope: "personal",
    });
  });

  it("rejects unknown --org values", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(organizations), { status: 200 })
        )
    );

    await expect(
      selectAndApplyOrganizationScope({
        apiUrl: "https://api.example.com",
        output: createOutput(true),
        selection: { org: "missing" },
        token: "token",
      })
    ).rejects.toThrow(notFoundMessage);
  });
});
