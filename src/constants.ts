/**
 * Constants scraped from com.burbn.moonshot (Instants) v430.0.1 IPA
 * App Store ID: 6756442328
 * Bundle: com.burbn.moonshot
 * Build: 969327462
 */

export const BASE_URL     = "https://i.instagram.com";
export const GRAPHQL_URL  = "https://i.instagram.com/graphql_www";

// X-IG-App-ID used by Moonshot binary (same as Instagram iOS standard)
export const APP_ID       = "124024574287414";

// App version string (from Info.plist CFBundleShortVersionString)
export const APP_VERSION      = "430.0.1";
export const APP_VERSION_CODE = "969327462";

// X-IG-Capabilities (standard iOS IG value)
export const IG_CAPABILITIES  = "3brTvwE=";

// ── Endpoints (from binary strings, relative to /api/v1) ─────────────────
export const ENDPOINTS = {
  // Auth (Bloks-based login, standard IG mobile)
  LOGIN:    "/accounts/login/",
  LOGOUT:   "/accounts/logout/",

  // Photo upload (host-relative: BASE_URL + path + "/" + uploadName)
  // Scraped: /rupload_igphoto/%@
  UPLOAD_PHOTO: "/rupload_igphoto",

  // QuickSnap configure (from binary: media/configure_to_quick_snap/)
  CONFIGURE_QUICK_SNAP: "/media/configure_to_quick_snap/",

  // Instants inbox / tray (from binary: /feed/reels_tray/)
  REELS_TRAY: "/feed/reels_tray/",

  // Fetch media for specific reel/instant items
  REELS_MEDIA: "/feed/reels_media/",

  // Single media info
  MEDIA_INFO: "/media/{id}/info/",
} as const;

// GraphQL operation names for QuickSnap (scraped from binary)
export const GQL = {
  // Fetch current available quicksnaps from friends
  // fb_api_req_friendly_name: IGQuickSnapGetQuickSnapsQuery
  GET_QUICK_SNAPS: "IGQuickSnapGetQuickSnapsQuery",

  // Fetch my own quicksnap history (paginated)
  // fb_api_req_friendly_name: IGQuickSnapGetHistoryPaginatedQuery
  GET_QUICK_SNAP_HISTORY: "IGQuickSnapGetHistoryPaginatedQuery",

  // Mark quicksnap as seen
  MARK_SEEN: "IGQuickSnapUpdateSeenStateMutation",
} as const;

// GraphQL client_doc_ids (from igios-instagram-schema_client-persist.json in v430.0.1 IPA)
export const GQL_DOC_ID = {
  // IGQuickSnapGetQuickSnapsQuery
  GET_QUICK_SNAPS: "13779138909820036502671334714",

  // IGQuickSnapGetHistoryPaginatedQuery (supports after/first cursors)
  GET_QUICK_SNAP_HISTORY: "202528380815293408658525056594",

  // IGQuickSnapUpdateSeenStateMutation
  MARK_SEEN: "9154705964558259852151766741",
} as const;
