// ── Session ─────────────────────────────────────────────────────────────────

export interface Session {
  userId:         string;
  username:       string;
  /** Bearer token (ig-set-authorization) OR sessionid cookie */
  authToken:      string;
  csrfToken:      string;
  deviceId:       string;        // X-IG-Device-ID (uuid4)
  familyDeviceId: string;        // X-IG-Family-Device-ID (uuid4)
  phoneId:        string;        // uuid4 used in login payload
  mid:            string;        // mid cookie
  cookies:        Record<string, string>;
}

// ── Login ────────────────────────────────────────────────────────────────────

export interface LoginOptions {
  username: string;
  password: string;
}

export interface TwoFactorInfo {
  username:            string;
  twoFactorIdentifier: string;
  deviceId:            string;
  /** 1=SMS, 3=TOTP, 6=WhatsApp */
  availableMethods:    number[];
  obfuscatedPhone?:    string;
}

// ── QuickSnap ────────────────────────────────────────────────────────────────

/** "besties" = Close Friends list. "following" = all followers */
export type QuickSnapAudience = "besties" | "following";

export interface SendQuickSnapOptions {
  /** Raw JPEG or PNG bytes */
  photo:     Buffer;
  mimeType?: "image/jpeg" | "image/png";
  caption?:  string;
  /** Default: "besties" */
  audience?: QuickSnapAudience;
}

export interface QuickSnapMedia {
  id:              string;
  takenAt:         Date;
  caption?:        string;
  url?:            string;   // best available image URL
  width?:          number;
  height?:         number;
  authorId:        string;
  authorUsername:  string;
}

export interface QuickSnapHistoryPage {
  items:       QuickSnapMedia[];
  /** Pass to next call for pagination */
  nextCursor?: string;
  hasMore:     boolean;
}
