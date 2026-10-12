import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { db, ensureDatabase, usingNeon } from "./database.mjs";
import { availableQuizzes, canRequestManualPromotion, getPromotion, getQuizPoints, QUIZZES, RANKS } from "./domain.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const sessionDays = 7;
const production = process.env.NODE_ENV === "production";
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
};
const statements = {
  userById: (id) => db.get("SELECT * FROM users WHERE id = ?", [id]),
  userByName: (username) => db.get("SELECT * FROM users WHERE LOWER(username) = LOWER(?)", [username]),
  createUser: async (username, passwordHash, salt, rank, isAdmin, mustChangePassword, createdAt) => {
    const rows = await db.all(
      "INSERT INTO users (username, password_hash, salt, rank, is_admin, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      [username, passwordHash, salt, rank, isAdmin, mustChangePassword, createdAt]
    );
    return { lastInsertRowid: rows[0].id };
  },
  countUsers: async () => ({ count: Number((await db.get("SELECT COUNT(*) AS count FROM users")).count) }),
  createSession: (tokenHash, userId, expiresAt) => db.run(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    [tokenHash, userId, expiresAt]
  ),
  findSession: (tokenHash) => db.get("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?", [tokenHash]),
  removeSession: (tokenHash) => db.run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]),
  addQuizBest: (userId, quizId, points) => db.run(
    "INSERT INTO quiz_best (user_id, quiz_id, best_points) VALUES (?, ?, ?) ON CONFLICT (user_id, quiz_id) DO UPDATE SET best_points = excluded.best_points",
    [userId, quizId, points]
  ),
  getQuizBest: (userId, quizId) => db.get("SELECT best_points FROM quiz_best WHERE user_id = ? AND quiz_id = ?", [userId, quizId]),
  resetQuizBest: (userId) => db.run("DELETE FROM quiz_best WHERE user_id = ?", [userId]),
  deletePromotionRequest: (userId) => db.run("DELETE FROM promotion_requests WHERE user_id = ?", [userId]),
  findPromotionRequest: (userId) => db.get("SELECT rank FROM promotion_requests WHERE user_id = ?", [userId]),
  getSetting: (key) => db.get("SELECT value FROM settings WHERE key = ?", [key]),
  saveSetting: (key, value) => db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
    [key, value]
  ),
  deleteSetting: (key) => db.run("DELETE FROM settings WHERE key = ?", [key]),
  updatePassword: (passwordHash, salt, userId) => db.run(
    "UPDATE users SET password_hash = ?, salt = ?, must_change_password = 0 WHERE id = ?",
    [passwordHash, salt, userId]
  ),
  revokeUserSessions: (userId) => db.run("DELETE FROM sessions WHERE user_id = ?", [userId]),
  updateRank: (rank, userId) => db.run("UPDATE users SET rank = ?, points = 0 WHERE id = ?", [rank, userId]),
  clearWarning: (userId) => db.run("UPDATE users SET warning_until = NULL WHERE id = ?", [userId]),
  userList: () => db.all("SELECT id, username, rank, points, shooting_passed, warning_until, is_admin FROM users ORDER BY LOWER(username)")
};

const PRESET_ADMINS = [
  { username: "admin", password: "admin123" },
  { username: "moderator", password: "moderator123" },
  { username: "leader", password: "leader123" }
];

async function ensureAdminSetupKey() {
  if (Number((await statements.countUsers()).count) !== 0 || await statements.getSetting("admin_setup_key")) return;
  await statements.saveSetting("admin_setup_key", "preset");
}

async function safeUser(user) {
  const currentRank = RANKS[user.rank];
  const activeWarning = user.warning_until !== null && user.warning_until > Date.now();
  if (!activeWarning && user.warning_until !== null) await statements.clearWarning(user.id);
  const checks = {
    shootingPassed: Boolean(user.shooting_passed),
    knowledgePassed: Boolean(user.knowledge_passed),
    activeWarning
  };
  const promotion = getPromotion(user.rank, user.points, checks);
  const manualPromotionReady = canRequestManualPromotion(user.rank, user.points, checks);
  return {
    id: user.id,
    username: user.username,
    rank: currentRank.name,
    rankIndex: user.rank,
    points: user.points,
    isAdmin: Boolean(user.is_admin),
    mustChangePassword: Boolean(user.must_change_password),
    shootingPassed: checks.shootingPassed,
    knowledgePassed: checks.knowledgePassed,
    activeWarning,
    warningUntil: activeWarning ? user.warning_until : null,
    nextPoints: currentRank.nextPoints,
    requirement: currentRank.requirement ?? null,
    promotion,
    manualPromotionReady,
    manualApprovalRequired: currentRank.manual
  };
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const separator = part.indexOf("=");
    return separator < 0 ? ["", ""] : [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}

function sendJson(response, status, data, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(data));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function isUniqueConstraintError(error) {
  return error.code === "23505" || String(error.message).includes("UNIQUE");
}

async function readJson(request) {
  if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
    return request.body;
  }
  if (typeof request.body === "string") {
    try {
      return request.body ? JSON.parse(request.body) : {};
    } catch {
      throw new Error("Некорректный формат запроса");
    }
  }
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error("Слишком большой запрос");
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error("Некорректный формат запроса");
  }
}

function validCredentials(username, password) {
  return typeof username === "string"
    && /^[\p{L}\p{N}_-]{3,24}$/u.test(username.trim())
    && typeof password === "string"
    && password.length >= 8
    && password.length <= 128;
}

async function issueSession(response, userId) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + sessionDays * 24 * 60 * 60 * 1000;
  await statements.createSession(hashToken(token), userId, expiresAt);
  const flags = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionDays * 24 * 60 * 60}${production ? "; Secure" : ""}`;
  response.setHeader("Set-Cookie", `clan_session=${encodeURIComponent(token)}; ${flags}`);
}

async function clearSession(response, token) {
  if (token) await statements.removeSession(hashToken(token));
  response.setHeader("Set-Cookie", `clan_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${production ? "; Secure" : ""}`);
}

async function getUser(request) {
  const token = parseCookies(request.headers.cookie).clan_session;
  if (!token) return null;
  const session = await statements.findSession(hashToken(token));
  if (!session) return null;
  if (session.expires_at <= Date.now()) {
    await statements.removeSession(hashToken(token));
    return null;
  }
  return await statements.userById(session.user_id);
}

async function publicQuiz(quiz, userId) {
  const best = (await statements.getQuizBest(userId, quiz.id))?.best_points ?? 0;
  return {
    id: quiz.id,
    title: quiz.title,
    category: quiz.category,
    image: quiz.image,
    imageAlt: quiz.imageAlt,
    maxPoints: quiz.questions.length * 10,
    bestPoints: best,
    questions: quiz.questions.map(({ prompt, options }) => ({ prompt, options }))
  };
}

async function promote(user, targetRank) {
  await statements.updateRank(targetRank, user.id);
  await statements.resetQuizBest(user.id);
}

async function handleApi(request, response, url) {
  await ensureDatabase();
  const user = await getUser(request);
  const path = url.pathname;

  if (request.method === "GET" && path === "/api/status") {
    await ensureAdminSetupKey();
    return sendJson(response, 200, { setupNeeded: (await statements.countUsers()).count === 0 });
  }

  if (request.method === "POST" && path === "/api/setup") {
    const body = await readJson(request);
    if ((await statements.countUsers()).count !== 0) return sendError(response, 409, "Первичная настройка уже выполнена");
    await ensureAdminSetupKey();
    if (!validCredentials(body.username, body.password)) return sendError(response, 400, "Ник: 3–24 буквы, цифры, _ или -. Пароль: не менее 8 символов.");
    const savedKey = (await statements.getSetting("admin_setup_key"))?.value;
    if (savedKey === "preset") {
      const preset = PRESET_ADMINS.find(a => a.username === body.username.trim() && a.password === body.password);
      if (!preset) return sendError(response, 403, "Используйте один из предустановленных аккаунтов администратора");
      const salt = randomBytes(16).toString("hex");
      let result;
      try {
        result = await statements.createUser(body.username.trim(), scryptSync(body.password, salt, 64).toString("hex"), salt, 0, 1, 0, Date.now());
      } catch (error) {
        if (isUniqueConstraintError(error)) return sendError(response, 409, "Первичная настройка уже выполнена или этот ник занят");
        throw error;
      }
      await statements.deleteSetting("admin_setup_key");
      await issueSession(response, Number(result.lastInsertRowid));
      return sendJson(response, 201, { ok: true });
    }
    if (typeof body.setupKey !== "string" || body.setupKey.length > 256 || !savedKey
      || !timingSafeEqual(
        Buffer.from(savedKey, "hex"),
        createHash("sha256").update(body.setupKey).digest()
      )) {
      return sendError(response, 403, "Неверный ключ первичной настройки");
    }
    const salt = randomBytes(16).toString("hex");
    let result;
    try {
      result = await statements.createUser(body.username.trim(), scryptSync(body.password, salt, 64).toString("hex"), salt, 0, 1, 1, Date.now());
    } catch (error) {
      if (isUniqueConstraintError(error)) return sendError(response, 409, "Первичная настройка уже выполнена или этот ник занят");
      throw error;
    }
    await statements.deleteSetting("admin_setup_key");
    await issueSession(response, Number(result.lastInsertRowid));
    return sendJson(response, 201, { ok: true });
  }

  if (request.method === "POST" && path === "/api/accounts") {
    const body = await readJson(request);
    if (!validCredentials(body.username, body.password)) return sendError(response, 400, "Ник: 3–24 буквы, цифры, _ или -. Пароль: не менее 8 символов.");
    const salt = randomBytes(16).toString("hex");
    try {
      await statements.createUser(body.username.trim(), scryptSync(body.password, salt, 64).toString("hex"), salt, 0, 0, 0, Date.now());
    } catch (error) {
      if (isUniqueConstraintError(error)) return sendError(response, 409, "Этот ник уже занят");
      throw error;
    }
    return sendJson(response, 201, { ok: true });
  }

  if (request.method === "POST" && path === "/api/login") {
    const body = await readJson(request);
    if (typeof body.username !== "string" || typeof body.password !== "string") return sendError(response, 400, "Введите ник и пароль");
    const found = await statements.userByName(body.username.trim());
    const salt = found?.salt ?? "invalid-account-salt";
    const expected = found?.password_hash ?? "0".repeat(128);
    const actual = scryptSync(body.password.slice(0, 128), salt, 64).toString("hex");
    if (!found || !timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))) {
      return sendError(response, 401, "Неверный ник или пароль");
    }
    await issueSession(response, found.id);
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "POST" && path === "/api/logout") {
    const token = parseCookies(request.headers.cookie).clan_session;
    await clearSession(response, token);
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "POST" && path === "/api/change-password") {
    if (!user) return sendError(response, 401, "Войдите в аккаунт");
    const body = await readJson(request);
    if (!validCredentials(user.username, body.newPassword)) {
      return sendError(response, 400, "Новый пароль должен содержать от 8 до 128 символов");
    }
    if (typeof body.currentPassword !== "string") return sendError(response, 400, "Введи текущий пароль");
    const actual = scryptSync(body.currentPassword.slice(0, 128), user.salt, 64);
    const expected = Buffer.from(user.password_hash, "hex");
    if (!timingSafeEqual(actual, expected)) return sendError(response, 401, "Текущий пароль введён неверно");
    const salt = randomBytes(16).toString("hex");
    await statements.updatePassword(scryptSync(body.newPassword, salt, 64).toString("hex"), salt, user.id);
    await statements.revokeUserSessions(user.id);
    await issueSession(response, user.id);
    return sendJson(response, 200, { ok: true });
  }

  if (user?.must_change_password && !(request.method === "GET" && path === "/api/me")) {
    return sendError(response, 403, "Сначала смени временный пароль администратора");
  }

  if (request.method === "GET" && path === "/api/me") {
    if (!user) return sendError(response, 401, "Войдите в аккаунт");
    const current = await safeUser(user);
    const quizzes = await Promise.all(availableQuizzes(user.rank).map((quiz) => publicQuiz(quiz, user.id)));
    return sendJson(response, 200, { user: current, quizzes });
  }

  if (request.method === "POST" && path === "/api/promotion") {
    if (!user) return sendError(response, 401, "Войдите в аккаунт");
    const checks = {
      shootingPassed: Boolean(user.shooting_passed),
      knowledgePassed: Boolean(user.knowledge_passed),
      activeWarning: user.warning_until !== null && user.warning_until > Date.now()
    };
    const promotion = getPromotion(user.rank, user.points, checks);
    if (canRequestManualPromotion(user.rank, user.points, checks)) {
      await db.run(
        "INSERT INTO promotion_requests (user_id, rank, requested_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET rank = excluded.rank, requested_at = excluded.requested_at",
        [user.id, user.rank, Date.now()]
      );
      return sendJson(response, 200, { requested: true });
    }
    if (!promotion.eligible) return sendError(response, 403, promotion.reason);
    const currentRank = RANKS[user.rank];
    if (user.rank === 0 || currentRank.manual) return sendError(response, 403, "Для этого повышения нужно решение руководства");
    const nextRank = user.rank + 1;
    await promote(user, nextRank);
    return sendJson(response, 200, { rank: RANKS[nextRank].name });
  }

  const quizMatch = path.match(/^\/api\/quizzes\/([a-z-]+)\/submit$/);
  if (request.method === "POST" && quizMatch) {
    if (!user) return sendError(response, 401, "Войдите в аккаунт");
    const quiz = QUIZZES.find((item) => item.id === quizMatch[1]);
    if (!quiz || user.rank < quiz.requiredRank) return sendError(response, 403, "Этот тест пока закрыт");
    const body = await readJson(request);
    if (!Array.isArray(body.answers) || body.answers.length !== quiz.questions.length
      || body.answers.some((answer) => !Number.isInteger(answer) || answer < 0 || answer > 2)) {
      return sendError(response, 400, "Ответьте на все вопросы теста");
    }
    const points = getQuizPoints(quiz, body.answers);
    const best = (await statements.getQuizBest(user.id, quiz.id))?.best_points ?? 0;
    const gained = Math.max(0, points - best);
    await statements.addQuizBest(user.id, quiz.id, Math.max(best, points));
    if (gained) await db.run("UPDATE users SET points = points + ? WHERE id = ?", [gained, user.id]);
    if (quiz.id === "leadership" && points >= 30) {
      await db.run("UPDATE users SET knowledge_passed = 1 WHERE id = ?", [user.id]);
    }

    const updated = await statements.userById(user.id);
    const promotion = getPromotion(updated.rank, updated.points, {
      shootingPassed: Boolean(updated.shooting_passed),
      knowledgePassed: Boolean(updated.knowledge_passed),
      activeWarning: updated.warning_until !== null && updated.warning_until > Date.now()
    });
    let promotedTo = null;
    if (promotion.eligible && !RANKS[updated.rank].manual && updated.rank > 0) {
      promotedTo = RANKS[updated.rank + 1].name;
      await promote(updated, updated.rank + 1);
    }
    return sendJson(response, 200, { points, gained, promotedTo });
  }

  if (request.method === "GET" && path === "/api/admin/users") {
    if (!user?.is_admin) return sendError(response, user ? 403 : 401, "Доступ только для администратора");
    const users = await Promise.all((await statements.userList()).map(async (item) => {
      const publicItem = await safeUser(item);
      const request = await statements.findPromotionRequest(item.id);
      const checks = {
        shootingPassed: Boolean(item.shooting_passed),
        knowledgePassed: Boolean(item.knowledge_passed),
        activeWarning: item.warning_until !== null && item.warning_until > Date.now()
      };
      return { ...publicItem, eligibleForManualPromotion: getPromotion(item.rank, item.points, {
        ...checks
      }).eligible, pendingPromotion: request?.rank === item.rank
        && canRequestManualPromotion(item.rank, item.points, checks) };
    }));
    return sendJson(response, 200, { ranks: RANKS.map((rank) => rank.name), users });
  }

  const adminUserMatch = path.match(/^\/api\/admin\/users\/(\d+)$/);
  if (request.method === "PATCH" && adminUserMatch) {
    if (!user?.is_admin) return sendError(response, user ? 403 : 401, "Доступ только для администратора");
    const target = await statements.userById(Number(adminUserMatch[1]));
    if (!target) return sendError(response, 404, "Участник не найден");
    const body = await readJson(request);

    if (body.action === "warning") {
      if (!Number.isInteger(body.days) || body.days < 0 || body.days > 365) return sendError(response, 400, "Укажите срок от 0 до 365 дней");
      const until = body.days === 0 ? null : Date.now() + body.days * 24 * 60 * 60 * 1000;
      await db.run("UPDATE users SET warning_until = ? WHERE id = ?", [until, target.id]);
    } else if (body.action === "shooting") {
      if (typeof body.passed !== "boolean") return sendError(response, 400, "Некорректное значение проверки");
      await db.run("UPDATE users SET shooting_passed = ? WHERE id = ?", [Number(body.passed), target.id]);
    } else if (body.action === "update") {
      if (!Number.isInteger(body.rank) || !RANKS[body.rank]) return sendError(response, 400, "Некорректное звание");
      if (typeof body.shootingPassed !== "boolean") return sendError(response, 400, "Некорректное значение проверки");
      if (!Number.isInteger(body.warningDays) || body.warningDays < 0 || body.warningDays > 365) return sendError(response, 400, "Укажите срок от 0 до 365 дней");
      const rankChanged = body.rank !== target.rank;
      const warningUntil = body.warningDays === 0 ? null : Date.now() + body.warningDays * 24 * 60 * 60 * 1000;
      await db.run(
        "UPDATE users SET rank = ?, points = CASE WHEN ? = 1 THEN 0 ELSE points END, shooting_passed = ?, warning_until = ? WHERE id = ?",
        [body.rank, Number(rankChanged), Number(body.shootingPassed), warningUntil, target.id]
      );
      if (rankChanged) {
        await statements.resetQuizBest(target.id);
        await statements.deletePromotionRequest(target.id);
      }
    } else if (body.action === "promote") {
      const checks = {
        shootingPassed: Boolean(target.shooting_passed),
        knowledgePassed: Boolean(target.knowledge_passed),
        activeWarning: target.warning_until !== null && target.warning_until > Date.now()
      };
      const request = await statements.findPromotionRequest(target.id);
      if (!RANKS[target.rank].manual || request?.rank !== target.rank
        || !canRequestManualPromotion(target.rank, target.points, checks)) {
        return sendError(response, 403, "Повышение не доступно: проверьте баллы, выговор и требования");
      }
      await promote(target, target.rank + 1);
      await statements.deletePromotionRequest(target.id);
    } else {
      return sendError(response, 400, "Неизвестное действие");
    }
    return sendJson(response, 200, { ok: true });
  }

  return sendError(response, 404, "Маршрут не найден");
}

function serveStatic(request, response, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const allowed = new Set(["/index.html", "/styles.css", "/app.js", ...QUIZZES.map((quiz) => quiz.image)]);
  if (!allowed.has(requested)) return sendError(response, 404, "Страница не найдена");
  const filePath = resolve(root, `.${requested}`);
  if (!existsSync(filePath)) return sendError(response, 404, "Файл не найден");
  response.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  createReadStream(filePath).pipe(response);
}

export async function handler(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
    } else if (request.method === "GET") {
      serveStatic(request, response, url);
    } else {
      sendError(response, 405, "Метод не поддерживается");
    }
  } catch (error) {
    if (error.message === "Слишком большой запрос" || error.message === "Некорректный формат запроса") {
      sendError(response, 400, error.message);
    } else if (isUniqueConstraintError(error)) {
      sendError(response, 409, "Этот ник уже занят");
    } else {
      console.error(error);
      sendError(response, 500, "Внутренняя ошибка сервера");
    }
  }
}

export const server = createServer(handler);
server.on("close", () => db.close());

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, "0.0.0.0", () => {
    console.log(`Сайт клана доступен: http://localhost:${port}`);
    console.log("При первом запуске введи ключ из консоли и создай аккаунт единственного администратора.");
  });
}
