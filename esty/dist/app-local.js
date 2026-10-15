const authScreen = document.querySelector("#auth-screen");
const dashboard = document.querySelector("#dashboard");
const authForm = document.querySelector("#auth-form");
const authMessage = document.querySelector("#auth-message");
const authTabs = document.querySelector("#auth-tabs");
const authTitle = document.querySelector("#auth-title");
const authDescription = document.querySelector("#auth-description");
const authKicker = document.querySelector("#auth-kicker");
const authSubmit = document.querySelector("#auth-submit");
const logoutButton = document.querySelector("#logout-button");
const quizDialog = document.querySelector("#quiz-dialog");
let mode = "login";
let currentUser;
let currentQuizzes = [];
let toastTimer;
let quizTimer;
let quizTimeLeft = 480;

const PRESET_ADMINS = [
  { username: "admin", password: "admin123" },
  { username: "moderator", password: "moderator123" },
  { username: "leader", password: "leader123" }
];

const RANK_SYSTEM_VERSION = 3;
const RANKS = window.SSO_RANKS;
const QUIZZES = window.SSO_QUIZZES;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function migrateUser(user) {
  if (user.rankSystemVersion !== RANK_SYSTEM_VERSION) {
    const oldRank = Math.max(0, Number(user.rank) || 0);
    user.rank = user.rankSystemVersion === 2
      ? Math.min(RANKS.length - 1, oldRank)
      : Math.round(Math.min(11, oldRank) / 11 * (RANKS.length - 1));
    user.points = 0;
    user.quizBest = {};
    user.knowledgePassed = false;
    user.rankSystemVersion = RANK_SYSTEM_VERSION;
  }
  user.rank = Number.isInteger(user.rank) ? Math.min(RANKS.length - 1, Math.max(0, user.rank)) : 0;
  user.points = Number.isFinite(user.points) ? Math.max(0, user.points) : 0;
  user.quizBest = user.quizBest && typeof user.quizBest === "object" ? user.quizBest : {};
  user.readinessChecklist = user.readinessChecklist && typeof user.readinessChecklist === "object"
    ? user.readinessChecklist
    : {};
  user.promotionRequested = Boolean(user.promotionRequested);
  return user;
}

function readUsers() {
  const users = JSON.parse(localStorage.getItem("clan_users") || "[]");
  if (!Array.isArray(users)) throw new Error("Не удалось загрузить список участников");
  let changed = false;
  users.forEach((user) => {
    if (user.rankSystemVersion !== RANK_SYSTEM_VERSION) changed = true;
    migrateUser(user);
  });
  if (changed) localStorage.setItem("clan_users", JSON.stringify(users));
  return users;
}

function saveCurrentUser() {
  const users = readUsers();
  const userIndex = users.findIndex((user) => user.id === currentUser.id);
  if (userIndex !== -1) {
    users[userIndex] = currentUser;
    localStorage.setItem("clan_users", JSON.stringify(users));
  }
  localStorage.setItem("clan_current", JSON.stringify(currentUser));
}

function validateRankTests() {
  const testsByRank = new Map();
  const testIds = new Set();
  for (const quiz of QUIZZES) {
    if (!Number.isInteger(quiz.requiredRank) || quiz.requiredRank < 0 || quiz.requiredRank >= RANKS.length) {
      throw new Error(`Неправильное звание для теста «${quiz.title}»`);
    }
    if (!quiz.id || testIds.has(quiz.id)) {
      throw new Error(`У теста «${quiz.title}» отсутствует уникальный идентификатор`);
    }
    testIds.add(quiz.id);
    const rankTests = testsByRank.get(quiz.requiredRank) || [];
    rankTests.push(quiz);
    testsByRank.set(quiz.requiredRank, rankTests);
    if (!Array.isArray(quiz.questions) || quiz.questions.length < 3) {
      throw new Error(`В тесте «${quiz.title}» должно быть не меньше трёх вопросов`);
    }
  }
  const doubleTestRanks = new Set([3, 4, 7, 9, 10, 13]);
  for (let rank = 0; rank < RANKS.length; rank++) {
    const rankTests = testsByRank.get(rank) || [];
    const expectedCount = doubleTestRanks.has(rank) ? 2 : 1;
    if (rankTests.length !== expectedCount) {
      throw new Error(`Для звания «${RANKS[rank].name}» назначено ${rankTests.length} тестов вместо ${expectedCount}`);
    }
    if (rank >= 5 && !rankTests.some((quiz) => quiz.questions.length >= 5)) {
      throw new Error(`Для звания «${RANKS[rank].name}» нужен тест минимум с пятью вопросами`);
    }
  }
  if (new Set(QUIZZES.map((quiz) => quiz.questions.length)).size < 3) {
    throw new Error("Количество вопросов в тестах должно различаться");
  }
}

function quizCountLabel(count) {
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;
  const noun = lastTwoDigits >= 11 && lastTwoDigits <= 14
    ? "тестов"
    : lastDigit === 1
      ? "тест открыт"
      : lastDigit >= 2 && lastDigit <= 4
        ? "теста открыто"
        : "тестов открыто";
  return `${count} ${noun}`;
}

function setAuthMode(nextMode) {
  mode = nextMode;
  const creating = mode === "create";
  authTabs.querySelectorAll(".auth-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.mode === mode));
  authTitle.textContent = creating ? "Аккаунт участника" : "Вход в штаб";
  authKicker.textContent = creating ? "НОВЫЙ УЧАСТНИК" : "ДОБРО ПОЖАЛОВАТЬ";
  authDescription.textContent = creating
    ? "Создай аккаунт. Администратор назначит начальное звание."
    : "Войди по нику и паролю или создай аккаунт участника.";
  authSubmit.innerHTML = creating ? "Создать аккаунт <span>↗</span>" : "Войти в штаб <span>↗</span>";
  document.querySelector("#auth-password").autocomplete = creating ? "new-password" : "current-password";
  authMessage.textContent = "";
}

authTabs.addEventListener("click", async (event) => {
  const tab = event.target.closest("[data-mode]");
  if (tab) setAuthMode(tab.dataset.mode);
});

document.querySelector("#toggle-password").addEventListener("click", () => {
  const passwordInput = document.querySelector("#auth-password");
  const toggleButton = document.querySelector("#toggle-password");
  if (passwordInput.type === "password") {
    passwordInput.type = "text";
    toggleButton.textContent = "🙈";
  } else {
    passwordInput.type = "password";
    toggleButton.textContent = "👁";
  }
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authMessage.textContent = "";
  authSubmit.disabled = true;
  const username = authForm.elements.username.value.trim();
  const password = authForm.elements.password.value;
  
  try {
    if (mode === "create") {
      const users = readUsers();
      if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        throw new Error("Этот ник уже занят");
      }
      const newUser = {
        id: Date.now(),
        username,
        password,
        rank: 0,
        rankSystemVersion: RANK_SYSTEM_VERSION,
        points: 0,
        isAdmin: false,
        knowledgePassed: false,
        warningUntil: null,
        quizBest: {},
        readinessChecklist: {},
        promotionRequested: false,
        createdAt: Date.now()
      };
      users.push(newUser);
      localStorage.setItem("clan_users", JSON.stringify(users));
      localStorage.setItem("clan_current", JSON.stringify(newUser));
      currentUser = newUser;
      showToast("Аккаунт создан. Добро пожаловать в состав!");
    } else {
      const users = readUsers();
      let user = users.find(u => u.username.toLowerCase() === username.toLowerCase() && u.password === password);
      if (!user && !users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
        const presetAdmin = PRESET_ADMINS.find(admin =>
          admin.username.toLowerCase() === username.toLowerCase() && admin.password === password
        );
        if (presetAdmin) {
          user = {
            id: Date.now(),
            username: presetAdmin.username,
            password: presetAdmin.password,
            rank: 0,
            rankSystemVersion: RANK_SYSTEM_VERSION,
            points: 0,
            isAdmin: true,
            knowledgePassed: false,
            warningUntil: null,
            quizBest: {},
            readinessChecklist: {},
            promotionRequested: false,
            createdAt: Date.now()
          };
          users.push(user);
          localStorage.setItem("clan_users", JSON.stringify(users));
        }
      }
      if (!user) {
        throw new Error("Неверный ник или пароль");
      }
      localStorage.setItem("clan_current", JSON.stringify(user));
      currentUser = user;
    }
    authForm.reset();
    await loadDashboard();
  } catch (error) {
    authMessage.textContent = error.message;
  } finally {
    authSubmit.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  localStorage.removeItem("clan_current");
  currentUser = undefined;
  setAuthMode("login");
  dashboard.classList.add("hidden");
  authScreen.classList.remove("hidden");
  logoutButton.classList.add("hidden");
});

function renderRankPath(user, ranks) {
  document.querySelector("#rank-path").innerHTML = ranks.map((rank, index) => {
    const state = index < user.rank ? "done" : index === user.rank ? "current" : "";
    return `<div class="path-item ${state}"><span class="path-marker"></span><span>${escapeHtml(rank)}</span></div>`;
  }).join("");
}

function getRankQuizzes(rank) {
  return QUIZZES.filter((quiz) => quiz.requiredRank === rank);
}

function areRankQuizzesComplete(rank, quizBest) {
  return getRankQuizzes(rank).every((quiz) => Object.prototype.hasOwnProperty.call(quizBest, quiz.id));
}

function getPromotion(rank, score, checks = {}) {
  const current = RANKS[rank];
  const next = RANKS[rank + 1];
  if (checks.activeWarning) {
    return { eligible: false, reason: "Сначала нужно закрыть активный выговор" };
  }
  if (!checks.testsComplete) {
    return { eligible: false, reason: "Сначала пройди все тесты текущего звания" };
  }
  if (!current || !next || current.manual || current.nextPoints === null) {
    return { eligible: false, reason: current?.requirement ?? "Максимальное звание" };
  }
  if (score < current.nextPoints) {
    return { eligible: false, reason: `Нужно набрать ещё ${current.nextPoints - score} баллов` };
  }
  if (current.adminCheck && !checks[current.adminCheck]) {
    return { eligible: false, reason: current.requirement };
  }
  if (current.knowledgeCheck && !checks.knowledgePassed) {
    return { eligible: false, reason: current.requirement };
  }
  return { eligible: true, reason: current.requirement ?? null };
}

function canRequestManualPromotion(rank, score, checks = {}) {
  const current = RANKS[rank];
  if (rank === 0 || !current?.manual || checks.activeWarning || !checks.testsComplete) return false;
  return current.nextPoints === null || score >= current.nextPoints;
}

function renderProgress(user, ranks) {
  document.querySelector("#welcome-name").textContent = user.username;
  document.querySelector("#rank-chip-text").textContent = RANKS[user.rank].name;
  document.querySelector("#current-rank").textContent = RANKS[user.rank].name;
  document.querySelector("#rank-number").textContent = String(user.rank + 1).padStart(2, "0");

  const currentThreshold = RANKS[user.rank].nextPoints;
  const score = user.points;
  const percent = currentThreshold ? Math.min(100, Math.round(score / currentThreshold * 100)) : 100;
  document.querySelector("#score-label").textContent = currentThreshold === null
    ? (RANKS[user.rank].manual ? "по назначению" : `${score} баллов`)
    : `${score} / ${currentThreshold}`;
  document.querySelector("#progress-fill").style.width = `${percent}%`;
  const nextRank = RANKS[user.rank + 1];
  document.querySelector("#progress-caption").textContent = nextRank
    ? `Следующее звание: ${nextRank.name}. Баллы обнуляются после повышения.`
    : "Высшее звание в составе.";

  const checks = {
    knowledgePassed: Boolean(user.knowledgePassed),
    activeWarning: user.warningUntil !== null && user.warningUntil > Date.now(),
    testsComplete: areRankQuizzesComplete(user.rank, user.quizBest)
  };

  const chips = [];
  if (RANKS[user.rank].requirement) {
    const complete = RANKS[user.rank].knowledgeCheck && user.knowledgePassed;
    chips.push(`<span class="requirement-chip ${complete ? "complete" : ""}">${escapeHtml(RANKS[user.rank].requirement)}${complete ? " — пройдена" : ""}</span>`);
  }
  const rankQuizzes = getRankQuizzes(user.rank);
  const completedTests = rankQuizzes.filter((quiz) => Object.prototype.hasOwnProperty.call(user.quizBest, quiz.id)).length;
  if (rankQuizzes.length) {
    chips.push(`<span class="requirement-chip ${checks.testsComplete ? "complete" : ""}">Тесты текущего звания: ${completedTests}/${rankQuizzes.length}</span>`);
  }
  document.querySelector("#requirements").innerHTML = chips.join("");

  const warningBanner = document.querySelector("#warning-banner");
  warningBanner.classList.toggle("hidden", !checks.activeWarning);
  warningBanner.textContent = checks.activeWarning
    ? `Активный выговор блокирует повышение до ${new Date(user.warningUntil).toLocaleDateString("ru-RU")}.`
    : "";

  const promotion = getPromotion(user.rank, user.points, checks);
  const manualPromotionReady = canRequestManualPromotion(user.rank, user.points, checks);
  const promoteButton = document.querySelector("#promote-button");
  promoteButton.classList.toggle("hidden", !promotion.eligible && !manualPromotionReady);
  promoteButton.disabled = Boolean(user.promotionRequested);
  promoteButton.textContent = user.promotionRequested
    ? "Запрос отправлен ✓"
    : RANKS[user.rank].manual ? "Запросить повышение ↗" : "Подтвердить повышение ↗";
  promoteButton.dataset.action = RANKS[user.rank].manual ? "request" : "promote";
  renderRankPath(user, ranks);
}

function renderReadinessChecklist(user) {
  const checklist = document.querySelector("#readiness-checklist");
  const items = [...checklist.querySelectorAll("[data-check]")];
  items.forEach((item) => {
    item.checked = Boolean(user.readinessChecklist[item.dataset.check]);
  });
  const completed = items.filter((item) => item.checked).length;
  document.querySelector("#readiness-progress").textContent = `${completed} из ${items.length} отмечено`;
}

document.querySelector("#readiness-checklist").addEventListener("change", (event) => {
  const item = event.target.closest("[data-check]");
  if (!item || !currentUser) return;
  currentUser.readinessChecklist[item.dataset.check] = item.checked;
  try {
    saveCurrentUser();
    renderReadinessChecklist(currentUser);
  } catch (error) {
    item.checked = !item.checked;
    showToast(error.message);
  }
});

document.querySelector("#readiness-reset").addEventListener("click", () => {
  if (!currentUser) return;
  currentUser.readinessChecklist = {};
  try {
    saveCurrentUser();
    renderReadinessChecklist(currentUser);
  } catch (error) {
    showToast(error.message);
  }
});

function renderQuizzes(quizzes, user) {
  document.querySelector("#tests-count").textContent = quizCountLabel(quizzes.length);
  const grid = document.querySelector("#quiz-grid");
  grid.parentElement.querySelector(".quiz-hint")?.remove();
  if (!quizzes.length) {
    grid.innerHTML = `<div class="quiz-empty">Для текущего звания испытание не назначено. Обратись к администратору состава.</div>`;
    return;
  }
  const remaining = quizzes.length - quizzes.filter((quiz) => Object.prototype.hasOwnProperty.call(user.quizBest, quiz.id)).length;
  if (quizzes.length > 1 && remaining > 0) {
    const hint = document.createElement("p");
    hint.className = "muted small quiz-hint";
    hint.textContent = `Для повышения пройди оба испытания этого звания. Осталось: ${remaining}.`;
    grid.before(hint);
  }
  grid.innerHTML = quizzes.map((quiz) => `
    <article class="quiz-card">
      <img class="quiz-image" src="${escapeHtml(quiz.image)}" alt="${escapeHtml(quiz.imageAlt)}">
      <span class="quiz-category">${escapeHtml(quiz.category)}</span>
      <h3>${escapeHtml(quiz.title)}</h3>
      <p>Ситуационные вопросы · ${quiz.questions.length} вопросов · до ${quiz.questions.length * 10} баллов</p>
      <div class="quiz-card-bottom">
        <span class="quiz-score">Лучший результат: ${(user.quizBest[quiz.id] || 0)} / ${quiz.questions.length * 10}</span>
        <button class="quiz-open" type="button" data-quiz="${escapeHtml(quiz.id)}">Пройти ↗</button>
      </div>
    </article>`).join("");
  grid.querySelectorAll("[data-quiz]").forEach((button) => {
    button.addEventListener("click", () => openQuiz(quizzes.find((quiz) => quiz.id === button.dataset.quiz)));
  });
}

function openQuiz(quiz) {
  if (!quiz) return;
  document.querySelector("#quiz-category").textContent = quiz.category;
  document.querySelector("#quiz-title").textContent = quiz.title;
  document.querySelector("#quiz-message").textContent = "";
  document.querySelector("#quiz-image").src = quiz.image;
  document.querySelector("#quiz-image").alt = quiz.imageAlt;
  document.querySelector("#quiz-questions").innerHTML = quiz.questions.map((item, index) => `
    <fieldset class="question-block">
      <legend>${index + 1}. ${escapeHtml(item.prompt)}</legend>
      ${item.options.map((option, optionIndex) => `
        <label class="answer-option"><input type="radio" name="question-${index}" value="${optionIndex}" required><span>${escapeHtml(option)}</span></label>
      `).join("")}
    </fieldset>`).join("");
  document.querySelector("#quiz-form").dataset.quizId = quiz.id;
  
  quizTimeLeft = 480;
  document.querySelector("#timer-seconds").textContent = quizTimeLeft;
  document.querySelector("#quiz-timer").classList.remove("warning", "danger");
  
  if (quizTimer) clearInterval(quizTimer);
  quizTimer = setInterval(() => {
    quizTimeLeft--;
    document.querySelector("#timer-seconds").textContent = quizTimeLeft;
    
    if (quizTimeLeft <= 60) {
      document.querySelector("#quiz-timer").classList.add("warning");
    }
    if (quizTimeLeft <= 30) {
      document.querySelector("#quiz-timer").classList.remove("warning");
      document.querySelector("#quiz-timer").classList.add("danger");
    }
    
    if (quizTimeLeft <= 0) {
      clearInterval(quizTimer);
      quizDialog.close();
      showToast("Время вышло! Тест не засчитан.");
    }
  }, 1000);
  
  quizDialog.showModal();
}

document.querySelector("#quiz-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearInterval(quizTimer);
  const form = event.currentTarget;
  const quiz = currentQuizzes.find((item) => item.id === form.dataset.quizId);
  if (!quiz || quiz.requiredRank !== currentUser.rank) {
    clearInterval(quizTimer);
    quizDialog.close();
    showToast("Это испытание относится к другому званию. Открой актуальный тест из кабинета.");
    await loadDashboard();
    return;
  }
  const answers = quiz.questions.map((_, index) => {
    const selected = form.querySelector(`input[name="question-${index}"]:checked`);
    return selected ? Number(selected.value) : null;
  });
  const submit = document.querySelector("#quiz-submit");
  submit.disabled = true;
  try {
    const points = quiz.questions.reduce((sum, item, index) => sum + (answers[index] === item.answer ? 10 : 0), 0);
    const best = currentUser.quizBest[quiz.id] || 0;
    const gained = Math.max(0, points - best);
    
    currentUser.quizBest[quiz.id] = Math.max(best, points);
    currentUser.points += gained;
    
    if (quiz.id === "leadership" && points >= 30) {
      currentUser.knowledgePassed = true;
    }

    saveCurrentUser();

    const checks = {
      knowledgePassed: Boolean(currentUser.knowledgePassed),
      activeWarning: currentUser.warningUntil !== null && currentUser.warningUntil > Date.now(),
      testsComplete: areRankQuizzesComplete(currentUser.rank, currentUser.quizBest)
    };
    const promotion = getPromotion(currentUser.rank, currentUser.points, checks);
    let promotedTo = null;
    if (promotion.eligible && !RANKS[currentUser.rank].manual && currentUser.rank > 0) {
      promotedTo = RANKS[currentUser.rank + 1].name;
      currentUser.rank += 1;
      currentUser.points = 0;
      currentUser.quizBest = {};
      
      saveCurrentUser();
    }

    const message = promotedTo
      ? `Результат: ${points}/${quiz.questions.length * 10}. Ты получил звание «${promotedTo}»!`
      : `Результат: ${points}/${quiz.questions.length * 10}. Новых баллов: ${gained}.`;
    quizDialog.close();
    showToast(message);
    await loadDashboard();
  } catch (error) {
    document.querySelector("#quiz-message").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#promote-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (button.dataset.action === "request") {
    currentUser.promotionRequested = true;
    try {
      saveCurrentUser();
      await loadDashboard();
      showToast("Запрос сохранён. Передай администратору свой ник для проверки.");
    } catch (error) {
      currentUser.promotionRequested = false;
      showToast(error.message);
    }
    return;
  }
  try {
    const checks = {
      knowledgePassed: Boolean(currentUser.knowledgePassed),
      activeWarning: currentUser.warningUntil !== null && currentUser.warningUntil > Date.now(),
      testsComplete: areRankQuizzesComplete(currentUser.rank, currentUser.quizBest)
    };
    const promotion = getPromotion(currentUser.rank, currentUser.points, checks);
    if (!promotion.eligible) {
      showToast(promotion.reason);
      return;
    }
    currentUser.rank += 1;
    currentUser.points = 0;
    currentUser.quizBest = {};
    currentUser.promotionRequested = false;
    saveCurrentUser();
    
    showToast(`Поздравляем! Новое звание: ${RANKS[currentUser.rank].name}. Баллы сброшены.`);
    await loadDashboard();
  } catch (error) {
    showToast(error.message);
  }
});

async function renderMembers() {
  const container = document.querySelector("#member-list");
  const users = readUsers();
  const filter = document.querySelector("#member-search").value.trim().toLocaleLowerCase("ru");
  const filtered = users.filter((member) => member.username.toLocaleLowerCase("ru").includes(filter));
  if (!filtered.length) {
    container.innerHTML = `<div class="no-members">Участники не найдены.</div>`;
    return;
  }
  container.innerHTML = filtered.map((member) => {
    const warningDays = member.warningUntil !== null
      ? Math.max(1, Math.ceil((member.warningUntil - Date.now()) / 86_400_000))
      : 0;
    return `
      <div class="member-row" data-member="${member.id}">
        <div class="member-identity"><strong>${escapeHtml(member.username)}${member.isAdmin ? " · админ" : ""}</strong><small>${escapeHtml(RANKS[member.rank].name)} · ${member.points} баллов${member.warningUntil !== null && member.warningUntil > Date.now() ? " · активный выговор" : ""}${member.promotionRequested ? " · запрос на повышение" : ""}</small></div>
        <select class="member-rank" aria-label="Звание участника ${escapeHtml(member.username)}">${RANKS.map((rank, index) => `<option value="${index}" ${index === member.rank ? "selected" : ""}>${escapeHtml(rank.name)}</option>`).join("")}</select>
        <label title="Отметить итоговый тест"><input class="member-knowledge" type="checkbox" ${member.knowledgePassed ? "checked" : ""}> Итоговый тест</label>
        <label title="Выговор в днях, 0 — снять"><input class="member-warning" type="number" min="0" max="365" value="${warningDays}" aria-label="Срок выговора"> дн.</label>
        <button class="show-password" type="button" data-password="${escapeHtml(member.password)}">👁</button>
        <button class="save-member" type="button">Сохранить</button>
      </div>`;
  }).join("");

  container.querySelectorAll(".member-row").forEach((row) => {
    row.querySelector(".save-member").addEventListener("click", async () => {
      const id = Number(row.dataset.member);
      const days = Number(row.querySelector(".member-warning").value);
      const rank = Number(row.querySelector(".member-rank").value);
      if (!Number.isInteger(days) || days < 0 || days > 365) return showToast("Срок выговора: от 0 до 365 дней");
      try {
        const users = readUsers();
        const userIndex = users.findIndex(u => u.id === id);
        if (userIndex !== -1) {
          const previousRank = users[userIndex].rank;
          users[userIndex].rank = rank;
          users[userIndex].knowledgePassed = row.querySelector(".member-knowledge").checked;
          users[userIndex].warningUntil = days === 0 ? null : Date.now() + days * 24 * 60 * 60 * 1000;
          if (previousRank !== rank) {
            users[userIndex].points = 0;
            users[userIndex].quizBest = {};
            users[userIndex].knowledgePassed = false;
            users[userIndex].promotionRequested = false;
          }
          localStorage.setItem("clan_users", JSON.stringify(users));
          if (currentUser.id === id) {
            currentUser = users[userIndex];
            localStorage.setItem("clan_current", JSON.stringify(currentUser));
          }
        }
        await renderMembers();
        await loadDashboard();
        showToast("Изменения сохранены");
      } catch (error) {
        showToast(error.message);
      }
    });
    
    row.querySelector(".show-password").addEventListener("click", () => {
      const password = row.querySelector(".show-password").dataset.password;
      showToast(`Пароль: ${password}`);
    });
  });
}

document.querySelector("#member-search").addEventListener("input", () => {
  renderMembers().catch((error) => showToast(error.message));
});

async function loadDashboard() {
  const saved = localStorage.getItem("clan_current");
  if (!saved) {
    authScreen.classList.remove("hidden");
    dashboard.classList.add("hidden");
    logoutButton.classList.add("hidden");
    return;
  }
  
  currentUser = JSON.parse(saved);
  currentUser = migrateUser(currentUser);
  const users = readUsers();
  const savedUser = users.find((user) => user.id === currentUser.id);
  if (savedUser) currentUser = savedUser;
  localStorage.setItem("clan_current", JSON.stringify(currentUser));
  currentQuizzes = QUIZZES.filter(quiz => quiz.requiredRank === currentUser.rank);
  
  authScreen.classList.add("hidden");
  dashboard.classList.remove("hidden");
  logoutButton.classList.remove("hidden");
  renderProgress(currentUser, RANKS.map(r => r.name));
  renderReadinessChecklist(currentUser);
  renderQuizzes(currentQuizzes, currentUser);
  
  const adminSection = document.querySelector("#admin-section");
  adminSection.classList.toggle("hidden", !currentUser.isAdmin);
  if (currentUser.isAdmin) await renderMembers();
}

async function initialise() {
  validateRankTests();
  readUsers();
  authTabs.classList.remove("hidden");
  setAuthMode("login");

  const saved = localStorage.getItem("clan_current");
  if (saved) {
    await loadDashboard();
    return;
  }
  
  authScreen.classList.remove("hidden");
  dashboard.classList.add("hidden");
  logoutButton.classList.add("hidden");
}

initialise().catch((error) => {
  authMessage.textContent = error.message;
});
