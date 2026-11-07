// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Root-local session ownership and replaceable workspace lifecycle ports.
import { resolve } from "node:path";
import type { CoreConfig, LayeredConfig } from "../../types/config.js";
import type { Tokenizer } from "../../services/tokenizer.js";

export type HostSessionStatus = "idle" | "busy" | "retry" | "unknown";

export interface WorkspaceSessionPorts {
  durable: boolean;
  realWorkspace: boolean;
  status(sessionId: string, workspace: string): Promise<HostSessionStatus>;
  config(sessionId: string, limit: number, providerId: string, modelId: string, runtime: LayeredConfig): CoreConfig;
  tokenizer(providerId: string, modelId: string): Tokenizer;
}

interface Registration { token: object; ports: WorkspaceSessionPorts }
interface RetiredOwner { workspace: string; durable: boolean; realWorkspace: boolean }
export type WorkspaceRegistration = (() => void) & {
  readonly token: object; readonly workspace: string; readonly reopened: readonly string[];
};

export class SessionOwners {
  private readonly sessionWorkspaces = new Map<string, string>();
  private readonly registrations = new Map<string, Registration>();
  private readonly retired = new Map<string, RetiredOwner>();

  register(workspace: string, ports: WorkspaceSessionPorts): WorkspaceRegistration {
    const key = resolve(workspace);
    const token = {};
    const reopened: string[] = [];
    for (const [sessionId, owner] of this.retired) {
      if (owner.workspace !== key) continue;
      this.retired.delete(sessionId);
      this.sessionWorkspaces.set(sessionId, key);
      reopened.push(sessionId);
    }
    this.registrations.set(key, { token, ports });
    return Object.assign(() => {
      if (this.registrations.get(key)?.token !== token) return;
      this.registrations.delete(key);
      for (const [sessionId, owner] of this.sessionWorkspaces) {
        if (owner === key) this.sessionWorkspaces.delete(sessionId);
      }
    }, { token, workspace: key, reopened });
  }

  /** Verified host disposal only. Preserve immutable durability facts without SDK closures. */
  retire(registration: WorkspaceRegistration): string[] {
    if (!this.isCurrent(registration)) return [];
    const result: string[] = [];
    const ports = this.registrations.get(registration.workspace)!.ports;
    for (const [sessionId, workspace] of this.sessionWorkspaces) {
      if (workspace !== registration.workspace) continue;
      this.sessionWorkspaces.delete(sessionId);
      this.retired.set(sessionId, { workspace, durable: ports.durable, realWorkspace: ports.realWorkspace });
      result.push(sessionId);
    }
    return result;
  }

  isCurrent(registration: WorkspaceRegistration): boolean {
    return this.registrations.get(registration.workspace)?.token === registration.token;
  }

  claim(sessionId: string, registration: WorkspaceRegistration): void {
    if (this.isCurrent(registration)) this.sessionWorkspaces.set(sessionId, registration.workspace);
  }

  get(sessionId: string): string | undefined { return this.sessionWorkspaces.get(sessionId); }
  entries(): IterableIterator<[string, string]> { return this.sessionWorkspaces.entries(); }
  delete(sessionId: string): void { this.sessionWorkspaces.delete(sessionId); this.retired.delete(sessionId); }
  hasRegistrations(): boolean { return this.registrations.size > 0; }
  hasRetired(): boolean { return this.retired.size > 0; }
  current(sessionId: string, workspace: string): Registration | undefined {
    const owner = this.get(sessionId) ?? resolve(workspace);
    return this.registrations.get(owner);
  }
  knownWorkspace(sessionId: string): string | undefined {
    const owner = this.get(sessionId);
    if (owner && this.registrations.get(owner)?.ports.realWorkspace) return owner;
    const retired = this.retired.get(sessionId);
    return retired?.realWorkspace ? retired.workspace : undefined;
  }
  durable(sessionId: string): boolean {
    const owner = this.get(sessionId);
    return owner !== undefined ? this.registrations.get(owner)?.ports.durable === true
      : this.retired.get(sessionId)?.durable === true;
  }

  async status(sessionId: string): Promise<HostSessionStatus> {
    const owner = this.get(sessionId);
    if (!owner) return "unknown";
    const port = this.registrations.get(owner)?.ports;
    if (!port) return "unknown";
    // A status call started just before disposal must not strand the root sweep
    // indefinitely. Timeout remains fail-closed for ordinary, unretired chats.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<HostSessionStatus>(resolve => {
      timer = setTimeout(() => resolve("unknown"), 3_000);
      timer.unref?.();
    });
    try { return await Promise.race([port.status(sessionId, owner), timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }
}
