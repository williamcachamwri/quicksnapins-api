/**
 * Login / logout for Instagram Instants (Moonshot).
 *
 * Uses the standard Instagram mobile login endpoint:
 *   POST /api/v1/accounts/login/
 *
 * The app uses the same Bloks-based endpoint as regular Instagram iOS.
 * Scraped from binary: /api/v1/bloks/async_action/com.bloks.www.bloks.caa.login.async.auth_login_request/
 * We use the classic /accounts/login/ which is equivalent and simpler.
 */

import { createHmac } from "crypto";

// ── TOTP (RFC 6238) ───────────────────────────────────────────────────────────

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(s: string): Buffer {
  const input = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of input) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(output);
}

/**
 * Generate a TOTP 6-digit code from a base32 secret.
 * Compatible with Google Authenticator, Authy, etc. (RFC 6238 / HMAC-SHA1).
 *
 * @param secret  Base32-encoded TOTP secret (spaces and = are ignored)
 * @param offset  Time step offset — 0=current window, -1=previous, +1=next
 */
export function totp(secret: string, offset = 0): string {
  const key     = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / 30) + offset;

  // 8-byte big-endian counter
  const msg = Buffer.alloc(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }

  const hmac  = createHmac("sha1", key).update(msg).digest();
  const off   = hmac[hmac.length - 1] & 0x0f;
  const code  = ((hmac[off] & 0x7f) << 24 | hmac[off + 1] << 16 | hmac[off + 2] << 8 | hmac[off + 3]) % 1_000_000;
  return String(code).padStart(6, "0");
}

import { v4 as uuidv4 } from "uuid";
import { ENDPOINTS } from "./constants";
import type { HttpClient } from "./http";
import type { LoginOptions, Session, TwoFactorInfo } from "./types";

// ── Errors ────────────────────────────────────────────────────────────────────

export class TwoFactorRequiredError extends Error {
  constructor(public readonly twoFactorInfo: TwoFactorInfo) {
    super(`2FA required for ${twoFactorInfo.username}`);
    this.name = "TwoFactorRequiredError";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function encodePassword(password: string): string {
  const ts = Math.floor(Date.now() / 1000);
  return `#PWD_INSTAGRAM:0:${ts}:${password}`;
}

function jazoest(s: string): string {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return `2${sum}`;
}

// ── Login ─────────────────────────────────────────────────────────────────────

export async function login(http: HttpClient, opts: LoginOptions): Promise<Session> {
  const phoneId = uuidv4();
  const guid    = uuidv4();

  // Get CSRF token first
  try { await http.get("/si/fetch_headers/", { challenge_type: "signup", guid }); } catch { /* ignore */ }

  let data: Record<string, unknown>;
  try {
    data = await http.post<Record<string, unknown>>(ENDPOINTS.LOGIN, {
      username:            opts.username,
      enc_password:        encodePassword(opts.password),
      device_id:           http.deviceId,
      phone_id:            phoneId,
      guid:                guid,
      adid:                uuidv4(),
      login_attempt_count: "0",
      jazoest:             jazoest(phoneId),
    });
  } catch (e: unknown) {
    const err = e as { response?: { data?: unknown } };
    data = (err.response?.data ?? {}) as Record<string, unknown>;
    if (!data || Object.keys(data).length === 0) throw e;
  }

  if (data.two_factor_required) {
    const tf = data.two_factor_info as Record<string, unknown>;
    const methods: number[] = [];
    if (tf.sms_two_factor_on)      methods.push(1);
    if (tf.totp_two_factor_on)     methods.push(3);
    if (tf.whatsapp_two_factor_on) methods.push(6);
    throw new TwoFactorRequiredError({
      username:            String(tf.username ?? opts.username),
      twoFactorIdentifier: String(tf.two_factor_identifier ?? ""),
      deviceId:            String(tf.device_id ?? http.deviceId),
      availableMethods:    methods,
      obfuscatedPhone:     tf.obfuscated_phone_number_2 as string | undefined,
    });
  }

  if (data.status !== "ok" || !data.logged_in_user) {
    throw new Error(`Login failed: ${(data.message as string | undefined) ?? "unknown"}`);
  }

  return buildSession(http, data, phoneId, opts.username);
}

// ── Two-Factor Auth ───────────────────────────────────────────────────────────

export async function verify2FA(
  http:   HttpClient,
  info:   TwoFactorInfo,
  code:   string,
  method: 1 | 3 | 6 = 1,
): Promise<Session> {
  let data: Record<string, unknown>;
  try {
    data = await http.post<Record<string, unknown>>("/accounts/two_factor_login/", {
      username:              info.username,
      verification_code:     code.replace(/\s/g, ""),
      two_factor_identifier: info.twoFactorIdentifier,
      trust_this_device:     "0",
      verification_method:   String(method),
      device_id:             info.deviceId,
    });
  } catch (e: unknown) {
    const err = e as { response?: { data?: Record<string, unknown> } };
    const body = err.response?.data;
    const msg  = (body?.message as string | undefined) ?? (body?.error_type as string | undefined) ?? "unknown";
    throw new Error(`2FA failed: ${msg}`);
  }

  if (!data!.logged_in_user) {
    throw new Error(`2FA failed: ${(data!.message as string | undefined) ?? "unknown"}`);
  }

  return buildSession(http, data!, uuidv4(), info.username);
}

// ── Logout ────────────────────────────────────────────────────────────────────

export async function logout(http: HttpClient, session: Session): Promise<void> {
  await http.post(ENDPOINTS.LOGOUT, {
    phone_id:  session.phoneId,
    guid:      session.deviceId,
    device_id: session.deviceId,
    user_id:   session.userId,
  }).catch(() => { /* ignore errors on logout */ });
}

// ── Internal ──────────────────────────────────────────────────────────────────

function buildSession(
  http:             HttpClient,
  data:             Record<string, unknown>,
  phoneId:          string,
  fallbackUsername: string,
): Session {
  const user    = data.logged_in_user as Record<string, unknown>;
  const cookies = http.getCookies();
  return {
    userId:         String(user.pk ?? ""),
    username:       String(user.username ?? fallbackUsername),
    authToken:      http.getAuthToken() || cookies["sessionid"] || "",
    csrfToken:      http.getCsrfToken() || cookies["csrftoken"] || "",
    deviceId:       http.deviceId,
    familyDeviceId: http.familyDeviceId,
    phoneId,
    mid:            cookies["mid"] ?? "",
    cookies,
  };
}
