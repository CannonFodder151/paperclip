// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { EmailEndpointSetup } from "./EmailEndpointSetup";

const mocks = vi.hoisted(() => ({ companyId: "company" as string | null, listAgents: vi.fn(), connect: vi.fn(), inspect: vi.fn(), checkAddress: vi.fn(), setup: vi.fn(), listInboxes: vi.fn(), listConnections: vi.fn(), putInstalls: vi.fn() }));
vi.mock("@/lib/router", async () => import("react-router-dom"));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: mocks.companyId }) }));
vi.mock("@/components/chat/ChatSetupNavigation", () => ({ ChatSetupNavigation: () => null }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.listAgents } }));
vi.mock("@/api/tools", () => ({ toolsApi: { putConnectionInstalls: mocks.putInstalls, listConnections: mocks.listConnections } }));
vi.mock("@/api/email", () => ({ emailApi: { connect: mocks.connect, inspectSaved: mocks.inspect, checkAddress: mocks.checkAddress, setup: mocks.setup, list: mocks.listInboxes } }));

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  mocks.companyId = "company";
  sessionStorage.clear();
  mocks.listAgents.mockResolvedValue([{ id: "ralph", name: "Ralph", status: "idle", permissions: {} }]);
  mocks.inspect.mockResolvedValue({ scope: { scope_type: "organization" }, inboxes: [], domains: [] });
  mocks.checkAddress.mockImplementation(async (_company, _connection, { username, domain }) => ({ address: `${username}@${domain}`, status: "unknown" }));
  mocks.listInboxes.mockResolvedValue([]);
  mocks.listConnections.mockResolvedValue({ connections: [] });
  mocks.connect.mockResolvedValue({ id: "account" });
  mocks.setup.mockResolvedValue({ address: "ralph-team@agentmail.to", connectionId: "inbox" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client?.clear();
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount(saved = true, waitForCompany = true, agentId = "ralph") {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[
    `/apps/chat/connect?provider=agentmail&agentId=${agentId}${saved ? "&connectionId=account" : ""}`,
  ]}><EmailEndpointSetup /></MemoryRouter></QueryClientProvider>));
  if (waitForCompany) await vi.waitFor(() => expect(container.textContent).toContain(agentId === "support" ? "Support" : "Ralph"));
}
function button(name: string) {
  const value = [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === name);
  expect(value).toBeDefined();
  return value!;
}
async function click(name: string) {
  if (name === "Create email address") await vi.waitFor(() => expect(button(name).disabled).toBe(false));
  await act(async () => button(name).click());
}
async function fill(selector: string, value: string) {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>(selector)!;
    expect(input).not.toBeNull();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AgentMail two-step setup", () => {
  it("recovers an inbox-only key even after a failed attempt leaves an unallocated draft", async () => {
    mocks.inspect.mockImplementation(async (_company, id) => id === "account"
      ? { scope: { scope_type: "inbox" }, inboxes: [{ inbox_id: "locked@agentmail.to" }], domains: [] }
      : { scope: { scope_type: "organization" }, inboxes: [], domains: [{ domain: "paperclip.example", status: "VERIFIED" }] });
    mocks.listConnections.mockResolvedValue({ connections: [{
      id: "organization-account", name: "AgentMail", status: "active", enabled: true,
      config: { provider: "agentmail", emailCredential: true }, createdAt: "2026-09-30T14:00:00Z",
    }] });
    mocks.setup.mockImplementationOnce(async (_company, input) => {
      mocks.listInboxes.mockResolvedValue([{ id: input.idempotencyKey, assignedAgentId: "ralph", address: null, status: "error" }]);
      throw new ApiError("AgentMail did not allow this inbox request.", 422, {});
    });
    await mount();
    await click("Continue");
    await vi.waitFor(() => expect(container.textContent).toContain("This API key can only use locked@agentmail.to"));
    expect(container.querySelector<HTMLSelectElement>("#email-existing")?.disabled).toBe(true);
    expect(container.querySelector("#email-name")).toBeNull();
    await click("Connect email address");
    await vi.waitFor(() => expect(container.textContent).toContain("AgentMail did not allow this inbox request."));
    await vi.waitFor(() => expect(mocks.listInboxes).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(button("Change AgentMail account").disabled).toBe(false));
    await click("Change AgentMail account");
    await vi.waitFor(() => expect(document.querySelector("#email-account")).not.toBeNull());
    await act(async () => {
      const select = document.querySelector<HTMLSelectElement>("#email-account")!;
      select.value = "organization-account";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Use this account");
    await vi.waitFor(() => expect(container.querySelector<HTMLSelectElement>("#email-domain")?.value).toBe("paperclip.example"));
    await fill("#email-name", "ralph-mail");
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>("#email-domain")!;
      expect(select.disabled).toBe(false);
      select.value = "agentmail.to";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Create email address");
    await vi.waitFor(() => expect(mocks.setup).toHaveBeenCalledWith("company", expect.objectContaining({
      credentialConnectionId: "organization-account", assignedAgentId: "ralph", username: "ralph-mail", domain: "agentmail.to",
    })));
    expect(mocks.setup.mock.calls[1][1].inboxId).toBeUndefined();
    expect(mocks.setup.mock.calls[1][1].idempotencyKey).not.toBe(mocks.setup.mock.calls[0][1].idempotencyKey);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.putInstalls).not.toHaveBeenCalled();
  });

  it("keeps an already reserved inbox tied to its original account", async () => {
    const requestId = crypto.randomUUID();
    sessionStorage.setItem("paperclip.agentmail-setup:company:account:ralph", JSON.stringify({
      connectionId: "account", agentId: "ralph", step: 1, requestId,
    }));
    mocks.inspect.mockResolvedValue({ scope: { scope_type: "inbox" }, inboxes: [{ inbox_id: "locked@agentmail.to" }], domains: [] });
    mocks.listInboxes.mockResolvedValue([{ id: requestId, assignedAgentId: "ralph", address: "locked@agentmail.to", status: "error" }]);
    await mount();
    await vi.waitFor(() => expect(container.textContent).toContain("This address is reserved for Ralph"));
    expect(container.textContent).not.toContain("Change AgentMail account");
    await click("Finish connecting");
    await vi.waitFor(() => expect(mocks.setup).toHaveBeenCalledWith("company", expect.objectContaining({
      credentialConnectionId: "account", idempotencyKey: requestId, inboxId: "locked@agentmail.to",
    })));
  });

  it("replaces an inbox-only key with a fresh idempotency key without storing the secret", async () => {
    const originalRequestId = crypto.randomUUID();
    const draftKey = "paperclip.agentmail-setup:company:account:ralph";
    sessionStorage.setItem(draftKey, JSON.stringify({ connectionId: "account", agentId: "ralph", step: 1, requestId: originalRequestId }));
    mocks.inspect.mockImplementation(async (_company, id) => ({
      scope: { scope_type: id === "account" ? "inbox" : "organization" },
      inboxes: [{ inbox_id: "locked@agentmail.to" }], domains: [],
    }));
    mocks.connect.mockResolvedValue({ id: "replacement-account" });
    await mount();
    await vi.waitFor(() => expect(container.textContent).toContain("This API key can only use"));
    await click("Change AgentMail account");
    await fill('input[type="password"]', "replacement-secret");
    expect(sessionStorage.getItem(draftKey)).not.toContain("replacement-secret");
    await click("Use this account");
    await vi.waitFor(() => expect(container.querySelector("#email-name")).not.toBeNull());
    const replacementRequest = mocks.connect.mock.calls[0][1];
    expect(replacementRequest).toMatchObject({ apiKey: "replacement-secret", agentIds: ["ralph"], grantKind: "organization", allAgents: false });
    expect(replacementRequest.idempotencyKey).not.toBe(originalRequestId);
    await act(async () => root.unmount());
    client.clear(); root = createRoot(container);
    await mount();
    await click("Create email address");
    await vi.waitFor(() => expect(mocks.setup).toHaveBeenCalledWith("company", expect.objectContaining({
      credentialConnectionId: "replacement-account", idempotencyKey: replacementRequest.idempotencyKey, username: "ralph",
    })));
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });

  it("checks the initial address and debounces edits while ignoring stale responses", async () => {
    await mount();
    vi.useFakeTimers();
    await click("Continue");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(container.textContent).toContain("Checking address");
    expect(button("Create email address").disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(mocks.checkAddress).toHaveBeenLastCalledWith("company", "account", { username: "ralph", domain: "agentmail.to" }, expect.any(AbortSignal));
    let resolveOld!: (result: unknown) => void;
    mocks.checkAddress.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    await fill("#email-name", "ralph-old");
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    const oldSignal = mocks.checkAddress.mock.calls[1][3] as AbortSignal;
    await fill("#email-name", "ralph-n");
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await fill("#email-name", "ralph-new");
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { resolveOld({ address: "ralph-old@agentmail.to", status: "taken" }); });
    expect(container.querySelector("#email-address-error")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(349); });
    expect(mocks.checkAddress).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocks.checkAddress).toHaveBeenCalledTimes(3);
    expect(mocks.checkAddress.mock.calls[2][2].username).toBe("ralph-new");
    expect(container.textContent).toContain("confirms availability when you create");
    expect(container.textContent).not.toContain("is available");
  });

  it("offers clickable alternatives for a taken initial address and checks the selection", async () => {
    mocks.checkAddress.mockResolvedValueOnce({ address: "ralph@agentmail.to", status: "taken" });
    await mount();
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector("#email-address-error")?.textContent).toContain("already in use"));
    expect(button("Create email address").disabled).toBe(true);
    await click("ralph-agent@agentmail.to");
    expect(container.querySelector<HTMLInputElement>("#email-name")?.value).toBe("ralph-agent");
    expect(container.querySelector("#email-address-error")).toBeNull();
    await vi.waitFor(() => expect(mocks.checkAddress).toHaveBeenLastCalledWith("company", "account", { username: "ralph-agent", domain: "agentmail.to" }, expect.any(AbortSignal)));
    expect(mocks.setup).not.toHaveBeenCalled();
  });

  it("defaults to a verified custom domain beside the name and preserves an explicit selection on reload", async () => {
    mocks.inspect.mockResolvedValue({ scope: { scope_type: "organization" }, inboxes: [], domains: [
      { domain_id: "pending", domain: "pending.example", status: "PENDING" },
      { domain_id: "custom", domain: "paperclip.example", status: "VERIFIED" },
    ] });
    await mount();
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector<HTMLSelectElement>("#email-domain")?.value).toBe("paperclip.example"));
    expect(container.querySelector("#email-domain")?.closest("details")).toBeNull();
    expect(container.querySelector('option[value="pending.example"]')).toBeNull();
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>("#email-domain")!;
      select.value = "agentmail.to";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => expect(mocks.checkAddress).toHaveBeenLastCalledWith("company", "account", { username: "ralph", domain: "agentmail.to" }, expect.any(AbortSignal)));
    await act(async () => root.unmount());
    client.clear();
    root = createRoot(container);
    await mount();
    await vi.waitFor(() => expect(container.querySelector<HTMLSelectElement>("#email-domain")?.value).toBe("agentmail.to"));
  });

  it("shows lookup failures without mislabeling the address taken or blocking creation", async () => {
    mocks.checkAddress.mockRejectedValue(new Error("AgentMail is rate limiting requests."));
    await mount();
    await click("Continue");
    await vi.waitFor(() => expect(container.textContent).toContain("Could not check this address"));
    expect(container.querySelector("#email-address-error")).toBeNull();
    expect(button("Create email address").disabled).toBe(false);
  });
  it("restores saved progress after the company loads without overwriting the draft", async () => {
    const key = "paperclip.agentmail-setup:company:account:ralph";
    const requestId = crypto.randomUUID();
    const draft = JSON.stringify({ connectionId: "account", step: 1, agentId: "ralph", username: "ralph-team", requestId });
    sessionStorage.setItem(key, draft);
    mocks.companyId = null;
    await mount(true, false);
    expect(container.textContent).toContain("Loading email setup");
    expect(sessionStorage.getItem(key)).toBe(draft);
    mocks.companyId = "company";
    await mount();
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("#email-name")?.value).toBe("ralph-team"));
    await click("Create email address");
    await vi.waitFor(() => expect(mocks.setup).toHaveBeenCalledWith("company", expect.objectContaining({ username: "ralph-team", idempotencyKey: requestId })));
  });

  it("creates from the email field without a review step and keeps advanced settings collapsed", async () => {
    await mount();
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("#email-name")?.value).toBe("ralph"));
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.textContent).not.toContain("Review email address");
    await click("Create email address");
    await vi.waitFor(() => expect(container.textContent).toContain("Your agent’s email is ready"));
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.putInstalls).not.toHaveBeenCalled();
    expect(mocks.setup).toHaveBeenCalledWith("company", expect.objectContaining({ assignedAgentId: "ralph", username: "ralph", domain: "agentmail.to", receiveMode: "websocket" }));
    expect(sessionStorage.getItem("paperclip.agentmail-setup:company:account:ralph")).toBeNull();
  });

  it("shows a taken address beside the field, clears it on editing, and resumes the same request after reload", async () => {
    mocks.setup.mockRejectedValueOnce(new ApiError("This email address is already in use. Choose a different address.", 409, { code: "agentmail_address_taken" }));
    await mount();
    await click("Continue");
    await click("Create email address");
    await vi.waitFor(() => expect(container.querySelector("#email-name")?.getAttribute("aria-invalid")).toBe("true"));
    expect(container.querySelector("#email-address-error")?.textContent).toContain("already in use");
    expect(button("Create email address").disabled).toBe(true);
    const firstRequest = mocks.setup.mock.calls[0][1];
    await fill("#email-name", "");
    expect(container.querySelector<HTMLInputElement>("#email-name")?.value).toBe("");
    await fill("#email-name", "ralph-team");
    expect(container.querySelector("#email-address-error")).toBeNull();
    await act(async () => root.unmount());
    client.clear();
    root = createRoot(container);
    await mount();
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("#email-name")?.value).toBe("ralph-team"));
    await click("Create email address");
    await vi.waitFor(() => expect(mocks.setup).toHaveBeenCalledTimes(2));
    expect(mocks.setup.mock.calls[1][1]).toMatchObject({ username: "ralph-team", idempotencyKey: firstRequest.idempotencyKey });
  });

  it("asks for one API key with the direct link and saves the requested access defaults", async () => {
    await mount(false);
    expect(container.querySelector('a[href="https://console.agentmail.to/dashboard/api-keys"]')).not.toBeNull();
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    await fill('input[type="password"]', "private-test-key");
    expect(sessionStorage.getItem("paperclip.agentmail-setup:company:new:ralph")).not.toContain("private-test-key");
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector("#email-name")).not.toBeNull());
    expect(mocks.connect).toHaveBeenCalledWith("company", expect.objectContaining({ apiKey: "private-test-key", grantKind: "organization", allAgents: false, agentIds: ["ralph"] }));
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(sessionStorage.getItem("paperclip.agentmail-setup:company:new:ralph")).not.toContain("private-test-key");
  });

  it("flags an address already present in the connected account before submission", async () => {
    mocks.inspect.mockResolvedValue({ scope: { scope_type: "organization" }, inboxes: [{ inbox_id: "ralph@agentmail.to" }], domains: [] });
    await mount();
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector("#email-address-error")?.textContent).toContain("already in use"));
    expect(button("Create email address").disabled).toBe(true);
    expect(mocks.setup).not.toHaveBeenCalled();
    await click("Use an existing inbox");
    expect(container.querySelector("#email-existing")).not.toBeNull();
  });

  it("does not restore another requested agent's new-account draft", async () => {
    sessionStorage.setItem("paperclip.agentmail-setup:company:new:ralph", JSON.stringify({
      agentId: "ralph", step: 1, connectionId: "ralph-account", username: "ralph", requestId: crypto.randomUUID(),
    }));
    mocks.listAgents.mockResolvedValue([
      { id: "ralph", name: "Ralph", status: "idle", permissions: {} },
      { id: "support", name: "Support", status: "idle", permissions: {} },
    ]);
    await mount(false, true, "support");
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    await fill('input[type="password"]', "new-key");
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("#email-name")?.value).toBe("support"));
    expect(mocks.connect).toHaveBeenCalledWith("company", expect.objectContaining({ agentIds: ["support"] }));
    expect(mocks.inspect).not.toHaveBeenCalledWith("company", "ralph-account");
  });

  it("submits the final agent with the original setup request after changing agents and reloading", async () => {
    mocks.listAgents.mockResolvedValue([
      { id: "ralph", name: "Ralph", status: "idle", permissions: {} },
      { id: "support", name: "Support", status: "idle", permissions: {} },
    ]);
    await mount(false);
    await fill('input[type="password"]', "new-key");
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector("#email-name")).not.toBeNull());
    await click("Back");
    await act(async () => container.querySelector<HTMLButtonElement>('[role="combobox"]')!.click());
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull());
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(e => e.textContent === "Support")!.click());
    await act(async () => root.unmount());
    client.clear();
    root = createRoot(container);
    await mount(false, false);
    await vi.waitFor(() => expect(button("Continue").disabled).toBe(false));
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("#email-name")?.value).toBe("support"));
    // Access is updated by email setup, without a separate agent-config permission.
    expect(mocks.putInstalls).not.toHaveBeenCalled();
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    await click("Create email address");
    await vi.waitFor(() => expect(mocks.setup).toHaveBeenCalledWith("company", expect.objectContaining({ assignedAgentId: "support", idempotencyKey: mocks.connect.mock.calls[0][1].idempotencyKey })));
  });

  it.each(["new", "existing"])("resumes its allocated %s inbox after a provider failure and reload", async addressMode => {
    const requestId = crypto.randomUUID();
    sessionStorage.setItem("paperclip.agentmail-setup:company:account:ralph", JSON.stringify({
      connectionId: "account", agentId: "ralph", step: 1, username: "ralph", inboxId: "ralph@agentmail.to", addressMode, requestId,
    }));
    const endpoint = { id: requestId, assignedAgentId: "ralph", address: "ralph@agentmail.to", status: "draft" };
    // Creation succeeds before a later runtime-key request fails.
    mocks.setup.mockImplementationOnce(async () => {
      mocks.listInboxes.mockResolvedValue([endpoint]);
      mocks.inspect.mockResolvedValue({ scope: { scope_type: "organization" }, inboxes: [{ inbox_id: endpoint.address }], domains: [] });
      throw new ApiError("Could not create runtime key", 502, {});
    });
    await mount();
    await vi.waitFor(() => expect(button(addressMode === "new" ? "Create email address" : "Connect email address").disabled).toBe(false));
    await click(addressMode === "new" ? "Create email address" : "Connect email address");
    await vi.waitFor(() => expect(container.textContent).toContain("Could not create runtime key"));
    await vi.waitFor(() => expect(button("Finish connecting").disabled).toBe(false));
    await act(async () => root.unmount());
    client.clear();
    root = createRoot(container);
    await mount();
    await vi.waitFor(() => expect(button("Finish connecting").disabled).toBe(false));
    expect(container.querySelector("#email-address-error")).toBeNull();
    if (addressMode === "new") expect(container.querySelector<HTMLInputElement>("#email-name")?.readOnly).toBe(true);
    else expect(container.querySelector<HTMLSelectElement>("#email-existing")?.disabled).toBe(true);
    await click("Back");
    expect(container.querySelector<HTMLButtonElement>('[role="combobox"]')?.disabled).toBe(true);
    await click("Continue");
    await vi.waitFor(() => expect(button("Finish connecting").disabled).toBe(false));
    await click("Finish connecting");
    await vi.waitFor(() => expect(container.textContent).toContain("Your agent’s email is ready"));
    expect(mocks.setup).toHaveBeenLastCalledWith("company", expect.objectContaining({ inboxId: endpoint.address, assignedAgentId: "ralph", idempotencyKey: requestId }));
  });

  it("does not treat another setup's allocated address as its own retry", async () => {
    mocks.inspect.mockResolvedValue({ scope: { scope_type: "organization" }, inboxes: [{ inbox_id: "ralph@agentmail.to" }], domains: [] });
    mocks.listInboxes.mockResolvedValue([{ id: crypto.randomUUID(), assignedAgentId: "ralph", address: "ralph@agentmail.to", status: "draft" }]);
    await mount();
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector("#email-address-error")?.textContent).toContain("already in use"));
    expect(button("Create email address").disabled).toBe(true);
    await click("Use an existing inbox");
    const option = container.querySelector<HTMLOptionElement>('option[value="ralph@agentmail.to"]');
    expect(option?.disabled).toBe(true);
    expect(mocks.setup).not.toHaveBeenCalled();
  });

  it("retries loading setup progress without losing the entered key or reloading", async () => {
    mocks.listInboxes.mockRejectedValueOnce(new Error("Service unavailable"));
    await mount(false);
    await fill('input[type="password"]', "private-test-key");
    await vi.waitFor(() => expect(container.textContent).toContain("Could not load email setup progress"));
    expect(button("Continue").disabled).toBe(true);
    await click("Retry loading inboxes");
    await vi.waitFor(() => expect(button("Continue").disabled).toBe(false));
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("private-test-key");
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector("#email-name")).not.toBeNull());
    expect(mocks.listInboxes).toHaveBeenCalledTimes(2);
    expect(mocks.putInstalls).not.toHaveBeenCalled();
  });

  it("preserves the existing low-trust work-boundary gate", async () => {
    mocks.listAgents.mockResolvedValue([{ id: "ralph", name: "Ralph", status: "idle", permissions: { trustPreset: "low_trust_review" } }]);
    await mount();
    expect(container.textContent).toContain("needs a work boundary");
    expect(button("Continue").disabled).toBe(true);
    expect(mocks.setup).not.toHaveBeenCalled();
  });
});
