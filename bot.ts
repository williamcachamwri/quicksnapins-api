/**
 * Telegram bot for Instagram QuickSnap (Moonshot)
 *
 * Commands:
 *   /login <username> <password> [totp_secret]  – Login to Instagram
 *   /upload                                      – Send a photo, bot will ask caption + audience
 *   /history                                     – Fetch all quicksnap history (paginated)
 *   /feed                                        – Show latest quicksnaps from friends
 *
 * Setup:
 *   BOT_TOKEN=<telegram_bot_token> npx ts-node bot.ts
 *
 * Optional: Set IG_SESSION_DIR to store sessions in a specific folder (default: ./sessions)
 */

import * as fs from "fs";
import * as path from "path";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { InstaKit, TwoFactorRequiredError, totp } from "./src/index";
import type { Session, QuickSnapAudience } from "./src/index";

// ── Config ────────────────────────────────────────────────────────────────────

const BOT_TOKEN   = process.env.BOT_TOKEN ?? "";
const SESSION_DIR = process.env.IG_SESSION_DIR ?? path.join(__dirname, "sessions");

if (!BOT_TOKEN) {
  console.error("ERROR: BOT_TOKEN env var is required.");
  process.exit(1);
}

if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

// ── Per-user state ────────────────────────────────────────────────────────────

interface UserState {
  kit:          InstaKit;
  session:      Session | null;
  // upload flow
  pendingPhoto: Buffer | null;
  pendingMime:  "image/jpeg" | "image/png";
  pendingCaption: string | undefined;
  waitingFor:   "caption_text" | "totp" | null;
  // 2FA
  twoFactorInfo: import("./src/index").TwoFactorInfo | null;
  twoFactorMethod: 1 | 3 | 6;
}

const users = new Map<number, UserState>();

function getUser(userId: number): UserState {
  if (!users.has(userId)) {
    users.set(userId, {
      kit:            new InstaKit(),
      session:        null,
      pendingPhoto:   null,
      pendingMime:    "image/jpeg" as "image/jpeg" | "image/png",
      pendingCaption: undefined,
      waitingFor:     null,
      twoFactorInfo:  null,
      twoFactorMethod: 1,
    });
  }
  return users.get(userId)!;
}

function sessionFile(userId: number, username: string): string {
  return path.join(SESSION_DIR, `session_${userId}_${username}.json`);
}

function saveSession(userId: number, session: Session): void {
  fs.writeFileSync(sessionFile(userId, session.username), JSON.stringify(session, null, 2), "utf-8");
}

function tryRestoreSession(userId: number, kit: InstaKit): Session | null {
  // Find any session file for this user
  const files = fs.readdirSync(SESSION_DIR).filter((f: string) => f.startsWith(`session_${userId}_`));
  if (!files.length) return null;
  try {
    const raw = fs.readFileSync(path.join(SESSION_DIR, files[0]), "utf-8");
    const session: Session = JSON.parse(raw);
    kit.loadSession(session);
    return session;
  } catch {
    return null;
  }
}

// ── Bot setup ─────────────────────────────────────────────────────────────────

const bot = new Bot(BOT_TOKEN);

// ── /start ────────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  await ctx.reply(
    "👻 *QuickSnap Bot*\n\n" +
    "Các lệnh:\n" +
    "• /login `username password [totp_secret]` – Đăng nhập Instagram\n" +
    "• /upload – Gửi ảnh để đăng QuickSnap\n" +
    "• /history – Xem lịch sử QuickSnap của bạn\n" +
    "• /feed – Xem QuickSnap mới nhất từ bạn bè\n" +
    "• /logout – Đăng xuất",
    { parse_mode: "Markdown" },
  );
});

// ── /login ────────────────────────────────────────────────────────────────────

bot.command("login", async (ctx) => {
  const uid  = ctx.from!.id;
  const args = ctx.match.trim().split(/\s+/);

  if (args.length < 2 || !args[0]) {
    await ctx.reply("Cú pháp: /login <username> <password> [totp_secret]");
    return;
  }

  const [username, password, totpSecret] = args;
  const state = getUser(uid);
  state.kit   = new InstaKit();

  await ctx.reply("🔐 Đang đăng nhập...");

  try {
    const session = await state.kit.login({ username, password });
    state.session = session;
    saveSession(uid, session);
    await ctx.reply(`✅ Đăng nhập thành công! Xin chào *${username}*`, { parse_mode: "Markdown" });
  } catch (e) {
    if (e instanceof TwoFactorRequiredError) {
      const tfInfo = e.twoFactorInfo;
      state.twoFactorInfo   = tfInfo;
      state.twoFactorMethod = tfInfo.availableMethods.includes(3) ? 3
                            : tfInfo.availableMethods.includes(1) ? 1
                            : 6 as 1 | 3 | 6;

      // Auto TOTP
      if (totpSecret && state.twoFactorMethod === 3) {
        try {
          const code    = totp(totpSecret);
          const session = await state.kit.verify2FA(tfInfo, code, 3);
          state.session = session;
          saveSession(uid, session);
          await ctx.reply(`✅ Đăng nhập thành công (TOTP auto)! Xin chào *${username}*`, { parse_mode: "Markdown" });
        } catch (err2) {
          await ctx.reply(`❌ 2FA thất bại: ${(err2 as Error).message}`);
        }
        return;
      }

      const methodName = state.twoFactorMethod === 1 ? "SMS" : state.twoFactorMethod === 3 ? "TOTP" : "WhatsApp";
      state.waitingFor = "totp";
      await ctx.reply(`🔑 Yêu cầu 2FA (${methodName}). Hãy nhập mã 6 số:`);
    } else {
      await ctx.reply(`❌ Đăng nhập thất bại: ${(e as Error).message}`);
    }
  }
});

// ── /logout ───────────────────────────────────────────────────────────────────

bot.command("logout", async (ctx) => {
  const uid   = ctx.from!.id;
  const state = getUser(uid);
  if (!state.session) {
    await ctx.reply("Bạn chưa đăng nhập.");
    return;
  }
  try {
    await state.kit.logout();
  } catch { /* ignore */ }
  // Remove session files
  fs.readdirSync(SESSION_DIR)
    .filter((f: string) => f.startsWith(`session_${uid}_`))
    .forEach((f: string) => fs.unlinkSync(path.join(SESSION_DIR, f)));
  state.session = null;
  await ctx.reply("✅ Đã đăng xuất.");
});

// ── /upload ───────────────────────────────────────────────────────────────────

bot.command("upload", async (ctx) => {
  const uid   = ctx.from!.id;
  const state = ensureLoggedIn(ctx, uid);
  if (!state) return;

  state.pendingPhoto   = null;
  state.pendingCaption = undefined;
  state.waitingFor     = null;
  await ctx.reply("📷 Gửi ảnh bạn muốn đăng QuickSnap.");
});

// ── /history ─────────────────────────────────────────────────────────────────

bot.command("history", async (ctx) => {
  const uid   = ctx.from!.id;
  const state = ensureLoggedIn(ctx, uid);
  if (!state) return;

  await ctx.reply("⏳ Đang tải lịch sử QuickSnap...");

  try {
    const allItems: import("./src/index").QuickSnapMedia[] = [];
    let cursor: string | undefined;
    let page = 0;

    do {
      const result = await state.kit.getMyQuickSnapHistory({ first: 20, after: cursor });
      allItems.push(...result.items);
      cursor = result.hasMore ? result.nextCursor : undefined;
      page++;
      if (page > 50) break; // safety limit
    } while (cursor);

    if (!allItems.length) {
      await ctx.reply("📭 Bạn chưa có QuickSnap nào.");
      return;
    }

    // Send summary + first 10 items
    let msg = `📚 *Lịch sử QuickSnap* (${allItems.length} ảnh)\n\n`;
    const preview = allItems.slice(0, 10);
    for (const [i, item] of preview.entries()) {
      const date = item.takenAt.toLocaleDateString("vi-VN");
      const cap  = item.caption ? ` – ${item.caption.slice(0, 50)}` : "";
      msg += `${i + 1}. ${date}${cap}\n`;
    }
    if (allItems.length > 10) msg += `\n… và ${allItems.length - 10} ảnh nữa`;

    await ctx.reply(msg, { parse_mode: "Markdown" });

    // Send thumbnails for first 5 items
    for (const item of allItems.slice(0, 5)) {
      if (!item.url) continue;
      const cap = item.caption
        ? `📅 ${item.takenAt.toLocaleDateString("vi-VN")} – ${item.caption}`
        : `📅 ${item.takenAt.toLocaleDateString("vi-VN")}`;
      try {
        await ctx.replyWithPhoto(item.url, { caption: cap });
      } catch {
        await ctx.reply(`🖼 [${cap}](${item.url})`, { parse_mode: "Markdown" });
      }
    }
  } catch (e) {
    await ctx.reply(`❌ Lỗi: ${(e as Error).message}`);
  }
});

// ── /feed ─────────────────────────────────────────────────────────────────────

bot.command("feed", async (ctx) => {
  const uid   = ctx.from!.id;
  const state = ensureLoggedIn(ctx, uid);
  if (!state) return;

  await ctx.reply("⏳ Đang tải QuickSnap mới nhất...");

  try {
    const items = await state.kit.getLatestQuickSnaps();

    if (!items.length) {
      await ctx.reply("📭 Không có QuickSnap nào từ bạn bè lúc này.");
      return;
    }

    await ctx.reply(`📸 *${items.length} QuickSnap* từ bạn bè:`, { parse_mode: "Markdown" });

    for (const item of items) {
      const user = item.authorUsername ? `@${item.authorUsername}` : `ID ${item.authorId}`;
      const cap  = item.caption ? `${user}: ${item.caption}` : user;
      if (item.url) {
        try {
          await ctx.replyWithPhoto(item.url, { caption: cap });
        } catch {
          await ctx.reply(`🖼 ${cap}\n[Xem ảnh](${item.url})`, { parse_mode: "Markdown" });
        }
      } else {
        await ctx.reply(`👻 ${cap}`);
      }
    }
  } catch (e) {
    await ctx.reply(`❌ Lỗi: ${(e as Error).message}`);
  }
});

// ── Handle photo messages ─────────────────────────────────────────────────────

bot.on("message:photo", async (ctx) => {
  const uid   = ctx.from!.id;
  const state = getUser(uid);

  if (!state.session) {
    // Try restore
    const restored = tryRestoreSession(uid, state.kit);
    if (!restored) {
      await ctx.reply("Bạn chưa đăng nhập. Dùng /login trước.");
      return;
    }
    state.session = restored;
  }

  // Download highest-res photo
  await ctx.reply("⏳ Đang tải ảnh...");
  try {
    const photo  = ctx.message.photo.at(-1)!; // largest size
    const file   = await ctx.getFile();
    const url    = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    const { default: axios } = await import("axios");
    const res = await axios.get<Buffer>(url, { responseType: "arraybuffer" });
    state.pendingPhoto = Buffer.from(res.data);
    state.pendingMime  = "image/jpeg" as "image/jpeg" | "image/png";
    state.pendingCaption = undefined;

    // Ask caption
    const kb = new InlineKeyboard()
      .text("✏️ Có, thêm caption", "caption_yes")
      .text("🚫 Không cần", "caption_no");

    await ctx.reply("Bạn có muốn thêm caption không?", { reply_markup: kb });
  } catch (e) {
    await ctx.reply(`❌ Không tải được ảnh: ${(e as Error).message}`);
  }
});

// ── Handle document (uncompressed photo sent as file) ─────────────────────────

bot.on("message:document", async (ctx) => {
  const uid  = ctx.from!.id;
  const doc  = ctx.message.document;
  if (!doc.mime_type?.startsWith("image/")) return;

  const state = getUser(uid);
  if (!state.session) {
    const restored = tryRestoreSession(uid, state.kit);
    if (!restored) { await ctx.reply("Bạn chưa đăng nhập. Dùng /login trước."); return; }
    state.session = restored;
  }

  await ctx.reply("⏳ Đang tải ảnh (file)...");
  try {
    const file = await ctx.getFile();
    const url  = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    const { default: axios } = await import("axios");
    const res = await axios.get<Buffer>(url, { responseType: "arraybuffer" });
    state.pendingPhoto = Buffer.from(res.data);
    const rawMime = doc.mime_type ?? "image/jpeg";
    state.pendingMime  = (rawMime === "image/png" ? "image/png" : "image/jpeg") as "image/jpeg" | "image/png";
    state.pendingCaption = undefined;

    const kb = new InlineKeyboard()
      .text("✏️ Có, thêm caption", "caption_yes")
      .text("🚫 Không cần", "caption_no");

    await ctx.reply("Bạn có muốn thêm caption không?", { reply_markup: kb });
  } catch (e) {
    await ctx.reply(`❌ Không tải được ảnh: ${(e as Error).message}`);
  }
});

// ── Inline keyboard callbacks ─────────────────────────────────────────────────

bot.callbackQuery("caption_yes", async (ctx) => {
  await ctx.answerCallbackQuery();
  const state = getUser(ctx.from.id);
  state.waitingFor = "caption_text";
  await ctx.reply("✏️ Nhập caption cho QuickSnap:");
});

bot.callbackQuery("caption_no", async (ctx) => {
  await ctx.answerCallbackQuery();
  const state = getUser(ctx.from.id);
  state.pendingCaption = undefined;
  await askAudience(ctx);
});

// Audience selection
bot.callbackQuery(/^audience:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid      = ctx.from.id;
  const state    = getUser(uid);
  const audience = ctx.match[1] as QuickSnapAudience;

  if (!state.pendingPhoto) {
    await ctx.reply("❌ Không tìm thấy ảnh. Hãy gửi lại ảnh.");
    return;
  }

  // ── Capture into locals BEFORE any await (state may be mutated by other handlers) ──
  const savedCaption = state.pendingCaption;
  const savedPhoto   = state.pendingPhoto;
  const savedMime    = state.pendingMime;

  const captionPreview = savedCaption ? `\n✏️ Caption: "${savedCaption}"` : "";
  const audienceLabel  = audience === "besties" ? "Close Friends 💚" : "Following 👥";

  await ctx.reply(`🚀 Đang đăng QuickSnap...\n👥 ${audienceLabel}${captionPreview}`);

  try {
    if (process.env.IG_DEBUG) {
      process.stderr.write(`[BOT] Posting with savedCaption="${savedCaption}"\n`);
    }

    const result = await state.kit.sendQuickSnap({
      photo:    savedPhoto,
      mimeType: savedMime,
      caption:  savedCaption,
      audience,
    });

    if (process.env.IG_DEBUG) {
      process.stderr.write(`[BOT] result.caption="${result.caption}" savedCaption="${savedCaption}"\n`);
    }

    // Prefer: API echo → user-entered caption → (nothing)
    const captionText = result.caption || savedCaption;

    let msg = `✅ *QuickSnap đã đăng!*\n\n📅 ${result.takenAt.toLocaleString("vi-VN")}\n👥 ${audienceLabel}`;
    if (captionText) msg += `\n✏️ ${captionText}`;

    await ctx.reply(msg, { parse_mode: "Markdown" });

    // Clear pending state
    state.pendingPhoto   = null;
    state.pendingCaption = undefined;
    state.waitingFor     = null;
  } catch (e) {
    const errMsg = (e as Error).message;
    await ctx.reply(`❌ Đăng thất bại: ${errMsg}`);
  }
});


// ── Handle text messages (for 2FA code and caption input) ────────────────────

bot.on("message:text", async (ctx) => {
  const uid   = ctx.from!.id;
  const state = getUser(uid);
  const text  = ctx.message.text.trim();

  // Skip commands
  if (text.startsWith("/")) return;

  // 2FA code entry
  if (state.waitingFor === "totp") {
    state.waitingFor = null;
    if (!state.twoFactorInfo) { await ctx.reply("❌ Phiên 2FA đã hết hạn. Hãy /login lại."); return; }
    try {
      const session = await state.kit.verify2FA(state.twoFactorInfo, text, state.twoFactorMethod);
      state.session       = session;
      state.twoFactorInfo = null;
      saveSession(uid, session);
      await ctx.reply(`✅ Đăng nhập thành công! Xin chào *${session.username}*`, { parse_mode: "Markdown" });
    } catch (e) {
      await ctx.reply(`❌ Mã 2FA không đúng: ${(e as Error).message}`);
    }
    return;
  }

  // Caption text entry
  if (state.waitingFor === "caption_text") {
    state.waitingFor     = null;
    state.pendingCaption = text;
    await ctx.reply(`✅ Caption đã lưu: "${text}"`);
    await askAudience(ctx);
    return;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureLoggedIn(ctx: any, uid: number): UserState | null {
  const state = getUser(uid);
  if (!state.session) {
    // Try restore from file
    const restored = tryRestoreSession(uid, state.kit);
    if (restored) {
      state.session = restored;
      return state;
    }
    ctx.reply("Bạn chưa đăng nhập. Dùng /login <username> <password> [totp_secret]");
    return null;
  }
  return state;
}

async function askAudience(ctx: any): Promise<void> {
  const kb = new InlineKeyboard()
    .text("💚 Close Friends", "audience:besties")
    .text("👥 Following", "audience:following");
  await ctx.reply("Chọn đối tượng xem QuickSnap:", { reply_markup: kb });
}

// ── Start bot ─────────────────────────────────────────────────────────────────

console.log("🤖 QuickSnap Bot đang khởi động...");
bot.start({
  onStart: (botInfo) => {
    console.log(`✅ Bot @${botInfo.username} đang chạy. Gửi /start để bắt đầu.`);
  },
});
