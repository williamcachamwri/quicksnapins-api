/**
 * QuickSnap (Instants) API module.
 *
 * Endpoints scraped from com.burbn.moonshot (Instants) v430.0.1 IPA binary:
 *
 * UPLOAD:
 *   PUT  https://i.instagram.com/rupload_igphoto/<upload_name>
 *   Headers:
 *     X-Instagram-Rupload-Params: {
 *       upload_id, media_type: 1,
 *       upload_media_width, upload_media_height,          ← from binary
 *       image_compression: '{"lib_name":"moz","lib_version":"3.1.m","quality":"80"}'
 *     }
 *     X-Entity-Length: <size>
 *     X-Entity-Name: <upload_name>
 *     Offset: 0
 *     Content-Type: <mimeType>
 *
 * CONFIGURE:
 *   POST /api/v1/media/configure_to_quick_snap/           ← from binary
 *   Fields (scraped from binary strings):
 *     _uuid, upload_id, caption, audience, recipient_users, thread_ids,
 *     client_timestamp, device_timestamp, timezone_offset,
 *     creation_surface, camera_position,
 *     archive_only, allow_multi_configures
 *   audience values (from binary enum):
 *     "besties"   → Close Friends (💚)
 *     "following" → All followers
 *
 * GET LATEST (from friends):
 *   POST https://i.instagram.com/graphql_www
 *   operationName: xdt_get_quick_snaps               ← from binary
 *   variables: { request: {} }
 *
 * GET MY HISTORY:
 *   POST https://i.instagram.com/graphql_www
 *   operationName: xdt_get_quick_snap_history         ← from binary
 *   variables: { after?: cursor, first: 12 }          ← quick_snap_paginated_history(after:$after,first:$first)
 */

import { v4 as uuidv4 } from "uuid";
import * as qs from "querystring";
import sharp from "sharp";
import { BASE_URL, ENDPOINTS, GRAPHQL_URL, GQL, GQL_DOC_ID } from "./constants";
import type { HttpClient } from "./http";
import type {
  QuickSnapAudience,
  QuickSnapHistoryPage,
  QuickSnapMedia,
  SendQuickSnapOptions,
} from "./types";

/** Extract full response body from Axios errors for better debugging */
function extractAxiosError(e: unknown): Error {
  const err = e as any;
  if (err?.response) {
    const status = err.response.status;
    const body   = err.response.data;
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    return new Error(`HTTP ${status}: ${bodyStr.slice(0, 500)}`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

// ── Image pre-processing ─────────────────────────────────────────────────────

/**
 * Instagram QuickSnap (Instants) aspect ratio limits (scraped from binary):
 *   Max landscape ratio: 1.91:1  (width/height <= 1.91)
 *   Max portrait  ratio: 0.5625  (9:16)
 *   Max long edge: 1080 px
 *
 * If the image exceeds these, center-crop to the nearest valid edge.
 */
export async function fitForQuickSnap(
  buf:  Buffer,
  mime: "image/jpeg" | "image/png",
): Promise<{ buffer: Buffer; mime: "image/jpeg"; width: number; height: number }> {
  const MAX_RATIO  = 1.91;   // landscape cap
  const MIN_RATIO  = 0.5625; // portrait cap (9:16)
  const MAX_EDGE   = 1080;   // max long edge

  let img = sharp(buf);
  const meta = await img.metadata();
  let w = meta.width  ?? 1080;
  let h = meta.height ?? 1080;

  const ratio = w / h;

  // Step 1 – fix aspect ratio by center-crop
  if (ratio > MAX_RATIO) {
    // Too wide → crop width
    const newW = Math.round(h * MAX_RATIO);
    const left = Math.round((w - newW) / 2);
    img = img.extract({ left, top: 0, width: newW, height: h });
    w = newW;
  } else if (ratio < MIN_RATIO) {
    // Too tall → crop height
    const newH = Math.round(w / MIN_RATIO);
    const top  = Math.round((h - newH) / 2);
    img = img.extract({ left: 0, top, width: w, height: newH });
    h = newH;
  }

  // Step 2 – scale down if long edge > 1080 px
  if (Math.max(w, h) > MAX_EDGE) {
    if (w >= h) {
      h = Math.round((h * MAX_EDGE) / w);
      w = MAX_EDGE;
    } else {
      w = Math.round((w * MAX_EDGE) / h);
      h = MAX_EDGE;
    }
    img = img.resize(w, h, { fit: "fill" });
  }

  // Always output as JPEG for QuickSnap (matches app behaviour)
  const outBuf = await img.jpeg({ quality: 90 }).toBuffer();

  if (process.env.IG_DEBUG) {
    const origRatio = ((meta.width ?? 0) / (meta.height ?? 1)).toFixed(2);
    console.error(`[FIT] ${meta.width}x${meta.height} (ratio ${origRatio}) → ${w}x${h} (jpeg)`);
  }

  return { buffer: outBuf, mime: "image/jpeg", width: w, height: h };
}

// ── Upload photo ──────────────────────────────────────────────────────────────

interface UploadResult {
  uploadId: string;
}

async function uploadPhoto(
  http:    HttpClient,
  photo:   Buffer,
  mime:    "image/jpeg" | "image/png",
  width?:  number,
  height?: number,
): Promise<UploadResult> {
  const uploadId   = String(Date.now());
  const uploadName = `${uploadId}_0_${Math.floor(Math.random() * 9_000_000_000 + 1_000_000_000)}`;
  const url        = `${BASE_URL}${ENDPOINTS.UPLOAD_PHOTO}/${uploadName}`;

  const ruploadParams: Record<string, unknown> = {
    upload_id:  uploadId,
    media_type: 1,
  };
  if (width  != null) ruploadParams["upload_media_width"]  = width;
  if (height != null) ruploadParams["upload_media_height"] = height;
  if (width != null && height != null) {
    ruploadParams["image_compression"] = JSON.stringify({
      lib_name: "moz", lib_version: "3.1.m", quality: "80",
    });
  }

  let uploadRes: unknown;
  try {
    uploadRes = await http.postAbsolute(url, photo, {
      headers: {
        "Content-Type":                  mime,
        "X-Entity-Length":               String(photo.length),
        "X-Entity-Name":                 uploadName,
        "X-Instagram-Rupload-Params":    JSON.stringify(ruploadParams),
        "Offset":                        "0",
      },
    });
  } catch (e) {
    throw extractAxiosError(e);
  }

  if (process.env.IG_DEBUG) {
    console.error("[UPLOAD RESPONSE]", JSON.stringify(uploadRes).slice(0, 300));
  }

  return { uploadId };
}

// ── Configure to QuickSnap ────────────────────────────────────────────────────

async function configureQuickSnap(
  http:     HttpClient,
  uploadId: string,
  caption:  string,
  audience: QuickSnapAudience,
  uuid:     string,
  width?:   number,
  height?:  number,
): Promise<QuickSnapMedia> {
  const ts = String(Math.floor(Date.now() / 1000));
  const tzOffset = String(new Date().getTimezoneOffset() * -60);

  const payload: Record<string, unknown> = {
    // ── Fields scraped from Moonshot v430.0.1 binary ──
    _uuid:                uuid,
    upload_id:            uploadId,
    caption:              caption,          // empty string = no caption
    audience:             audience,         // "besties" | "following"
    recipient_users:      "[]",
    thread_ids:           "[]",
    client_timestamp:     ts,
    device_timestamp:     ts,
    timezone_offset:      tzOffset,
    creation_surface:     "camera",
    camera_position:      "back",
    archive_only:         "0",
    allow_multi_configures: "0",
  };
  if (width  != null) payload["upload_media_width"]  = String(width);
  if (height != null) payload["upload_media_height"] = String(height);

  if (process.env.IG_DEBUG) {
    console.error("[CONFIGURE PAYLOAD]", JSON.stringify(payload));
  }

  let data: Record<string, unknown>;
  try {
    data = await http.post<Record<string, unknown>>(
      ENDPOINTS.CONFIGURE_QUICK_SNAP,
      payload,
    );
  } catch (e) {
    throw extractAxiosError(e);
  }

  if (process.env.IG_DEBUG) {
    console.error("[CONFIGURE RESPONSE]", JSON.stringify(data).slice(0, 2000));
  }

  if (data.status !== "ok") {
    throw new Error(`configure_to_quick_snap failed: ${JSON.stringify(data)}`);
  }

  // media object returned by configure endpoint
  const mediaObj = (data.media ?? data) as Record<string, unknown>;
  const parsed   = parseMedia(mediaObj);

  if (process.env.IG_DEBUG) {
    console.error("[PARSED CAPTION]", JSON.stringify(parsed.caption));
  }

  return parsed;}

// ── Public: Send QuickSnap ────────────────────────────────────────────────────

/** Read PNG/JPEG image dimensions from raw buffer (no deps) */
function readDimensions(buf: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === "image/png" && buf.length >= 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === "image/jpeg") {
      let i = 2;
      while (i < buf.length - 8) {
        if (buf[i] !== 0xff) break;
        const marker = buf[i + 1];
        const len    = buf.readUInt16BE(i + 2);
        if ((marker >= 0xc0 && marker <= 0xc3) ||
            (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) ||
            (marker >= 0xcd && marker <= 0xcf)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch { /* ignore */ }
  return null;
}

export async function sendQuickSnap(
  http: HttpClient,
  opts: SendQuickSnapOptions,
): Promise<QuickSnapMedia> {
  const rawMime = opts.mimeType ?? "image/jpeg";
  const audience = opts.audience ?? "besties";
  const caption  = opts.caption ?? "";
  const uuid     = uuidv4();

  // Auto-resize/crop image to fit Instagram's QuickSnap limits:
  //   max ratio 1.91:1 (landscape) / 0.5625:1 (portrait), max 1080px
  const { buffer: photo, mime, width, height } = await fitForQuickSnap(opts.photo, rawMime);

  if (process.env.IG_DEBUG) {
    console.error(`[SEND] audience=${audience} caption="${caption}" dims=${width}x${height} size=${photo.length}B`);
  }

  const { uploadId } = await uploadPhoto(http, photo, mime, width, height);
  return configureQuickSnap(http, uploadId, caption, audience, uuid, width, height);
}

// ── Public: Get latest QuickSnaps from friends ────────────────────────────────

/**
 * POST to graphql_www using Instagram's internal format:
 * Content-Type: application/x-www-form-urlencoded
 * Body: fb_api_req_friendly_name=<op>&doc_id=<id>&variables=<json>&server_timestamps=true
 */
async function gqlPost(
  http:      HttpClient,
  operation: string,
  docId:     string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const body = qs.stringify({
    fb_api_req_friendly_name: operation,
    client_doc_id:            docId,
    variables:                JSON.stringify(variables),
    server_timestamps:        "true",
  });
  const data = await http.postAbsolute<Record<string, unknown>>(GRAPHQL_URL, body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (process.env.IG_DEBUG) console.error("[GQL RAW]", operation, JSON.stringify(data).slice(0, 800));
  return data;
}

/**
 * Fetch the current available quicksnaps from friends.
 * Uses GraphQL: xdt_get_quick_snaps (scraped from binary)
 * Endpoint: POST https://i.instagram.com/graphql_www
 */
export async function getLatestQuickSnaps(http: HttpClient): Promise<QuickSnapMedia[]> {
  const data = await gqlPost(http, GQL.GET_QUICK_SNAPS, GQL_DOC_ID.GET_QUICK_SNAPS, { request: {} });
  return extractMediaList(data);
}

// ── Public: Get my QuickSnap history ─────────────────────────────────────────

/**
 * Fetch my own quicksnap posting history (paginated).
 * Uses GraphQL: xdt_get_quick_snap_history (scraped from binary)
 * Pagination: quick_snap_paginated_history(after:$after,first:$first) (from binary)
 */
export async function getMyQuickSnapHistory(
  http:   HttpClient,
  opts?: { first?: number; after?: string },
): Promise<QuickSnapHistoryPage> {
  const variables: Record<string, unknown> = { first: opts?.first ?? 12 };
  if (opts?.after) variables["after"] = opts.after;
  const data = await gqlPost(http, GQL.GET_QUICK_SNAP_HISTORY, GQL_DOC_ID.GET_QUICK_SNAP_HISTORY, variables);
  return extractHistoryPage(data);
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

function parseMedia(m: Record<string, unknown>): QuickSnapMedia {
  const caption = m.caption as Record<string, unknown> | null | undefined;
  const user    = (m.user ?? m.owner) as Record<string, unknown> | undefined ?? {};

  // Best image URL
  const iv = m.image_versions2 as Record<string, unknown> | undefined;
  const candidates = (iv?.candidates as Array<Record<string, unknown>> | undefined) ?? [];
  const best = candidates.sort((a, b) =>
    ((b.width as number) ?? 0) - ((a.width as number) ?? 0)
  )[0];

  return {
    id:             String(m.id ?? m.pk ?? ""),
    takenAt:        new Date(Number(m.taken_at ?? 0) * 1000),
    caption:        (caption?.text as string | undefined) ?? undefined,
    url:            best?.url as string | undefined,
    width:          best?.width as number | undefined,
    height:         best?.height as number | undefined,
    authorId:       String(user.pk ?? user.id ?? ""),
    authorUsername: String(user.username ?? ""),
  };
}

function extractMediaList(data: Record<string, unknown>): QuickSnapMedia[] {
  // Actual response: { data: { xdt_get_quick_snaps: { items_ordered_by_time: [...] } } }
  const d = (data.data as Record<string, unknown> | undefined) ?? data;
  const root = d.xdt_get_quick_snaps as Record<string, unknown> | undefined;
  const items = (root?.items_ordered_by_time as unknown[]) ?? [];
  return (items as Record<string, unknown>[]).map(parseMedia);
}

function extractHistoryPage(data: Record<string, unknown>): QuickSnapHistoryPage {
  // Actual response: { data: { viewer: { quick_snap_paginated_history: { edges: [{node}], page_info: {...} } } } }
  const d     = (data.data as Record<string, unknown> | undefined) ?? data;
  const viewer = (d.viewer as Record<string, unknown> | undefined) ?? d;
  const hist  = (viewer.quick_snap_paginated_history as Record<string, unknown> | undefined) ?? viewer;

  const pageInfo = (hist.page_info as Record<string, unknown> | undefined) ?? {};
  const edges    = hist.edges as Array<{ node: Record<string, unknown> }> | undefined;
  const rawItems = edges ? edges.map((e) => e.node) :
    (hist.items as Record<string, unknown>[] | undefined) ?? [];

  return {
    items:      rawItems.map(parseMedia),
    nextCursor: pageInfo.end_cursor as string | undefined,
    hasMore:    Boolean(pageInfo.has_next_page),
  };
}
