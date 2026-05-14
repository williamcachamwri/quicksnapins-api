# InstaKit

> A TypeScript client for Instagram's **QuickSnap (Instants)** private API — reverse-engineered from the decrypted `com.burbn.moonshot` v430.0.1 IPA binary.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green?logo=node.js)](https://nodejs.org/)

---

## Table of Contents

- [Background](#background)
- [Architecture Overview](#architecture-overview)
- [Reverse Engineering Methodology](#reverse-engineering-methodology)
- [API Reference](#api-reference)
  - [Authentication](#authentication)
  - [Two-Factor Authentication](#two-factor-authentication)
  - [Photo Upload (Resumable Upload)](#photo-upload-resumable-upload)
  - [Configure to QuickSnap](#configure-to-quicksnap)
  - [Audience Types](#audience-types)
  - [GraphQL — Get Friends' QuickSnaps](#graphql--get-friends-quicksnaps)
  - [GraphQL — Get My QuickSnap History](#graphql--get-my-quicksnap-history)
- [HTTP Client & Session Model](#http-client--session-model)
- [Image Preprocessing](#image-preprocessing)
- [Telegram Bot](#telegram-bot)
- [Environment Variables](#environment-variables)
- [Running Locally](#running-locally)
- [Disclaimer](#disclaimer)

---

## Background

**QuickSnap** (internally called *Instants*, app bundle `com.burbn.moonshot`) is Instagram's ephemeral photo-sharing feature — akin to a lightweight Polaroid camera that publishes a full-bleed photo directly to your Close Friends or followers, disappearing after 24 hours.

Instagram does not publish a public API for this feature. All endpoints, field names, GraphQL operation names, and `client_doc_id` values in this library were obtained by:

1. Decrypting the App Store IPA with [TTJB's decryption tool](https://github.com/TTJB)
2. Running `strings` against the Mach-O binary to extract plaintext constants
3. Cross-referencing extracted strings against live network traffic

The app is built on top of the same private Instagram Mobile API used by the main Instagram iOS app, sharing the same `X-IG-App-ID`, device fingerprinting headers, and Bloks authentication stack.

---

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│                  InstaKit                    │
│                                             │
│  ┌────────────┐   ┌────────────────────┐   │
│  │  auth.ts   │   │   quicksnap.ts     │   │
│  │            │   │                    │   │
│  │  login()   │   │  fitForQuickSnap() │   │
│  │  verify2FA │   │  uploadPhoto()     │   │
│  │  logout()  │   │  configureQuick.. │   │
│  │  totp()    │   │  getLatestSnaps() │   │
│  └─────┬──────┘   └────────┬───────────┘   │
│        │                   │               │
│        └─────────┬─────────┘               │
│                  │                         │
│           ┌──────▼──────┐                  │
│           │   http.ts   │                  │
│           │  HttpClient │                  │
│           │  (axios)    │                  │
│           └─────────────┘                  │
└─────────────────────────────────────────────┘
         │
         ▼
  i.instagram.com  /  graphql_www
```

---

## Reverse Engineering Methodology

### Binary String Extraction

The Moonshot IPA binary was decrypted and analyzed using:

```bash
# Extract all human-readable strings from the Mach-O binary
strings Payload/Moonshot.app/Moonshot | grep -E "configure_to_quick_snap|audience|besties|quick_snap"
```

Key findings extracted directly from the binary:

| String | Source | Purpose |
|--------|--------|---------|
| `media/configure_to_quick_snap/` | Binary literal | REST configure endpoint path |
| `IGQuickSnapGetQuickSnapsQuery` | ObjC symbol / string | GraphQL operation name |
| `IGQuickSnapGetHistoryPaginatedQuery` | ObjC symbol / string | GraphQL operation name |
| `quick_snap_paginated_history(after:$after,first:$first)` | GraphQL field literal | Pagination field path |
| `besties` | Enum string literal | Close Friends audience value |
| `following` | Enum string literal | All-followers audience value |
| `_uuid`, `archive_only`, `allow_multi_configures` | Form field literals | Configure payload keys |
| `audience_list_id` | Field literal | Custom audience list field |

### GraphQL `client_doc_id` Extraction

The persistent query IDs were scraped from the `igios-instagram-schema_client-persist.json` bundle embedded in the IPA:

| Operation | `client_doc_id` |
|-----------|----------------|
| `IGQuickSnapGetQuickSnapsQuery` | `13779138909820036502671334714` |
| `IGQuickSnapGetHistoryPaginatedQuery` | `202528380815293408658525056594` |
| `IGQuickSnapUpdateSeenStateMutation` | `9154705964558259852151766741` |

---

## API Reference

### Base URL

```
https://i.instagram.com/api/v1
```

All requests require the following standard Instagram mobile headers:

```
X-IG-App-ID:           124024574287414
X-IG-Capabilities:     3brTvwE=
X-IG-Connection-Type:  WIFI
X-FB-HTTP-Engine:      Liger
X-FB-Client-IP:        True
X-FB-Server-Cluster:   True
Accept-Language:       en-US
User-Agent:            Instagram 430.0.1 (iPhone14,3; iOS 16_6; en_US; en-US; scale=3.00; 1284x2778; 969327462) AppleWebKit
```

Post-login, attach:

```
Authorization:  Bearer <ig-set-authorization token>
X-CSRFToken:    <csrftoken cookie>
Cookie:         <mid=...; ig-u-ds-user-id=...; sessionid=...; csrftoken=...>
X-IG-Device-ID:         <uuid4>
X-IG-Family-Device-ID:  <uuid4>
```

---

### Authentication

**Endpoint:** `POST /api/v1/accounts/login/`  
**Content-Type:** `application/x-www-form-urlencoded`

Before the login request, fetch CSRF token:

```http
GET /api/v1/si/fetch_headers/?challenge_type=signup&guid=<uuid4>
```

This seeds the `csrftoken` cookie via `Set-Cookie`.

**Login payload:**

```
username=<username>
enc_password=#PWD_INSTAGRAM:0:<unix_ts>:<plaintext_password>
device_id=<X-IG-Device-ID>
phone_id=<uuid4>
guid=<uuid4>
adid=<uuid4>
login_attempt_count=0
jazoest=<jazoest(phone_id)>
```

> **`jazoest` calculation:** Sum the char codes of all characters in `phone_id`, then prepend `"2"`. Example: `phone_id = "abc"` → `97+98+99=294` → `jazoest = "2294"`.

> **`enc_password` format:** The password is sent in cleartext but wrapped in a versioned envelope: `#PWD_INSTAGRAM:0:<timestamp>:<password>`. Version `0` means no encryption — the timestamp is included for replay protection on Instagram's side.

**Success response (200 OK):**

```json
{
  "logged_in_user": {
    "pk": "53743547524",
    "username": "youruser",
    ...
  },
  "status": "ok"
}
```

The response headers will contain:
- `ig-set-authorization: Bearer IGT:2:<token>` → store as bearer token
- `ig-set-x-mid: <value>` → store as `mid` cookie
- `ig-set-ig-u-ds-user-id: <uid>` → store as `ig-u-ds-user-id` cookie

**2FA response (400):**

```json
{
  "two_factor_required": true,
  "two_factor_info": {
    "username": "youruser",
    "two_factor_identifier": "<identifier>",
    "device_id": "<device_id>",
    "sms_two_factor_on": true,
    "totp_two_factor_on": false,
    "whatsapp_two_factor_on": false,
    "obfuscated_phone_number_2": "+84 **** **34"
  }
}
```

---

### Two-Factor Authentication

**Endpoint:** `POST /api/v1/accounts/two_factor_login/`  
**Content-Type:** `application/x-www-form-urlencoded`

```
username=<username>
verification_code=<6-digit code>
two_factor_identifier=<from 2FA response>
trust_this_device=0
verification_method=<1|3|6>
device_id=<device_id>
```

| `verification_method` | Meaning |
|----------------------|---------|
| `1` | SMS |
| `3` | TOTP (Google Authenticator) |
| `6` | WhatsApp |

**TOTP generation** is implemented natively (no dependency) using RFC 6238:
- Algorithm: HMAC-SHA1
- Step: 30 seconds
- Digits: 6
- Secret encoding: Base32

```typescript
const code = totp(base32Secret);      // current window
const prev = totp(base32Secret, -1);  // previous window (clock skew tolerance)
```

---

### Photo Upload (Resumable Upload)

Instagram uses a proprietary resumable upload protocol at a separate subdomain.

**Endpoint:** `POST https://i.instagram.com/rupload_igphoto/<upload_name>`

Where `<upload_name>` is constructed as:

```
<upload_id>_0_<random_9_digit_number>
```

And `upload_id = String(Date.now())` — a Unix timestamp in milliseconds.

**Headers:**

```
Content-Type:                   image/jpeg   (or image/png)
X-Entity-Length:                <byte_length_of_photo_buffer>
X-Entity-Name:                  <upload_name>
X-Instagram-Rupload-Params:     <JSON — see below>
Offset:                         0
```

**`X-Instagram-Rupload-Params` JSON:**

```json
{
  "upload_id": "1778775241011",
  "media_type": 1,
  "upload_media_width": 1080,
  "upload_media_height": 565,
  "image_compression": "{\"lib_name\":\"moz\",\"lib_version\":\"3.1.m\",\"quality\":\"80\"}"
}
```

> `media_type: 1` = Photo. The `image_compression` field should only be included when both dimensions are known.

**Success response:**

```json
{
  "upload_id": "1778775241011",
  "status": "ok"
}
```

The body is sent as raw bytes (not multipart). The `upload_id` from the response must match what was sent in the headers — Instagram validates this.

---

### Configure to QuickSnap

This is the publish step that transforms an uploaded photo into a live QuickSnap post.

**Endpoint:** `POST /api/v1/media/configure_to_quick_snap/`  
**Content-Type:** `application/x-www-form-urlencoded`

**Full payload (all fields scraped from binary):**

```
_uuid=<uuid4 — same across upload + configure for this post>
upload_id=<upload_id from upload step>
caption=<string, empty for no caption>
audience=<"besties"|"following">
recipient_users=[]
thread_ids=[]
client_timestamp=<unix_seconds>
device_timestamp=<unix_seconds>
timezone_offset=<seconds_east_of_UTC>
creation_surface=camera
camera_position=back
archive_only=0
allow_multi_configures=0
upload_media_width=<int>
upload_media_height=<int>
```

> **`_uuid`:** Must be a fresh UUID4, consistent between the upload and configure calls for the same post. Do not reuse across posts.

> **`timezone_offset`:** `new Date().getTimezoneOffset() * -60` — converts JS's west-negative minutes to east-positive seconds.

> **`audience`:** Enum strings confirmed from binary. `"besties"` maps to the user's Close Friends list. `"following"` posts to all followers. No `audience_list_id` is required for either built-in type.

**Success response:**

```json
{
  "media": {
    "id": "3896971727343812018_53743547524",
    "strong_id__": "3896971727343812018_53743547524",
    "subtype_name_for_REST__": "XDTQuickSnapMedia",
    "taken_at": 1778775252,
    "expiring_at": 1778861652,
    "media_type": 1,
    "original_width": 1080,
    "original_height": 565,
    "caption": {
      "text": "your caption here"
    },
    "image_versions2": {
      "candidates": [
        {
          "width": 1080,
          "height": 565,
          "url": "https://instagram.fsgn5-15.fna.fbcdn.net/..."
        }
      ]
    }
  },
  "status": "ok"
}
```

> **`integrity_review_decision`:** Will be `"pending"` immediately after posting — Instagram's ML moderation pipeline is asynchronous. This is normal and does not affect visibility.

---

### Audience Types

| Value | Meaning | Notes |
|-------|---------|-------|
| `"besties"` | Close Friends list | Only users on your Close Friends list can see |
| `"following"` | All followers | Visible to all accounts that follow you |

These string literals were extracted directly from the Moonshot binary Mach-O as Objective-C string constants — they are not derived from any public documentation.

---

### GraphQL — Get Friends' QuickSnaps

Fetches all currently active QuickSnaps from accounts you follow.

**Endpoint:** `POST https://i.instagram.com/graphql_www`  
**Content-Type:** `application/x-www-form-urlencoded`

**Body:**

```
fb_api_req_friendly_name=IGQuickSnapGetQuickSnapsQuery
client_doc_id=13779138909820036502671334714
variables={"request":{}}
server_timestamps=true
```

**Response path:**

```
data.xdt_get_quick_snaps.items_ordered_by_time[]
```

Each item is an `XDTMediaDict` with the same structure as a configure response media object.

---

### GraphQL — Get My QuickSnap History

Paginated history of your own QuickSnap posts.

**Endpoint:** `POST https://i.instagram.com/graphql_www`

**Body:**

```
fb_api_req_friendly_name=IGQuickSnapGetHistoryPaginatedQuery
client_doc_id=202528380815293408658525056594
variables={"first":12,"after":"<cursor>"}
server_timestamps=true
```

> The `after` key is omitted on the first request. Pass `end_cursor` from `page_info` for subsequent pages.

**GraphQL field path** (extracted from binary):

```
quick_snap_paginated_history(after:$after, first:$first)
```

**Response path:**

```
data.viewer.quick_snap_paginated_history.edges[].node   → media items
data.viewer.quick_snap_paginated_history.page_info      → { has_next_page, end_cursor }
```

---

## HTTP Client & Session Model

The `HttpClient` class wraps `axios` with:

- **Automatic header injection** on every request (device fingerprint, cookies, auth token)
- **Response cookie harvesting** via response interceptors:
  - `ig-set-authorization` → Bearer token
  - `ig-set-x-mid` → `mid` cookie
  - `ig-set-ig-u-*` → user-scoped cookies
  - `Set-Cookie` → standard cookie jar
- **`validateStatus: () => true`** — all HTTP status codes pass through to the caller. Non-2xx responses are surfaced as `Error` objects with the full Instagram response body included, enabling precise error diagnosis.

**Session object** (serializable, stored as JSON):

```typescript
interface Session {
  userId:         string;   // Instagram user PK
  username:       string;
  authToken:      string;   // "Bearer IGT:2:..." or sessionid cookie
  csrfToken:      string;
  deviceId:       string;   // X-IG-Device-ID (UUID4, stable per device)
  familyDeviceId: string;   // X-IG-Family-Device-ID (UUID4)
  phoneId:        string;   // UUID4, used in login payload
  mid:            string;   // Machine identifier cookie
  cookies:        Record<string, string>;
}
```

Sessions are persisted as JSON files and reloaded on startup, eliminating the need to re-authenticate on every bot restart.

---

## Image Preprocessing

Instagram's QuickSnap endpoint enforces strict **aspect ratio and dimension constraints** that are not publicly documented. These were determined empirically:

| Constraint | Limit |
|-----------|-------|
| Max landscape ratio | **1.91 : 1** (≈ 16:9) |
| Max portrait ratio | **0.5625 : 1** (9:16) |
| Max long edge | **1080 px** |

Images that violate these constraints cause a server-side `HTTP 500: "Something went wrong with configure"` — a generic error from Instagram's media ingestion pipeline that gives no further detail.

**`fitForQuickSnap(buf, mime)`** handles this automatically using `sharp`:

1. **Aspect ratio enforcement** — if the ratio exceeds the landscape cap (e.g., iPhone ultrawide screenshots at 2.17:1), the image is **center-cropped** to 1.91:1. If too tall, center-cropped to 9:16.
2. **Downscaling** — if the long edge exceeds 1080 px, the image is resized proportionally.
3. **Format normalization** — output is always JPEG (quality 90), matching the Moonshot app's behaviour.

Example: an iPhone 14 Pro screenshot at **2532×1170** (ratio 2.17) is automatically cropped and resized to **1080×565** (ratio 1.91) before upload.

---

## Telegram Bot

`bot.ts` provides a production-ready Telegram bot interface for the InstaKit library.

### Commands

| Command | Description |
|---------|-------------|
| `/start` | Show help |
| `/login <user> <pass> [totp_secret]` | Authenticate with Instagram. If `totp_secret` (base32) is provided, 2FA is resolved automatically |
| `/upload` | Begin the photo upload flow |
| `/history` | Fetch your full paginated QuickSnap history |
| `/feed` | Show active QuickSnaps from friends |
| `/logout` | Invalidate session and delete stored credentials |

### Upload Flow State Machine

```
[/upload or photo received]
         │
         ▼
   photo downloaded
         │
         ▼
  "Add caption?" ──── No ──────────────┐
         │                             │
        Yes                            │
         │                             │
         ▼                             ▼
  user types caption          "Choose audience"
         │                             │
         ▼                             │
  "Choose audience" ◄──────────────────┘
         │
    ┌────┴────┐
    │         │
 besties  following
    │         │
    └────┬────┘
         │
         ▼
   fitForQuickSnap()   ← image resize/crop
         │
         ▼
   uploadPhoto()       ← rupload_igphoto
         │
         ▼
   configureQuickSnap() ← configure_to_quick_snap
         │
         ▼
   ✅ success message with caption echoed back
```

### Session Persistence

Sessions are stored in `./sessions/session_<telegram_user_id>_<ig_username>.json`. On any authenticated action, the bot attempts to restore a session from disk before prompting for login.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | ✅ | Telegram Bot API token from @BotFather |
| `IG_SESSION_DIR` | ❌ | Directory for session JSON files (default: `./sessions`) |
| `IG_DEBUG` | ❌ | Set to `1` to enable verbose request/response logging to stderr |

### `IG_DEBUG` output

When enabled, the following is logged to stderr:

```
[FIT] 2532x1170 (ratio 2.16) → 1080x565 (jpeg)
[SEND] audience=besties caption="..." dims=1080x565 size=192739B
[UPLOAD RESPONSE] {"upload_id":"...","status":"ok"}
[CONFIGURE PAYLOAD] {"_uuid":"...","upload_id":"...","caption":"..."}
[CONFIGURE RESPONSE] {"media":{...}}    ← first 2000 chars
[PARSED CAPTION] "your caption"
[BOT] result.caption="..." savedCaption="..."
[GQL RAW] IGQuickSnapGetQuickSnapsQuery {...}
```

---

## Running Locally

### Prerequisites

- Node.js 18+
- npm

### Install

```bash
npm install
```

### Run the bot

```bash
BOT_TOKEN=<your_token> npx ts-node bot.ts
```

### Run with debug logging

```bash
BOT_TOKEN=<your_token> IG_DEBUG=1 npx ts-node bot.ts
```

### Run CLI test (no bot)

```bash
# Test login + history + optional send
IG_USER=youruser IG_PASS=yourpass npx ts-node test.ts

# With photo upload
IG_USER=youruser IG_PASS=yourpass \
  IG_PHOTO=./photo.jpg \
  IG_CAPTION="test caption" \
  IG_AUDIENCE=besties \
  npx ts-node test.ts

# With TOTP auto-2FA
IG_USER=youruser IG_PASS=yourpass IG_TOTP_SECRET=BASE32SECRET npx ts-node test.ts
```

---

## Project Structure

```
instakit/
├── src/
│   ├── auth.ts          # Login, 2FA, logout, TOTP (RFC 6238)
│   ├── client.ts        # InstaKit facade class + interactiveLogin()
│   ├── constants.ts     # Endpoints, app version, GraphQL doc IDs
│   ├── http.ts          # HttpClient (axios wrapper, cookie harvesting)
│   ├── quicksnap.ts     # fitForQuickSnap, upload, configure, GQL
│   ├── types.ts         # TypeScript interfaces
│   └── index.ts         # Public re-exports
├── bot.ts               # Telegram bot (grammY)
├── test.ts              # CLI smoke-test script
└── sessions/            # Persisted session JSON files (gitignored)
```

---

## Disclaimer

This library interfaces with Instagram's **private, undocumented mobile API**. It was created purely for educational and research purposes through binary analysis.

- **This is not affiliated with, endorsed by, or supported by Meta Platforms, Inc.**
- Use of this library may violate [Instagram's Terms of Use](https://help.instagram.com/581066165581870).
- Private API endpoints can change at any time without notice, potentially breaking this library.
- The author assumes no responsibility for account suspension or any other consequences arising from use of this software.

Use at your own risk.
