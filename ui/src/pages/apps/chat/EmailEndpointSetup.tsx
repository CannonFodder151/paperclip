import { isUuidLike } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { AgentMailApiKeyField } from "@/features/connections/AgentMailApiKeyField";
import { useEmailAddressCheck } from "@/features/connections/useEmailAddressCheck";
import { ChatSetupNavigation } from "@/components/chat/ChatSetupNavigation";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Mail,
} from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useNavigate, useSearchParams, Link } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { toolsApi } from "@/api/tools";
import { emailApi } from "@/api/email";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardDescription } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AgentIcon } from "@/components/AgentIconPicker";
import { SearchableSelect } from "@/components/SearchableSelect";
import { TrustPresetSection } from "@/components/TrustPresetSection";
import { EmailSafetyNotice } from "@/components/EmailSafetyNotice";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  getTrustPreset,
  getLowTrustBoundary,
  lowTrustBoundaryHasScope,
} from "@/lib/trust-policy-ui";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime } from "@/lib/utils";
import type {
  AgentPermissions,
  EmailEndpointSummary,
} from "@paperclipai/shared";
const selectClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

interface EmailSetupDraft {
  connectionId: string; step: 0 | 1; agentId: string; requestId: string;
  addressMode: "new" | "existing"; inboxId: string; username: string; domain: string;
  mode: "websocket" | "webhook";
  domainSelected: boolean;
  takenAddresses: string[];
}
function readEmailSetupDraft(key: string): Partial<EmailSetupDraft> {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "{}");
    if (!value || typeof value !== "object") return {};
    const draft: Partial<EmailSetupDraft> = {};
    for (const field of ["connectionId", "agentId", "inboxId", "username", "domain"] as const) {
      if (typeof value[field] === "string") draft[field] = value[field];
    }
    if (value.step === 0 || value.step === 1) draft.step = value.step;
    if (typeof value.requestId === "string" && isUuidLike(value.requestId)) draft.requestId = value.requestId;
    if (value.addressMode === "new" || value.addressMode === "existing") draft.addressMode = value.addressMode;
    if (value.mode === "websocket" || value.mode === "webhook") draft.mode = value.mode;
    if (typeof value.domainSelected === "boolean") draft.domainSelected = value.domainSelected;
    if (Array.isArray(value.takenAddresses)) draft.takenAddresses = value.takenAddresses
      .filter((address: unknown): address is string => typeof address === "string" && address.length <= 320).slice(-20);
    return draft;
  } catch { return {}; }
}

export function EmailEndpointSetup() {
  const { selectedCompanyId } = useCompany();
  const [params] = useSearchParams();
  if (!selectedCompanyId) return <p role="status" className="p-6 text-sm text-muted-foreground">Loading email setup…</p>;
  return <EmailEndpointSetupForm key={`${selectedCompanyId}:${params.get("resume") ?? params.get("setupId") ?? params.get("connectionId") ?? "new"}:${params.get("agentId") ?? "choose"}`} companyId={selectedCompanyId} />;
}

function EmailEndpointSetupForm({ companyId }: { companyId: string }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const resumeId = params.get("resume");
  const setupId = params.get("setupId");
  const draftKey = `paperclip.agentmail-setup:${companyId}:${resumeId ?? setupId ?? params.get("connectionId") ?? "new"}:${params.get("agentId") ?? "choose"}`;
  const [draft] = useState(() => readEmailSetupDraft(draftKey));
  const [connectionId, setConnectionId] = useState(draft.connectionId ?? params.get("connectionId") ?? "");
  const [step, setStep] = useState<0 | 1 | 2>(draft.step ?? (resumeId ? 1 : 0));
  const [agentId, setAgentId] = useState(draft.agentId ?? params.get("agentId") ?? "");
  const [apiKey, setApiKey] = useState("");
  const [requestId, setRequestId] = useState(() => draft.requestId ?? resumeId ?? (setupId && isUuidLike(setupId) ? setupId : crypto.randomUUID()));
  const [addressMode, setAddressMode] = useState<"new" | "existing">(draft.addressMode ?? "new");
  const [inboxId, setInboxId] = useState(draft.inboxId ?? "");
  const [username, setUsername] = useState(draft.username ?? "");
  const [domain, setDomain] = useState(draft.domain ?? "agentmail.to");
  const [domainSelected, setDomainSelected] = useState(draft.domainSelected ?? (!!draft.domain && draft.domain !== "agentmail.to"));
  const [takenAddresses, setTakenAddresses] = useState<string[]>(draft.takenAddresses ?? []);
  const [mode, setMode] = useState<"websocket" | "webhook">(draft.mode ?? "websocket");
  const [trustOpen, setTrustOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [replacementConnectionId, setReplacementConnectionId] = useState("");
  const [replacementKey, setReplacementKey] = useState("");
  const [replacementRequestId, setReplacementRequestId] = useState(() => crypto.randomUUID());
  const [permissions, setPermissions] = useState<Partial<AgentPermissions>>({});
  const suggestedUsername = useRef(false);
  useEffect(() => {
    if (!companyId) return;
    // Save progress, never the API key. The same request ID resumes partial setup.
    try {
      if (step === 2) sessionStorage.removeItem(draftKey);
      else sessionStorage.setItem(draftKey, JSON.stringify({ connectionId, step, agentId,
        requestId, addressMode, inboxId, username, domain, domainSelected, takenAddresses, mode }));
    } catch { /* Setup remains usable when browser storage is unavailable. */ }
  }, [companyId, draftKey, connectionId, step, agentId, requestId, addressMode, inboxId, username, domain, domainSelected, takenAddresses, mode]);
  const agents = useQuery({ queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId), enabled: !!companyId });
  const projects = useQuery({ queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId), enabled: !!companyId && trustOpen });
  const boundaryIssues = useQuery({ queryKey: ["email-boundary-issues", companyId],
    queryFn: () => issuesApi.list(companyId), enabled: !!companyId && trustOpen });
  const chosen = agents.data?.find(a => a.id === agentId);
  const lowTrust = getTrustPreset(chosen?.permissions) === "low_trust_review";
  const scoped = lowTrustBoundaryHasScope(getLowTrustBoundary(chosen?.permissions));
  const inspected = useQuery({ queryKey: ["email-credential-inspect", companyId, connectionId],
    queryFn: () => emailApi.inspectSaved(companyId, connectionId),
    enabled: !!companyId && !!connectionId, retry: false });
  const inboxes = useQuery({ queryKey: ["email-inboxes", companyId],
    queryFn: () => emailApi.list(companyId), enabled: !!companyId });
  // A provider failure can leave an inbox allocated under this request. Resume
  // that exact endpoint; its agent and address are already fixed server-side.
  const pendingEndpoint = inboxes.data?.find(i => i.id === requestId && i.status !== "archived");
  const pendingAddress = pendingEndpoint?.address;
  const resumeAccount = useQuery({
    queryKey: ["email-resume-account", companyId, pendingEndpoint?.connectionId],
    queryFn: () => toolsApi.getConnection(pendingEndpoint!.connectionId),
    enabled: !!resumeId && requestId === resumeId && !!pendingEndpoint && !connectionId,
    retry: false,
  });
  useEffect(() => {
    if (!resumeId || !pendingEndpoint || connectionId || !resumeAccount.isSuccess) return;
    const savedAccount = resumeAccount.data?.config?.credentialConnectionId;
    if (typeof savedAccount === "string") setConnectionId(savedAccount);
    else setStep(0);
    setMode(pendingEndpoint.receiveMode);
  }, [resumeId, pendingEndpoint, connectionId, resumeAccount.isSuccess, resumeAccount.data]);
  useEffect(() => {
    if (pendingEndpoint) setAgentId(pendingEndpoint.assignedAgentId);
  }, [pendingEndpoint]);
  const scopedKey = inspected.data?.scope.scope_type === "inbox";
  const customDomains = [...new Set(inspected.data?.domains
    .filter(d => d.status === "VERIFIED" && d.domain.toLowerCase() !== "agentmail.to")
    .map(d => d.domain.toLowerCase()) ?? [])];
  const defaultDomain = customDomains[0] ?? "agentmail.to";
  useEffect(() => {
    if (inspected.isSuccess && !domainSelected && !pendingAddress) setDomain(defaultDomain);
  }, [inspected.isSuccess, domainSelected, pendingAddress, defaultDomain]);
  useEffect(() => {
    if (scopedKey) {
      setAddressMode("existing");
      setInboxId(inspected.data?.inboxes[0]?.inbox_id ?? "");
    }
  }, [scopedKey, inspected.data]);
  useEffect(() => {
    if (chosen && !suggestedUsername.current) {
      suggestedUsername.current = true;
      if (!username) setUsername(chosen.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 64));
    }
  }, [chosen, username]);
  const connect = useMutation({
    mutationFn: async () => {
      if (!connectionId) {
        const result = await emailApi.connect(companyId, {
          apiKey: apiKey.trim(), grantKind: "organization", allAgents: false,
          agentIds: [agentId], idempotencyKey: requestId,
        });
        setApiKey("");
        setConnectionId(result.id);
        void cache.invalidateQueries({ queryKey: queryKeys.tools.connections(companyId) });
      }

    },
    onSuccess: () => setStep(1),
  });
  const savedAccounts = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
    enabled: accountOpen,
  });
  const otherAccounts = savedAccounts.data?.connections.filter(connection =>
    connection.id !== connectionId && connection.status === "active" && connection.enabled
    && connection.config?.provider === "agentmail" && connection.config.emailCredential);
  const changeAccount = useMutation({
    mutationFn: async () => {
      if (pendingAddress) throw new Error("Finish connecting the reserved address before changing accounts.");
      if (replacementConnectionId) {
        // Verify this user can use the saved credential before switching drafts.
        await emailApi.inspectSaved(companyId, replacementConnectionId);
        return replacementConnectionId;
      }
      const connection = await emailApi.connect(companyId, {
        apiKey: replacementKey.trim(), grantKind: "organization", allAgents: false,
        agentIds: [agentId], idempotencyKey: replacementRequestId,
      });
      return connection.id;
    },
    onSuccess: id => {
      setConnectionId(id);
      // A different key needs a new setup identity; reusing the old one would
      // return the original credential from the connection idempotency lookup.
      setRequestId(replacementRequestId);
      setAddressMode("new");
      setInboxId("");
      setDomain("agentmail.to");
      setDomainSelected(false);
      setTakenAddresses([]);
      setReplacementKey("");
      setAccountOpen(false);
      setup.reset();
      void cache.invalidateQueries({ queryKey: queryKeys.tools.connections(companyId) });
    },
  });
  const agentDetail = useQuery({ queryKey: queryKeys.agents.detail(agentId),
    queryFn: () => agentsApi.get(agentId), enabled: !!agentId && trustOpen });
  const trust = useMutation({
    mutationFn: () => agentsApi.updatePermissions(agentId, {
      ...permissions,
      canCreateAgents: permissions.canCreateAgents ?? false,
      canCreateSkills: permissions.canCreateSkills ?? true,
      canAssignTasks: agentDetail.data?.access?.canAssignTasks ?? false,
    }, companyId),
    onSuccess: () => {
      setTrustOpen(false);
      void cache.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    },
  });
  const setup = useMutation({
    mutationFn: () => emailApi.setup(companyId, {
      assignedAgentId: agentId, credentialConnectionId: connectionId,
      ...(pendingAddress ? { inboxId: pendingAddress } : addressMode === "existing" ? { inboxId } : { username, domain }),
      receiveMode: mode, idempotencyKey: requestId,
    }),
    onError: async (error) => {
      if (error instanceof ApiError && (error.body as { code?: string } | null)?.code === "agentmail_address_taken") {
        setTakenAddresses(previous => [...new Set([...previous, `${username}@${domain}`.toLowerCase()])].slice(-20));
      }
      await cache.invalidateQueries({ queryKey: ["email-inboxes", companyId] });
    },
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["email-inboxes", companyId] });
      void cache.invalidateQueries({ queryKey: queryKeys.chatEndpoints.list(companyId) });
      void cache.invalidateQueries({ queryKey: queryKeys.tools.connections(companyId) });
      void cache.invalidateQueries({ queryKey: queryKeys.tools.connectionInstalls(connectionId) });
      setStep(2);
    },
  });
  const address = pendingAddress ?? (addressMode === "existing" ? inboxId : `${username}@${domain}`);
  const knownAddresses = new Set([...takenAddresses, ...(inspected.data?.inboxes.map(i => i.inbox_id.toLowerCase()) ?? [])]);
  const checkingNewAddress = step === 1 && addressMode === "new" && !pendingAddress && !scopedKey;
  const knownAddress = checkingNewAddress && knownAddresses.has(address.toLowerCase());
  const validUsername = /^[a-z0-9][a-z0-9._-]*$/.test(username) && username.length <= 64;
  const addressCheck = useEmailAddressCheck(companyId, connectionId, username, domain,
    checkingNewAddress && validUsername && !!inspected.data && !knownAddress);
  const addressTaken = knownAddress || addressCheck.result?.status === "taken";
  const suggestions = checkingNewAddress && validUsername && (addressTaken || addressCheck.result?.status === "unknown")
    ? ["-agent", "-team", `-${requestId.slice(0, 6)}`]
      .map(suffix => `${username.slice(0, 64 - suffix.length)}${suffix}`)
      .filter(name => !knownAddresses.has(`${name}@${domain}`)) : [];
  const assignedInbox = addressMode === "existing" && inboxes.data?.some(i => i.id !== requestId && i.address === address && i.status !== "archived");
  const addressError = addressTaken ? "This email address is already in use. Choose a different address."
    : assignedInbox ? "This inbox is already assigned to an agent." : null;
  const error = connect.error ?? (!addressTaken ? setup.error : null) ?? resumeAccount.error ?? inspected.error ?? agents.error;
  const busy = connect.isPending || setup.isPending;
  const identityReady = inboxes.isSuccess && (!resumeId || requestId !== resumeId || !!pendingEndpoint) && (!pendingEndpoint || pendingEndpoint.assignedAgentId === agentId);
  const canContinue = identityReady && !!chosen && !busy && !(lowTrust && !scoped) && (!!connectionId || !!apiKey.trim());
  const canCreate = identityReady && !!chosen && !busy && !!inspected.data && !(lowTrust && !scoped) && !addressError && !addressCheck.checking
    && (!!pendingAddress || (addressMode === "existing" ? !!inboxId : validUsername));
  const openTrust = () => { if (chosen) { setPermissions(chosen.permissions); setTrustOpen(true); } };
  const leave = () => navigate(`/apps/chat/${setup.data?.id ?? pendingEndpoint?.id}/settings`);
  const cancel = () => { try { sessionStorage.removeItem(draftKey); } catch {} navigate("/apps"); };
  return <div className="mx-auto max-w-xl space-y-6 p-6">
    <header className="space-y-2">
      <h1 className="text-xl font-bold">{step === 2 ? "Your agent’s email is ready" : "Give an agent an email address"}</h1>
    </header>
    {step < 2 && inboxes.isError && <div role="alert" className="space-y-2 text-sm">
      <p className="text-destructive">Could not load email setup progress. {inboxes.error.message}</p>
      <Button type="button" variant="outline" size="sm" disabled={busy || inboxes.isFetching} onClick={() => { void inboxes.refetch(); }}>
        {inboxes.isFetching ? "Loading…" : "Retry loading inboxes"}
      </Button>
    </div>}
    {step < 2 && resumeId === requestId && inboxes.isSuccess && !pendingEndpoint && <p role="alert" className="text-sm text-destructive">This email setup could not be found. Return to Connectors and start a new connection.</p>}
    {step < 2 && <ChatSetupNavigation labels={["Agent", "Email address"]} step={step}
      availableStep={step} disabled={busy} onSelect={index => { setup.reset(); setStep(index as 0 | 1); }} />}
    {step === 0 && <form className="space-y-6" onSubmit={event => { event.preventDefault(); if (canContinue) connect.mutate(); }}>
      <div className="space-y-2">
        <Label>Agent</Label>
        <SearchableSelect value={agentId} disabled={busy || !inboxes.isSuccess || !!pendingEndpoint} loading={agents.isPending} placeholder="Choose an agent" searchPlaceholder="Search all agents…" emptyMessage="No agents found."
          groups={[{ id: "agents", options: (agents.data ?? []).filter(a => !["terminated", "pending_approval"].includes(a.status))
            .map(a => ({ key: a.id, value: a.id, label: a.name, icon: a.icon })) }]}
          onValueChange={(id, option) => { setAgentId(id); setUsername(option.label.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 64)); }}
          renderValue={option => option ? <span className="flex items-center gap-2"><Avatar size="sm"><AvatarFallback><AgentIcon icon={String(option.icon ?? "bot")} /></AvatarFallback></Avatar>{option.label}</span> : "Choose an agent"} />
      </div>
      {!connectionId && <AgentMailApiKeyField value={apiKey} onChange={value => { setApiKey(value); connect.reset(); }} disabled={busy} />}
      {lowTrust && !scoped && <div role="alert" className="space-y-2 text-sm">
        <p>This agent needs a work boundary before it can receive email.</p>
        <Button type="button" variant="outline" size="sm" onClick={openTrust}>Configure work boundary</Button>
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-5">
        <Button type="button" variant="ghost" disabled={busy} onClick={cancel}>Cancel</Button>
        <Button disabled={!canContinue}>{connect.isPending ? "Connecting…" : "Continue"}<ArrowRight className="size-4" /></Button>
      </div>
    </form>}
    {step === 1 && <form className="space-y-6" onSubmit={event => { event.preventDefault(); if (canCreate) setup.mutate(); }}>
      <div className="space-y-2">
        <Label htmlFor={addressMode === "new" ? "email-name" : "email-existing"}>{chosen?.name}’s email address</Label>
        {addressMode === "new" ? <>
          <div className="flex items-center gap-2">
            <Input id="email-name" className="min-w-0" value={pendingAddress ? pendingAddress.slice(0, pendingAddress.lastIndexOf("@")) : username} maxLength={64} autoComplete="off" spellCheck={false} disabled={busy} readOnly={!!pendingAddress}
              aria-invalid={!!addressError} aria-describedby={addressError ? "email-address-error" : "email-address-status"}
              onChange={event => { setUsername(event.target.value.toLowerCase()); setup.reset(); }} />
            <select id="email-domain" aria-label="Email domain" className={`${selectClass} max-w-1/2 shrink-0`} value={pendingAddress ? pendingAddress.slice(pendingAddress.lastIndexOf("@") + 1) : domain}
              disabled={busy || !!pendingAddress || !inspected.data} onChange={event => { setDomainSelected(true); setDomain(event.target.value); setup.reset(); }}>
              {[...new Set([...customDomains, "agentmail.to", domain, ...(pendingAddress ? [pendingAddress.slice(pendingAddress.lastIndexOf("@") + 1)] : [])])]
                .map(value => <option key={value} value={value}>@{value}</option>)}
            </select>
          </div>
        </> : <select id="email-existing" className={selectClass} value={pendingAddress ?? inboxId} disabled={busy || scopedKey || !!pendingAddress}
          aria-invalid={!!addressError} aria-describedby={addressError ? "email-address-error" : undefined}
          onChange={event => { setInboxId(event.target.value); setup.reset(); }}>
          <option value="">Choose an inbox</option>
          {inspected.data?.inboxes.map(i => {
            const assigned = inboxes.data?.some(e => e.id !== requestId && e.address === i.inbox_id && e.status !== "archived");
            return <option key={i.inbox_id} value={i.inbox_id} disabled={assigned}>{i.inbox_id}{assigned ? " — already assigned" : ""}</option>;
          })}
        </select>}
        {pendingAddress && <p className="text-sm text-muted-foreground">This address is reserved for {chosen?.name}. Continue to finish connecting it.</p>}
        {scopedKey && !pendingAddress && <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">This API key can only use {inboxId}. To type a new address or choose a domain, use an account API key.</p>
          <Button type="button" variant="link" size="sm" className="h-auto p-0" disabled={busy || !identityReady}
            onClick={() => {
              setReplacementConnectionId(""); setReplacementKey("");
              setReplacementRequestId(crypto.randomUUID()); changeAccount.reset(); setAccountOpen(true);
            }}>Change AgentMail account</Button>
        </div>}
        {addressError && <p id="email-address-error" role="alert" className="text-sm text-destructive">{addressError}</p>}
        {checkingNewAddress && !addressError && <p id="email-address-status" role="status" className="text-sm text-muted-foreground">
          {addressCheck.checking ? "Checking address…" : addressCheck.error ? `Could not check this address. ${addressCheck.error}`
            : addressCheck.result?.status === "unknown" ? "AgentMail confirms availability when you create the address." : null}
        </p>}
        {suggestions.length > 0 && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" aria-label="Suggested email addresses">
          <span className="text-muted-foreground">Try:</span>
          {suggestions.map(name => <Button key={name} type="button" variant="link" size="sm" className="h-auto p-0" disabled={busy}
            onClick={() => { setUsername(name); setup.reset(); }}>{name}@{domain}</Button>)}
        </div>}
        {!scopedKey && !pendingAddress && <Button type="button" variant="link" size="sm" className="h-auto p-0" disabled={busy}
          onClick={() => { setAddressMode(addressMode === "new" ? "existing" : "new"); setup.reset(); }}>
          {addressMode === "new" ? "Use an existing inbox" : "Create a new address"}
        </Button>}
      </div>
      <Card className="py-4">
        <CardHeader className="px-4">
          <h2 className="text-sm font-medium">How it Works</h2>
          <CardDescription>Incoming email creates tasks for {chosen?.name}. Replies stay in the same task.</CardDescription>
        </CardHeader>
      </Card>
      <details className="space-y-4">
        <summary className="cursor-pointer text-sm text-muted-foreground">Advanced options</summary>
        <div className="space-y-4">
          {addressMode === "new" && <div className="space-y-2">
            <a className="text-sm underline" href="https://docs.agentmail.to/custom-domains" target="_blank" rel="noreferrer">Set up a custom domain ↗</a>
          </div>}
          <div className="space-y-2">
            <Label htmlFor="email-mode">Receiving</Label>
            <select id="email-mode" value={mode} disabled={busy} className={selectClass} onChange={event => setMode(event.target.value as typeof mode)}>
              <option value="websocket">Live connection</option><option value="webhook">Webhook</option>
            </select>
          </div>
          <EmailSafetyNotice />
          <div className="space-y-2 text-sm">
            <p>{lowTrust && scoped ? "Low-trust review configured" : "Manage which tasks and tools this agent can access."}</p>
            <Button type="button" variant="outline" size="sm" onClick={openTrust}>Review trust settings</Button>
          </div>
        </div>
      </details>
      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      {inspected.isPending && <p role="status" className="text-sm text-muted-foreground">Loading email options…</p>}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-5">
        <Button type="button" variant="ghost" disabled={busy} onClick={() => { setup.reset(); setStep(0); }}><ArrowLeft className="size-4" />Back</Button>
        <Button disabled={!canCreate}>
          {setup.isPending ? "Connecting…" : pendingAddress ? "Finish connecting" : addressMode === "new" ? "Create email address" : "Connect email address"}<ArrowRight className="size-4" />
        </Button>
      </div>
    </form>}
    {step === 2 && <div className="space-y-6">
      <div className="space-y-2"><p className="flex items-center gap-2 font-medium"><Check className="size-4" />{setup.data?.address}</p>
        <p className="text-sm text-muted-foreground">{chosen?.name} can now receive email at this address.</p></div>
      <div className="flex items-center justify-between gap-3 border-t border-border pt-5">
        <Button variant="ghost" onClick={leave}>Email settings</Button><Button onClick={() => navigate("/apps")}>Done</Button>
      </div>
    </div>}
      <Dialog open={accountOpen} onOpenChange={open => {
        if (!changeAccount.isPending) { setAccountOpen(open); if (!open) setReplacementKey(""); }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change AgentMail account</DialogTitle>
            <DialogDescription>Choose a saved account or enter an account API key to create an email address.</DialogDescription>
          </DialogHeader>
          <form className="space-y-6" onSubmit={event => {
            event.preventDefault();
            if (!changeAccount.isPending && !pendingAddress && (replacementConnectionId || replacementKey.trim())) changeAccount.mutate();
          }}>
            {!!otherAccounts?.length && <div className="space-y-2">
              <Label htmlFor="email-account">AgentMail account</Label>
              <select id="email-account" className={selectClass} value={replacementConnectionId} disabled={changeAccount.isPending}
                onChange={event => { setReplacementConnectionId(event.target.value); setReplacementKey(""); changeAccount.reset(); }}>
                <option value="">Enter another API key</option>
                {otherAccounts.map(connection => <option key={connection.id} value={connection.id}>
                  {connection.name} · saved {formatDateTime(connection.createdAt)}
                </option>)}
              </select>
            </div>}
            {savedAccounts.isFetching && <p role="status" className="text-sm text-muted-foreground">Loading saved accounts…</p>}
            {savedAccounts.isError && <p role="alert" className="text-sm text-destructive">Could not load saved accounts. {savedAccounts.error.message}</p>}
            {!replacementConnectionId && <AgentMailApiKeyField value={replacementKey} disabled={changeAccount.isPending}
              onChange={value => { setReplacementKey(value); changeAccount.reset(); }} />}
            {changeAccount.error && <p role="alert" className="text-sm text-destructive">{changeAccount.error.message}</p>}
            <div className="flex items-center justify-between gap-3 border-t border-border pt-5">
              <Button type="button" variant="ghost" disabled={changeAccount.isPending} onClick={() => { setAccountOpen(false); setReplacementKey(""); }}>Cancel</Button>
              <Button disabled={changeAccount.isPending || !!pendingAddress || !(replacementConnectionId || replacementKey.trim())}>
                {changeAccount.isPending ? "Connecting…" : "Use this account"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={trustOpen} onOpenChange={setTrustOpen}>
        <DialogContent className="max-h-screen overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Trust settings · {chosen?.name}</DialogTitle>
            <DialogDescription>
              Changes apply to all of this agent’s work. Use a dedicated email
              agent if its other tasks need broader access.
            </DialogDescription>
          </DialogHeader>
          <TrustPresetSection
            permissions={permissions}
            onChange={setPermissions}
            companyId={companyId}
            projectCandidates={(projects.data ?? []).map((p) => ({
              id: p.id,
              label: p.name,
            }))}
            issueCandidates={(boundaryIssues.data ?? []).map((issue) => ({
              id: issue.id,
              label: `${issue.identifier} · ${issue.title}`,
            }))}
            allowSingleIssue={false}
            candidatesLoading={projects.isPending || boundaryIssues.isPending}
          />
          <p className="text-xs text-muted-foreground">
            Low trust limits Paperclip access; it does not sandbox the runtime.
            Review filesystem, tool, and secret access separately.
          </p>
          {(trust.error || projects.error || boundaryIssues.error) && (
            <p role="alert" className="text-sm text-destructive">
              {(trust.error ?? projects.error ?? boundaryIssues.error)?.message}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTrustOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                trust.isPending ||
                agentDetail.isPending ||
                !!agentDetail.error ||
                (getTrustPreset(permissions) === "low_trust_review" &&
                  !lowTrustBoundaryHasScope(getLowTrustBoundary(permissions)))
              }
              onClick={() => trust.mutate()}
            >
              Save trust settings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  </div>;
}

export function EmailConnectionInboxes({
  companyId,
  connectionId,
  canConfigure,
}: {
  companyId: string;
  connectionId: string;
  canConfigure: boolean;
}) {
  const query = useQuery({
    queryKey: ["email-inboxes", companyId],
    queryFn: () => emailApi.list(companyId),
    refetchInterval: 10_000,
  });
  const connections = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
  });
  const children = new Set(
    connections.data?.connections
      .filter((c) => c.config?.credentialConnectionId === connectionId)
      .map((c) => c.id),
  );
  const inboxes =
    query.data?.filter(
      (i) => i.connectionId === connectionId || children.has(i.connectionId),
    ) ?? [];
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">
            Give an agent an email address
          </h2>
          <p className="text-sm text-muted-foreground">
            Each email conversation becomes a task.
          </p>
        </div>
        {canConfigure && (
          <Button asChild size="lg">
            <Link
              to={`/apps/chat/connect?provider=agentmail&connectionId=${connectionId}`}
            >
              Give an agent an email address
            </Link>
          </Button>
        )}
      </div>
      {inboxes.map((i) => (
        <div
          key={i.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4"
        >
          <Link
            className="text-sm underline"
            to={`/apps/chat/${i.id}/settings`}
          >
            {i.address}
          </Link>
          <span className="text-xs text-muted-foreground">
            {i.lastError ??
              (i.status === "active" ? "Receiving email" : i.status)}
          </span>
        </div>
      ))}
      {!!inboxes.length && <EmailSafetyNotice />}
      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          {query.error.message}
        </p>
      )}
    </section>
  );
}
export function EmailEndpointSettings({
  endpointId,
  companyId,
}: {
  endpointId: string;
  companyId: string;
}) {
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ["email-inboxes", companyId],
    queryFn: () => emailApi.list(companyId),
    refetchInterval: 10_000,
  });
  const inbox = query.data?.find(
    (row: EmailEndpointSummary) => row.id === endpointId,
  );
  const [removed, setRemoved] = useState(false);
  const [replacementKey, setReplacementKey] = useState("");
  const [receiveMode, setReceiveMode] = useState<"websocket" | "webhook" | "">(
    "",
  );
  const reconnect = useMutation({
    mutationFn: () =>
      emailApi.reconnect(
        endpointId,
        replacementKey,
        receiveMode || inbox!.receiveMode,
      ),
    onSuccess: () => {
      setReplacementKey("");
    },
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: ["email-inboxes", companyId] });
    },
  });
  const control = useMutation({
    mutationFn: (action: "pause" | "resume" | "remove") =>
      emailApi.control(endpointId, action),
    onSuccess: (result) => {
      setRemoved(result.status === "archived");
      void cache.invalidateQueries({ queryKey: ["email-inboxes", companyId] });
    },
  });
  if (removed)
    return <p>Inbox disconnected. Email history remains in its tasks.</p>;
  if (!inbox)
    return (
      <p role={query.error ? "alert" : undefined}>
        {query.error?.message ?? "Loading email inbox…"}
      </p>
    );
  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-xl font-bold">{inbox.address}</h1>
      <p className="text-sm text-muted-foreground">
        {inbox.status} ·{" "}
        {inbox.receiveMode === "websocket" ? "Live connection" : "Webhook"}
      </p>
      <p className="text-sm text-muted-foreground">
        Last mail check: {inbox.lastSyncAt ? new Date(inbox.lastSyncAt).toLocaleString() : "Not checked yet"}
      </p>
      <p className="text-sm">
        Each email conversation is a task. Task comments stay internal; use
        Email reply to send.
      </p>
      {inbox.lastError && (
        <p role="alert" className="text-sm text-destructive">
          {inbox.lastError}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={control.isPending}
          onClick={() =>
            control.mutate(inbox.status === "active" ? "pause" : "resume")
          }
        >
          {inbox.status === "active" ? "Pause" : "Resume"}
        </Button>
        <Button
          variant="outline"
          disabled={control.isPending}
          onClick={() => control.mutate("remove")}
        >
          Disconnect inbox
        </Button>
      </div>
      <div className="space-y-2">
        <AgentMailApiKeyField label="Reconnect this inbox with a new API key" value={replacementKey} onChange={setReplacementKey} disabled={reconnect.isPending} />
        <Label htmlFor="email-reconnect-mode">Receiving mode</Label>
        <select
          id="email-reconnect-mode"
          className={selectClass}
          value={receiveMode || inbox.receiveMode}
          onChange={(e) =>
            setReceiveMode(e.target.value as "websocket" | "webhook")
          }
        >
          <option value="websocket">Live connection</option>
          <option value="webhook">Webhook</option>
        </select>
        <Button
          variant="outline"
          disabled={!replacementKey || reconnect.isPending}
          onClick={() => reconnect.mutate()}
        >
          Reconnect inbox
        </Button>
      </div>
      {reconnect.error && (
        <p role="alert" className="text-sm text-destructive">
          {reconnect.error.message}
        </p>
      )}
      {control.error && (
        <p role="alert" className="text-sm text-destructive">
          {control.error.message}
        </p>
      )}
    </div>
  );
}
