import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { isUuidLike } from "@paperclipai/shared";
import { emailApi } from "@/api/email";
import { Button } from "@/components/ui/button";
import { AgentMailCredentialField } from "./AgentMailCredentialField";

interface InlineEmailDraft {
  setupRequestId: string;
  credentialId: string | null;
  inboxConnectionId: string | null;
  selectedCredentialId: string | null;
}
function readDraft(key: string): InlineEmailDraft | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    return value && isUuidLike(value.setupRequestId) && ["credentialId", "inboxConnectionId", "selectedCredentialId"]
      .every(field => value[field] === null || typeof value[field] === "string") ? value : null;
  } catch { return null; }
}

/** Same account and inbox APIs as Apps; task setup fixes the access defaults. */
export function AgentMailIntentSetup({ companyId, agentId, requestId, savedCredentialId, readyConnectionId, onComplete, onDecline, declining = false }: {
  companyId: string;
  agentId: string;
  requestId: string;
  savedCredentialId?: string | null;
  readyConnectionId?: string | null;
  onComplete(connectionId: string): Promise<void>;
  onDecline(): void;
  declining?: boolean;
}) {
  const draftKey = `paperclip.agentmail-inline:${companyId}:${requestId}`;
  const [draft] = useState(() => readDraft(draftKey));
  const [setupRequestId, setSetupRequestId] = useState(draft?.setupRequestId ?? requestId);
  const [apiKey, setApiKey] = useState("");
  const [credentialId, setCredentialId] = useState(draft ? draft.credentialId : savedCredentialId ?? null);
  const [selectedCredentialId, setSelectedCredentialId] = useState<string | null>(draft?.selectedCredentialId ?? null);
  const [inboxConnectionId, setInboxConnectionId] = useState(readyConnectionId ?? draft?.inboxConnectionId ?? null);
  useEffect(() => {
    try { sessionStorage.setItem(draftKey, JSON.stringify({ setupRequestId, credentialId, inboxConnectionId, selectedCredentialId })); }
    catch { /* Keep setup usable without browser storage. */ }
  }, [draftKey, setupRequestId, credentialId, inboxConnectionId, selectedCredentialId]);
  const changeKey = useMutation({
    mutationFn: async () => {
      const pending = (await emailApi.list(companyId)).find(inbox => inbox.id === setupRequestId && inbox.status !== "archived");
      if (pending?.address) throw new Error(`The address ${pending.address} is already reserved. Finish setup with its saved key.`);
      if (pending) await emailApi.control(pending.id, "remove");
    },
    onSuccess: () => {
      setSetupRequestId(crypto.randomUUID());
      setCredentialId(null);
      setSelectedCredentialId("");
      setApiKey("");
      setup.reset();
    },
  });
  const setup = useMutation({
    mutationFn: async () => {
      let connectionId = inboxConnectionId;
      if (!connectionId) {
        let accountId = credentialId || selectedCredentialId;
        if (!accountId) {
          const account = await emailApi.connect(companyId, {
            apiKey: apiKey.trim(), grantKind: "organization", allAgents: false,
            agentIds: [agentId], idempotencyKey: setupRequestId,
          });
          accountId = account.id;
          setCredentialId(accountId);
          setApiKey("");
        }
        setCredentialId(accountId);
        const inbox = await emailApi.setup(companyId, {
          assignedAgentId: agentId, credentialConnectionId: accountId,
          receiveMode: "websocket", idempotencyKey: setupRequestId,
        });
        connectionId = inbox.connectionId;
        setInboxConnectionId(connectionId);
      }
      // Only the server's completed intent may resume the task. A saved API key
      // alone is not an inbox, and failures remain retryable in this same form.
      await onComplete(connectionId);
      try { sessionStorage.removeItem(draftKey); } catch { /* Optional draft storage. */ }
    },
  });
  return <form className="mt-4 space-y-4" data-testid="agentmail-inline-setup" onSubmit={event => {
    event.preventDefault();
    if (!setup.isPending && !changeKey.isPending && !declining) setup.mutate();
  }}>
    {credentialId || inboxConnectionId
      ? <p className="text-sm text-muted-foreground">{inboxConnectionId ? "Your inbox is ready. Continue to resume the chat." : "API key saved. Finish creating the inbox."}</p>
      : <AgentMailCredentialField companyId={companyId} connectionId={selectedCredentialId}
          onConnectionChange={id => { setSelectedCredentialId(id); setApiKey(""); }}
          value={apiKey} onChange={setApiKey} disabled={setup.isPending || changeKey.isPending || declining} />}
    {credentialId && !inboxConnectionId && <Button type="button" variant="link" size="sm" className="h-auto p-0"
      disabled={setup.isPending || changeKey.isPending || declining} onClick={() => changeKey.mutate()}>
      {changeKey.isPending ? "Checking setup…" : "Change API key"}
    </Button>}
    {changeKey.error && <p className="text-sm text-destructive" role="alert">{changeKey.error.message}</p>}
    {setup.error && <p className="text-sm text-destructive" role="alert">{setup.error.message}</p>}
    <div className="flex items-center justify-between gap-2">
      <Button type="button" variant="ghost" disabled={setup.isPending || changeKey.isPending || declining} onClick={onDecline}>Not now</Button>
      <Button type="submit" disabled={setup.isPending || changeKey.isPending || declining || (!credentialId && !selectedCredentialId && !inboxConnectionId && !apiKey.trim())}>
        {setup.isPending ? "Connecting…" : inboxConnectionId ? "Continue" : credentialId ? "Finish setup" : "Connect AgentMail"}
      </Button>
    </div>
  </form>;
}
