// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { EmailEndpointSetup } from "./EmailEndpointSetup";

const mocks = vi.hoisted(() => ({ companyId: "company" as string | null, listAgents: vi.fn(), connect: vi.fn(), inspect: vi.fn(), setup: vi.fn(), listInboxes: vi.fn(), putInstalls: vi.fn() }));
vi.mock("@/lib/router", async () => import("react-router-dom"));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: mocks.companyId }) }));
vi.mock("@/components/chat/ChatSetupNavigation", () => ({ ChatSetupNavigation: () => null }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.listAgents } }));
vi.mock("@/api/tools", () => ({ toolsApi: { putConnectionInstalls: mocks.putInstalls } }));
vi.mock("@/api/email", () => ({ emailApi: { connect: mocks.connect, inspectSaved: mocks.inspect, setup: mocks.setup, list: mocks.listInboxes } }));

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
  mocks.listInboxes.mockResolvedValue([]);
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
});
async function mount(saved = true, waitForCompany = true, agentId = "ralph") {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[
    `/apps/chat/connect?provider=agentmail&agentId=${agentId}${saved ? "&connectionId=account" : ""}`,
  ]}><EmailEndpointSetup /></MemoryRouter></QueryClientProvider>));
  if (waitForCompany) await vi.waitFor(() => expect(container.textContent).toContain(agentId === "support" ? "Support" : "Ralph"));
}
function button(name: string) {
  const value = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === name);
  expect(value).toBeDefined();
  return value!;
}
async function click(name: string) { await act(async () => button(name).click()); }
async function fill(selector: string, value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>(selector)!;
    expect(input).not.toBeNull();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AgentMail two-step setup", () => {
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

  it("replaces new-account access after changing agents, including after reload", async () => {
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
    mocks.putInstalls.mockRejectedValueOnce(new Error("Could not update agent access"));
    await click("Continue");
    await vi.waitFor(() => expect(container.textContent).toContain("Could not update agent access"));
    expect(container.querySelector("#email-name")).toBeNull();
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("#email-name")?.value).toBe("support"));
    expect(mocks.putInstalls).toHaveBeenLastCalledWith("account", [{ targetType: "agent", targetId: "support" }]);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    await click("Create email address");
    await vi.waitFor(() => expect(mocks.setup).toHaveBeenCalledWith("company", expect.objectContaining({ assignedAgentId: "support" })));
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

  it("preserves the existing low-trust work-boundary gate", async () => {
    mocks.listAgents.mockResolvedValue([{ id: "ralph", name: "Ralph", status: "idle", permissions: { trustPreset: "low_trust_review" } }]);
    await mount();
    expect(container.textContent).toContain("needs a work boundary");
    expect(button("Continue").disabled).toBe(true);
    expect(mocks.setup).not.toHaveBeenCalled();
  });
});
