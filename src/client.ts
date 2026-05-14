/**
 * InstaKit — Instants (Moonshot) client
 *
 * Usage:
 *   const kit = new InstaKit();
 *   const session = await kit.login({ username, password });
 *   kit.saveSession(session);
 *   // restore later:
 *   const kit2 = new InstaKit();
 *   kit2.loadSession(session);
 *
 *   await kit.sendQuickSnap({ photo: buf, caption: "hi", audience: "besties" });
 *   const snaps = await kit.getLatestQuickSnaps();
 *   const history = await kit.getMyQuickSnapHistory({ first: 20 });
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

import { HttpClient } from "./http";
import {
  login as doLogin,
  logout as doLogout,
  verify2FA,
  TwoFactorRequiredError,
  totp,
} from "./auth";
import {
  sendQuickSnap,
  getLatestQuickSnaps,
  getMyQuickSnapHistory,
} from "./quicksnap";

import type { Session, LoginOptions, TwoFactorInfo, SendQuickSnapOptions, QuickSnapMedia, QuickSnapHistoryPage } from "./types";

export { TwoFactorRequiredError };
export type { Session, LoginOptions, TwoFactorInfo, SendQuickSnapOptions, QuickSnapMedia, QuickSnapHistoryPage };

export class InstaKit {
  private http: HttpClient;
  private session: Session | null = null;

  constructor() {
    this.http = new HttpClient();
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  /**
   * Login. Throws TwoFactorRequiredError if 2FA is needed.
   * Call verify2FA() next.
   */
  async login(opts: LoginOptions): Promise<Session> {
    const session = await doLogin(this.http, opts);
    this.session = session;
    return session;
  }

  /**
   * Complete 2FA. Call after catching TwoFactorRequiredError from login().
   */
  async verify2FA(info: TwoFactorInfo, code: string, method: 1 | 3 | 6 = 1): Promise<Session> {
    const session = await verify2FA(this.http, info, code, method);
    this.session = session;
    return session;
  }

  /** Restore a previously saved session without re-logging in. */
  loadSession(session: Session): void {
    this.session = session;
    this.http    = new HttpClient(session.deviceId, session.familyDeviceId);
    this.http.restoreSession(session);
  }

  async logout(): Promise<void> {
    if (this.session) {
      await doLogout(this.http, this.session);
      this.session = null;
    }
  }

  // ── Session persistence ───────────────────────────────────────────────────

  saveSession(session: Session, filePath?: string): void {
    const fp = filePath ?? `session_${session.username}.json`;
    fs.writeFileSync(fp, JSON.stringify(session, null, 2), "utf-8");
  }

  loadSessionFile(filePath: string): Session {
    const raw = fs.readFileSync(filePath, "utf-8");
    const session: Session = JSON.parse(raw);
    this.loadSession(session);
    return session;
  }

  // ── QuickSnap ─────────────────────────────────────────────────────────────

  /** Upload and publish a QuickSnap. */
  async sendQuickSnap(opts: SendQuickSnapOptions): Promise<QuickSnapMedia> {
    this._requireSession();
    return sendQuickSnap(this.http, opts);
  }

  /** Get currently available QuickSnaps from friends. */
  async getLatestQuickSnaps(): Promise<QuickSnapMedia[]> {
    this._requireSession();
    return getLatestQuickSnaps(this.http);
  }

  /** Get my own QuickSnap posting history (paginated). */
  async getMyQuickSnapHistory(opts?: { first?: number; after?: string }): Promise<QuickSnapHistoryPage> {
    this._requireSession();
    return getMyQuickSnapHistory(this.http, opts);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _requireSession(): void {
    if (!this.session) throw new Error("Not logged in. Call login() or loadSession() first.");
  }
}

// ── Interactive login helper (CLI) ────────────────────────────────────────────

/**
 * Interactive login helper.
 * If `totpSecret` is provided, auto-generates TOTP code when 2FA is required (no prompt).
 * Otherwise prompts user to enter the code manually.
 */
export async function interactiveLogin(
  kit:         InstaKit,
  username:    string,
  password:    string,
  totpSecret?: string,
): Promise<Session> {
  let session: Session;
  try {
    session = await kit.login({ username, password });
  } catch (e) {
    if (!(e instanceof TwoFactorRequiredError)) throw e;

    const tfInfo = e.twoFactorInfo;
    const method = tfInfo.availableMethods.includes(3) ? 3
                 : tfInfo.availableMethods.includes(1) ? 1
                 : 6 as 1 | 3 | 6;

    let code: string;
    if (totpSecret && method === 3) {
      // Auto-generate TOTP code from secret
      code = totp(totpSecret);
      console.log(`  ↳ Auto 2FA (TOTP): ${code}`);
    } else {
      // Prompt user
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const methodName = method === 1 ? "SMS" : method === 3 ? "TOTP" : "WhatsApp";
      code = await new Promise<string>((resolve) => {
        rl.question(`2FA code (${methodName}): `, (ans) => { rl.close(); resolve(ans.trim()); });
      });
    }

    session = await kit.verify2FA(tfInfo, code, method);
  }
  return session;
}
