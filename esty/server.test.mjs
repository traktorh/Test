import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { QUIZZES } from "./domain.mjs";

const databasePath = join(tmpdir(), `clan-integration-${randomUUID()}.sqlite`);
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_SETUP_KEY = "test-only-setup-key-that-is-long-enough";
const { server } = await import("./server.mjs");
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json();
  return {
    response,
    data,
    cookie: response.headers.getSetCookie()[0]?.split(";")[0]
  };
}

test("first account is sole admin; ranks unlock illustrated quizzes and promotions", async (t) => {
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const suffix of ["", "-shm", "-wal"]) rmSync(`${databasePath}${suffix}`, { force: true });
  });

  assert.equal((await request("/api/status")).data.setupNeeded, true);
  const noKey = await request("/api/setup", {
    method: "POST",
    body: { username: "Attacker", password: "PrivateTemp2026!", setupKey: "wrong" }
  });
  assert.equal(noKey.response.status, 403);
  const setup = await request("/api/setup", {
    method: "POST",
    body: {
      username: "ClanBoss",
      password: "ClanStart2026!",
      setupKey: process.env.ADMIN_SETUP_KEY
    }
  });
  assert.equal(setup.response.status, 201);
  const compromisedCookie = (await request("/api/login", {
    method: "POST",
    body: { username: "ClanBoss", password: "ClanStart2026!" }
  })).cookie;
  let adminCookie = setup.cookie;
  const initialAdmin = await request("/api/me", { cookie: adminCookie });
  assert.equal(initialAdmin.data.user.mustChangePassword, true);
  assert.equal((await request("/api/admin/users", { cookie: adminCookie })).response.status, 403);
  assert.equal((await request("/api/change-password", {
    method: "POST",
    cookie: adminCookie,
    body: { currentPassword: "incorrect-password", newPassword: "NewOwnerPass2026!" }
  })).response.status, 401);
  const changedPassword = await request("/api/change-password", {
    method: "POST",
    cookie: adminCookie,
    body: { currentPassword: "ClanStart2026!", newPassword: "NewOwnerPass2026!" }
  });
  assert.equal(changedPassword.response.status, 200);
  adminCookie = changedPassword.cookie;
  assert.equal((await request("/api/admin/users", { cookie: compromisedCookie })).response.status, 401);
  assert.equal((await request("/api/admin/users", { cookie: adminCookie })).response.status, 200);
  assert.equal((await request("/api/login", {
    method: "POST",
    body: { username: "ClanBoss", password: "ClanStart2026!" }
  })).response.status, 401);
  assert.equal((await request("/api/login", {
    method: "POST",
    body: { username: "ClanBoss", password: "NewOwnerPass2026!" }
  })).response.status, 200);
  const adminPage = await request("/api/admin/users", { cookie: adminCookie });
  assert.equal(adminPage.response.status, 200);
  assert.equal(adminPage.data.users.filter((user) => user.isAdmin).length, 1);

  assert.equal((await request("/api/setup", {
    method: "POST",
    body: {
      username: "SecondAdmin",
      password: "PrivateTemp2026!",
      setupKey: process.env.ADMIN_SETUP_KEY
    }
  })).response.status, 409);

  assert.equal((await request("/api/accounts", {
    method: "POST",
    body: { username: "RavenTest", password: "PrivateTemp2026!" }
  })).response.status, 201);
  const memberLogin = await request("/api/login", {
    method: "POST",
    body: { username: "RavenTest", password: "PrivateTemp2026!" }
  });
  const memberCookie = memberLogin.cookie;
  const novice = await request("/api/me", { cookie: memberCookie });
  assert.equal(novice.data.user.rank, "Шпана");
  assert.equal(novice.data.quizzes.length, 0);
  assert.equal((await request("/api/quizzes/charter/submit", {
    method: "POST",
    body: { answers: [0, 0, 0, 0] },
    cookie: memberCookie
  })).response.status, 403);

  await request("/api/admin/users/2", {
    method: "PATCH",
    cookie: adminCookie,
    body: { action: "update", rank: 1, shootingPassed: false, warningDays: 0 }
  });
  const promotedMember = await request("/api/me", { cookie: memberCookie });
  assert.equal(promotedMember.data.user.rank, "Фраер");
  assert.equal(promotedMember.data.quizzes.length, 1);
  assert.ok(promotedMember.data.quizzes[0].image.startsWith("/images/"));

  const firstTest = await request("/api/quizzes/charter/submit", {
    method: "POST",
    body: { answers: QUIZZES.find((quiz) => quiz.id === "charter").questions.map((item) => item.answer) },
    cookie: memberCookie
  });
  assert.equal(firstTest.data.promotedTo, "Шестерка");
  let member = await request("/api/me", { cookie: memberCookie });
  assert.equal(member.data.user.points, 0);
  assert.equal(member.data.quizzes.length, 2);

  await request("/api/quizzes/charter/submit", {
    method: "POST",
    body: { answers: QUIZZES.find((quiz) => quiz.id === "charter").questions.map((item) => item.answer) },
    cookie: memberCookie
  });
  const blockedPromotion = await request("/api/quizzes/teamwork/submit", {
    method: "POST",
    body: { answers: QUIZZES.find((quiz) => quiz.id === "teamwork").questions.map((item) => item.answer) },
    cookie: memberCookie
  });
  assert.equal(blockedPromotion.data.promotedTo, null);
  await request("/api/admin/users/2", {
    method: "PATCH",
    cookie: adminCookie,
    body: { action: "update", rank: 2, shootingPassed: true, warningDays: 0 }
  });
  const ready = await request("/api/promotion", { method: "POST", cookie: memberCookie });
  assert.equal(ready.response.status, 200);
  member = await request("/api/me", { cookie: memberCookie });
  assert.equal(member.data.user.rank, "Боец");
  assert.equal(member.data.user.points, 0);

  const finalAdminList = await request("/api/admin/users", { cookie: adminCookie });
  assert.equal(finalAdminList.data.users.filter((user) => user.isAdmin).length, 1);
  assert.equal(finalAdminList.data.users.find((user) => user.username === "RavenTest").isAdmin, false);

  const image = await fetch(`${origin}/images/charter.svg`);
  assert.equal(image.status, 200);
  assert.match(image.headers.get("content-type"), /image\/svg\+xml/);
});
