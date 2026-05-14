import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import { v4 as uuidv4 } from "uuid";
import * as qs from "querystring";
import { APP_ID, APP_VERSION, APP_VERSION_CODE, BASE_URL, IG_CAPABILITIES } from "./constants";
import type { Session } from "./types";

const DEFAULT_HEADERS = {
  "X-IG-App-ID":         APP_ID,
  "X-IG-Capabilities":   IG_CAPABILITIES,
  "X-IG-Connection-Type":"WIFI",
  "X-FB-HTTP-Engine":    "Liger",
  "X-FB-Client-IP":      "True",
  "X-FB-Server-Cluster": "True",
  "Accept":              "*/*",
  "Accept-Language":     "en-US",
  "Content-Type":        "application/x-www-form-urlencoded; charset=UTF-8",
};

export class HttpClient {
  private http: AxiosInstance;
  private _cookies: Record<string, string> = {};
  private _csrfToken = "";
  private _authToken = "";
  readonly deviceId: string;
  readonly familyDeviceId: string;

  constructor(deviceId?: string, familyDeviceId?: string) {
    this.deviceId       = deviceId       ?? uuidv4();
    this.familyDeviceId = familyDeviceId ?? uuidv4();
    this.http = axios.create({
      baseURL:        `${BASE_URL}/api/v1`,
      timeout:        30_000,
      maxRedirects:   5,
      // Allow all status codes through so callers can read the error body
      // (e.g. 500 from configure_to_quick_snap with IG error details)
      validateStatus: () => true,
    });
    this._setupInterceptors();
  }

  // ── Public accessors ──────────────────────────────────────────────────────

  getCookies()      { return { ...this._cookies }; }
  getAuthToken()    { return this._authToken; }
  getCsrfToken()    { return this._csrfToken; }

  /** Restore a saved session into this client */
  restoreSession(session: Session): void {
    this._cookies   = { ...session.cookies };
    this._csrfToken = session.csrfToken;
    this._authToken = session.authToken;
    // ensure mid and ig-u cookies are present
    if (session.mid) this._cookies["mid"] = session.mid;
  }

  // ── HTTP methods ──────────────────────────────────────────────────────────

  async get<T = unknown>(path: string, params?: Record<string, unknown>): Promise<T> {
    const res = await this.http.get<T>(path, {
      params,
      transformRequest: (d) => d,
    });
    return res.data;
  }

  async post<T = unknown>(path: string, body: Record<string, unknown>, cfg?: AxiosRequestConfig): Promise<T> {
    const res = await this.http.post<T>(
      path,
      qs.stringify(body as Record<string, string>),
      cfg,
    );
    // Surface non-2xx as errors with full response body
    if (res.status >= 400) {
      const bodyStr = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
      throw new Error(`HTTP ${res.status}: ${bodyStr.slice(0, 500)}`);
    }
    return res.data;
  }

  /**
   * POST to an absolute URL (for rupload, graphql_www, etc.)
   * Bypasses the axios instance baseURL but still adds all auth headers.
   */
  async postAbsolute<T = unknown>(url: string, data: unknown, cfg?: AxiosRequestConfig): Promise<T> {
    const res = await axios.post<T>(url, data, {
      timeout: 120_000,
      ...cfg,
      headers: {
        ...DEFAULT_HEADERS,
        "User-Agent":              this._ua(),
        "X-IG-Device-ID":         this.deviceId,
        "X-IG-Family-Device-ID":  this.familyDeviceId,
        "Cookie":                  this._cookieHeader(),
        ...(this._csrfToken ? { "X-CSRFToken": this._csrfToken }      : {}),
        ...(this._authToken ? { "Authorization": this._authToken }    : {}),
        ...(cfg?.headers ?? {}),
      },
    });
    return res.data;
  }

  // ── Interceptors ─────────────────────────────────────────────────────────

  private _setupInterceptors(): void {
    this.http.interceptors.request.use((cfg) => {
      cfg.headers = cfg.headers ?? {};
      Object.assign(cfg.headers, DEFAULT_HEADERS, {
        "User-Agent":             this._ua(),
        "X-IG-Device-ID":        this.deviceId,
        "X-IG-Family-Device-ID": this.familyDeviceId,
        "Cookie":                 this._cookieHeader(),
      });
      if (this._csrfToken) cfg.headers["X-CSRFToken"]   = this._csrfToken;
      if (this._authToken) cfg.headers["Authorization"] = this._authToken;
      return cfg;
    });

    const saveIgHeaders = (headers: Record<string, string | string[] | undefined>) => {
      for (const [key, val] of Object.entries(headers)) {
        if (!val) continue;
        const v  = Array.isArray(val) ? val[0] : val;
        const lk = key.toLowerCase();
        if (lk === "ig-set-authorization") {
          this._authToken = v;
        } else if (lk === "ig-set-x-mid") {
          this._cookies["mid"] = v;
        } else if (lk.startsWith("ig-set-ig-u-")) {
          this._cookies[lk.replace("ig-set-", "")] = v;
        } else if (lk === "set-cookie") {
          for (const raw of Array.isArray(val) ? val : [val]) {
            const [pair] = String(raw).split(";");
            const eq = pair.indexOf("=");
            if (eq !== -1) {
              const k  = pair.slice(0, eq).trim();
              const cv = pair.slice(eq + 1).trim();
              this._cookies[k] = cv;
              if (k === "csrftoken") this._csrfToken = cv;
            }
          }
        }
      }
    };

    this.http.interceptors.response.use(
      (res) => { saveIgHeaders(res.headers as Record<string, string | string[] | undefined>); return res; },
      (err) => {
        if (err?.response?.headers) saveIgHeaders(err.response.headers as Record<string, string | string[] | undefined>);
        return Promise.reject(err);
      },
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _ua(): string {
    return `Instagram ${APP_VERSION} (iPhone14,3; iOS 16_6; en_US; en-US; scale=3.00; 1284x2778; ${APP_VERSION_CODE}) AppleWebKit`;
  }

  private _cookieHeader(): string {
    return Object.entries(this._cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  }
}
