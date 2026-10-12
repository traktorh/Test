import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { availableQuizzes, canRequestManualPromotion, getPromotion, getQuizPoints, QUIZZES, RANKS } from "./domain.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const dataDirectory = resolve(root, "data");
mkdirSync(dataDirectory, { recursive: true });
const databasePath = resolve(process.env.DATABASE_PATH ?? resolve(dataDirectory, "clan.sqlite"));
mkdirSync(dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    rank INTEGER NOT NULL DEFAULT 0,
    points INTEGER NOT NULL DEFAULT 0,
    shooting_passed INTEGER NOT NULL DEFAULT 0,
    knowledge_passed INTEGER NOT NULL DEFAULT 0,
    warning_until INTEGER,
    is_admin INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS quiz_best (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    quiz_id TEXT NOT NULL,
    best_points INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, quiz_id)
  );
  CREATE TABLE IF NOT EXISTS promotion_requests (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    rank INTEGER NOT NULL,
    requested_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);
db.prepare(`
  UPDATE users
  SET is_admin = 0
  WHERE is_admin = 1
    AND id <> (SELECT id FROM users WHERE is_admin = 1 ORDER BY created_at, id LIMIT 1)
`).run();
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS single_administrator ON users(is_admin) WHERE is_admin = 1");
for (const [column, definition] of [
  ["shooting_passed", "INTEGER NOT NULL DEFAULT 0"],
  ["knowledge_passed", "INTEGER NOT NULL DEFAULT 0"],
  ["must_change_password", "INTEGER NOT NULL DEFAULT 0"]
]) {
  const columns = db.prepare("PRAGMA table_info(users)").all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
  }
}

const sessionDays = 7;
const production = process.env.NODE_ENV === "production";
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
};
const statements = {
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  userByName: db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE"),
  createUser: db.prepare("INSERT INTO users (username, password_hash, salt, rank, is_admin, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  countUsers: db.prepare("SELECT COUNT(*) AS count FROM users"),
  createSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"),
  findSession: db.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?"),
  removeSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  addQuizBest: db.prepare("INSERT INTO quiz_best (user_id, quiz_id, best_points) VALUES (?, ?, ?) ON CONFLICT (user_id, quiz_id) DO UPDATE SET best_points = excluded.best_points"),
  getQuizBest: db.prepare("SELECT best_points FROM quiz_best WHERE user_id = ? AND quiz_id = ?"),
  resetQuizBest: db.prepare("DELETE FROM quiz_best WHERE user_id = ?"),
  deletePromotionRequest: db.prepare("DELETE FROM promotion_requests WHERE user_id = ?"),
  findPromotionRequest: db.prepare("SELECT rank FROM promotion_requests WHERE user_id = ?"),
  getSetting: db.prepare("SELECT value FROM settings WHERE key = ?"),
  saveSetting: db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)"),
  deleteSetting: db.prepare("DELETE FROM settings WHERE key = ?"),
  updatePassword: db.prepare("UPDATE users SET password_hash = ?, salt = ?, must_change_password = 0 WHERE id = ?"),
  revokeUserSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
  updateRank: db.prepare("UPDATE users SET rank = ?, points = 0 WHERE id = ?"),
  clearWarning: db.prepare("UPDATE users SET warning_until = NULL WHERE id = ?"),
  userList: db.prepare("SELECT id, username, rank, points, shooting_passed, warning_until, is_admin FROM users ORDER BY username COLLATE NOCASE")
};

if (statements.countUsers.get().count === 0 && !statements.getSetting.get("admin_setup_key")) {
  const configuredKey = process.env.ADMIN_SETUP_KEY;
  if (production && !configuredKey) {
    throw new Error("Set ADMIN_SETUP_KEY before the first production launch");
  }
  if (configuredKey && configuredKey.length < 20) {
    throw new Error("ADMIN_SETUP_KEY must contain at least 20 characters");
  }
  const setupKey = configuredKey ?? randomBytes(32).toString("base64url");
  statements.saveSetting.run("admin_setup_key", createHash("sha256").update(setupKey).digest("hex"));
  if (!configuredKey) {
    console.log(`Одноразовый ключ создания администратора: ${setupKey}`);
  }
}

function safeUser(user) {
  const currentRank = RANKS[user.rank];
  const activeWarning = user.warning_until !== null && user.warning_until > Date.now();
  if (!activeWarning && user.warning_until !== null) statements.clearWarning.run(user.id);
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

async function readJson(request) {
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

function issueSession(response, userId) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + sessionDays * 24 * 60 * 60 * 1000;
  statements.createSession.run(hashToken(token), userId, expiresAt);
  const flags = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionDays * 24 * 60 * 60}${production ? "; Secure" : ""}`;
  response.setHeader("Set-Cookie", `clan_session=${encodeURIComponent(token)}; ${flags}`);
}

function clearSession(response, token) {
  if (token) statements.removeSession.run(hashToken(token));
  response.setHeader("Set-Cookie", `clan_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${production ? "; Secure" : ""}`);
}

function getUser(request) {
  const token = parseCookies(request.headers.cookie).clan_session;
  if (!token) return null;
  const session = statements.findSession.get(hashToken(token));
  if (!session) return null;
  if (session.expires_at <= Date.now()) {
    statements.removeSession.run(hashToken(token));
    return null;
  }
  return statements.userById.get(session.user_id) ?? null;
}

function publicQuiz(quiz, userId) {
  const best = statements.getQuizBest.get(userId, quiz.id)?.best_points ?? 0;
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

function promote(user, targetRank) {
  statements.updateRank.run(targetRank, user.id);
  statements.resetQuizBest.run(user.id);
}

async function handleApi(request, response, url) {
  const user = getUser(request);
  const path = url.pathname;

  if (request.method === "GET" && path === "/api/status") {
    return sendJson(response, 200, { setupNeeded: statements.countUsers.get().count === 0 });
  }

  if (request.method === "POST" && path === "/api/setup") {
    const body = await readJson(request);
    if (statements.countUsers.get().count !== 0) return sendError(response, 409, "Первичная настройка уже выполнена");
    if (!validCredentials(body.username, body.password)) return sendError(response, 400, "Ник: 3–24 буквы, цифры, _ или -. Пароль: не менее 8 символов.");
    const savedKey = statements.getSetting.get("admin_setup_key")?.value;
    if (typeof body.setupKey !== "string" || body.setupKey.length > 256 || !savedKey
      || !timingSafeEqual(
        Buffer.from(savedKey, "hex"),
        createHash("sha256").update(body.setupKey).digest()
      )) {
      return sendError(response, 403, "Неверный ключ первичной настройки");
    }
    const salt = randomBytes(16).toString("hex");
    const result = statements.createUser.run(body.username.trim(), scryptSync(body.password, salt, 64).toString("hex"), salt, 0, 1, 1, Date.now());
    statements.deleteSetting.run("admin_setup_key");
    issueSession(response, Number(result.lastInsertRowid));
    return sendJson(response, 201, { ok: true });
  }

  if (request.method === "POST" && path === "/api/accounts") {
    const body = await readJson(request);
    if (!validCredentials(body.username, body.password)) return sendError(response, 400, "Ник: 3–24 буквы, цифры, _ или -. Пароль: не менее 8 символов.");
    const salt = randomBytes(16).toString("hex");
    try {
      statements.createUser.run(body.username.trim(), scryptSync(body.password, salt, 64).toString("hex"), salt, 0, 0, 0, Date.now());
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) return sendError(response, 409, "Этот ник уже занят");
      throw error;
    }
    return sendJson(response, 201, { ok: true });
  }

  if (request.method === "POST" && path === "/api/login") {
    const body = await readJson(request);
    if (typeof body.username !== "string" || typeof body.password !== "string") return sendError(response, 400, "Введите ник и пароль");
    const found = statements.userByName.get(body.username.trim());
    const salt = found?.salt ?? "invalid-account-salt";
    const expected = found?.password_hash ?? "0".repeat(128);
    const actual = scryptSync(body.password.slice(0, 128), salt, 64).toString("hex");
    if (!found || !timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))) {
      return sendError(response, 401, "Неверный ник или пароль");
    }
    issueSession(response, found.id);
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "POST" && path === "/api/logout") {
    const token = parseCookies(request.headers.cookie).clan_session;
    clearSession(response, token);
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
    statements.updatePassword.run(scryptSync(body.newPassword, salt, 64).toString("hex"), salt, user.id);
    statements.revokeUserSessions.run(user.id);
    issueSession(response, user.id);
    return sendJson(response, 200, { ok: true });
  }

  if (user?.must_change_password && !(request.method === "GET" && path === "/api/me")) {
    return sendError(response, 403, "Сначала смени временный пароль администратора");
  }

  if (request.method === "GET" && path === "/api/me") {
    if (!user) return sendError(response, 401, "Войдите в аккаунт");
    const current = safeUser(user);
    const quizzes = availableQuizzes(user.rank).map((quiz) => publicQuiz(quiz, user.id));
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
      db.prepare("INSERT INTO promotion_requests (user_id, rank, requested_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET rank = excluded.rank, requested_at = excluded.requested_at")
        .run(user.id, user.rank, Date.now());
      return sendJson(response, 200, { requested: true });
    }
    if (!promotion.eligible) return sendError(response, 403, promotion.reason);
    const currentRank = RANKS[user.rank];
    if (user.rank === 0 || currentRank.manual) return sendError(response, 403, "Для этого повышения нужно решение руководства");
    const nextRank = user.rank + 1;
    promote(user, nextRank);
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
    const best = statements.getQuizBest.get(user.id, quiz.id)?.best_points ?? 0;
    const gained = Math.max(0, points - best);
    statements.addQuizBest.run(user.id, quiz.id, Math.max(best, points));
    if (gained) db.prepare("UPDATE users SET points = points + ? WHERE id = ?").run(gained, user.id);
    if (quiz.id === "leadership" && points >= 30) {
      db.prepare("UPDATE users SET knowledge_passed = 1 WHERE id = ?").run(user.id);
    }

    const updated = statements.userById.get(user.id);
    const promotion = getPromotion(updated.rank, updated.points, {
      shootingPassed: Boolean(updated.shooting_passed),
      knowledgePassed: Boolean(updated.knowledge_passed),
      activeWarning: updated.warning_until !== null && updated.warning_until > Date.now()
    });
    let promotedTo = null;
    if (promotion.eligible && !RANKS[updated.rank].manual && updated.rank > 0) {
      promotedTo = RANKS[updated.rank + 1].name;
      promote(updated, updated.rank + 1);
    }
    return sendJson(response, 200, { points, gained, promotedTo });
  }

  if (request.method === "GET" && path === "/api/admin/users") {
    if (!user?.is_admin) return sendError(response, user ? 403 : 401, "Доступ только для администратора");
    const users = statements.userList.all().map((item) => {
      const publicItem = safeUser(item);
      const request = statements.findPromotionRequest.get(item.id);
      const checks = {
        shootingPassed: Boolean(item.shooting_passed),
        knowledgePassed: Boolean(item.knowledge_passed),
        activeWarning: item.warning_until !== null && item.warning_until > Date.now()
      };
      return { ...publicItem, eligibleForManualPromotion: getPromotion(item.rank, item.points, {
        ...checks
      }).eligible, pendingPromotion: request?.rank === item.rank
        && canRequestManualPromotion(item.rank, item.points, checks) };
    });
    return sendJson(response, 200, { ranks: RANKS.map((rank) => rank.name), users });
  }

  const adminUserMatch = path.match(/^\/api\/admin\/users\/(\d+)$/);
  if (request.method === "PATCH" && adminUserMatch) {
    if (!user?.is_admin) return sendError(response, user ? 403 : 401, "Доступ только для администратора");
    const target = statements.userById.get(Number(adminUserMatch[1]));
    if (!target) return sendError(response, 404, "Участник не найден");
    const body = await readJson(request);

    if (body.action === "warning") {
      if (!Number.isInteger(body.days) || body.days < 0 || body.days > 365) return sendError(response, 400, "Укажите срок от 0 до 365 дней");
      const until = body.days === 0 ? null : Date.now() + body.days * 24 * 60 * 60 * 1000;
      db.prepare("UPDATE users SET warning_until = ? WHERE id = ?").run(until, target.id);
    } else if (body.action === "shooting") {
      if (typeof body.passed !== "boolean") return sendError(response, 400, "Некорректное значение проверки");
      db.prepare("UPDATE users SET shooting_passed = ? WHERE id = ?").run(Number(body.passed), target.id);
    } else if (body.action === "update") {
      if (!Number.isInteger(body.rank) || !RANKS[body.rank]) return sendError(response, 400, "Некорректное звание");
      if (typeof body.shootingPassed !== "boolean") return sendError(response, 400, "Некорректное значение проверки");
      if (!Number.isInteger(body.warningDays) || body.warningDays < 0 || body.warningDays > 365) return sendError(response, 400, "Укажите срок от 0 до 365 дней");
      const rankChanged = body.rank !== target.rank;
      const warningUntil = body.warningDays === 0 ? null : Date.now() + body.warningDays * 24 * 60 * 60 * 1000;
      db.prepare("UPDATE users SET rank = ?, points = CASE WHEN ? THEN 0 ELSE points END, shooting_passed = ?, warning_until = ? WHERE id = ?")
        .run(body.rank, Number(rankChanged), Number(body.shootingPassed), warningUntil, target.id);
      if (rankChanged) {
        statements.resetQuizBest.run(target.id);
        statements.deletePromotionRequest.run(target.id);
      }
    } else if (body.action === "promote") {
      const checks = {
        shootingPassed: Boolean(target.shooting_passed),
        knowledgePassed: Boolean(target.knowledge_passed),
        activeWarning: target.warning_until !== null && target.warning_until > Date.now()
      };
      const request = statements.findPromotionRequest.get(target.id);
      if (!RANKS[target.rank].manual || request?.rank !== target.rank
        || !canRequestManualPromotion(target.rank, target.points, checks)) {
        return sendError(response, 403, "Повышение не доступно: проверьте баллы, выговор и требования");
      }
      promote(target, target.rank + 1);
      statements.deletePromotionRequest.run(target.id);
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

export const server = createServer(async (request, response) => {
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
    } else if (String(error.message).includes("UNIQUE")) {
      sendError(response, 409, "Этот ник уже занят");
    } else {
      console.error(error);
      sendError(response, 500, "Внутренняя ошибка сервера");
    }
  }
});
server.on("close", () => db.close());

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, "0.0.0.0", () => {
    console.log(`Сайт клана доступен: http://localhost:${port}`);
    console.log("При первом запуске введи ключ из консоли и создай аккаунт единственного администратора.");
  });
}
