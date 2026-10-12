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

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Не удалось выполнить запрос");
  return data;
}

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
    ? "Создай аккаунт. Начальное звание выдаётся автоматически."
    : "Войди по нику и паролю или создай аккаунт участника.";
  authSubmit.innerHTML = creating ? "Создать аккаунт <span>↗</span>" : "Войти в штаб <span>↗</span>";
  document.querySelector("#auth-password").autocomplete = creating ? "new-password" : "current-password";
  authMessage.textContent = "";
}

authTabs.addEventListener("click", async (event) => {
  const tab = event.target.closest("[data-mode]");
  if (tab) setAuthMode(tab.dataset.mode);
});

authForm.addEventListener("submit", async (event) => {
  if (mode === "setup") return;
  event.preventDefault();
  authMessage.textContent = "";
  authSubmit.disabled = true;
  const username = authForm.elements.username.value.trim();
  const password = authForm.elements.password.value;
  try {
    if (mode === "password-change") {
      await api("/api/change-password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: authForm.elements.currentPassword.value,
          newPassword: password
        })
      });
      authForm.reset();
      await loadDashboard();
      showToast("Пароль обновлён. Учётная запись администратора защищена.");
      return;
    } else if (mode === "create") {
      await api("/api/accounts", { method: "POST", body: JSON.stringify({ username, password }) });
      await api("/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
      showToast("Аккаунт создан. Добро пожаловать в состав!");
    } else {
      await api("/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
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
  await api("/api/logout", { method: "POST" });
  currentUser = undefined;
  dashboard.classList.add("hidden");
  authScreen.classList.remove("hidden");
  logoutButton.classList.add("hidden");
});

function renderRankPath(user, ranks) {
  document.querySelector("#rank-path").innerHTML = ranks.map((rank, index) => {
    const state = index < user.rankIndex ? "done" : index === user.rankIndex ? "current" : "";
    return `<div class="path-item ${state}"><span class="path-marker"></span><span>${escapeHtml(rank)}</span></div>`;
  }).join("");
}

function renderProgress(user, ranks) {
  document.querySelector("#welcome-name").textContent = user.username;
  document.querySelector("#rank-chip-text").textContent = user.rank;
  document.querySelector("#current-rank").textContent = user.rank;
  document.querySelector("#rank-number").textContent = String(user.rankIndex + 1).padStart(2, "0");

  const currentThreshold = user.nextPoints;
  const score = user.points;
  const percent = currentThreshold ? Math.min(100, Math.round(score / currentThreshold * 100)) : 100;
  document.querySelector("#score-label").textContent = currentThreshold === null ? `${score} баллов` : `${score} / ${currentThreshold}`;
  document.querySelector("#progress-fill").style.width = `${percent}%`;
  const nextRank = ranks[user.rankIndex + 1];
  document.querySelector("#progress-caption").textContent = nextRank
    ? `Следующее звание: ${nextRank}. Баллы обнуляются после повышения.`
    : "Высшее звание в составе.";

  const chips = [];
  if (user.requirement) {
    const complete = user.requirement === "Сдача стрельбы" && user.shootingPassed;
    chips.push(`<span class="requirement-chip ${complete ? "complete" : ""}">${escapeHtml(user.requirement)}${complete ? " — пройдена" : ""}</span>`);
  }
  if (currentThreshold !== null && user.rankIndex > 0) chips.push(`<span class="requirement-chip">Тесты по темам состава</span>`);
  if (user.rankIndex === 9) {
    chips.push(`<span class="requirement-chip ${user.knowledgePassed ? "complete" : ""}">Проверка знаний${user.knowledgePassed ? " — пройдена" : ""}</span>`);
  }
  document.querySelector("#requirements").innerHTML = chips.join("");

  const warningBanner = document.querySelector("#warning-banner");
  warningBanner.classList.toggle("hidden", !user.activeWarning);
  warningBanner.textContent = user.activeWarning
    ? `Активный выговор блокирует повышение до ${new Date(user.warningUntil).toLocaleDateString("ru-RU")}.`
    : "";

  const promoteButton = document.querySelector("#promote-button");
  const manualApproval = user.rankIndex === 7 || user.rankIndex === 10;
  const firstRankManual = user.rankIndex === 0;
  promoteButton.classList.toggle("hidden", !user.promotion.eligible && !user.manualPromotionReady);
  promoteButton.textContent = manualApproval ? "Передать на утверждение ↗" : "Подтвердить повышение ↗";
  promoteButton.dataset.action = manualApproval || firstRankManual ? "request" : "promote";
  renderRankPath(user, ranks);
}

function renderQuizzes(quizzes, user) {
  document.querySelector("#tests-count").textContent = quizCountLabel(quizzes.length);
  const grid = document.querySelector("#quiz-grid");
  if (!quizzes.length) {
    grid.innerHTML = `<div class="quiz-empty">Сейчас тесты закрыты. Когда администратор назначит тебе следующее звание, откроется первое испытание. Обратись к руководству клана.</div>`;
    return;
  }
  grid.innerHTML = quizzes.map((quiz) => `
    <article class="quiz-card">
      <img class="quiz-image" src="${escapeHtml(quiz.image)}" alt="${escapeHtml(quiz.imageAlt)}">
      <span class="quiz-category">${escapeHtml(quiz.category)}</span>
      <h3>${escapeHtml(quiz.title)}</h3>
      <p>Задание по иллюстрации · 4 вопроса · до ${quiz.maxPoints} баллов</p>
      <div class="quiz-card-bottom">
        <span class="quiz-score">Лучший результат: ${quiz.bestPoints} / ${quiz.maxPoints}</span>
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
  quizDialog.showModal();
}

document.querySelector("#quiz-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const quiz = currentQuizzes.find((item) => item.id === form.dataset.quizId);
  const answers = quiz.questions.map((_, index) => {
    const selected = form.querySelector(`input[name="question-${index}"]:checked`);
    return selected ? Number(selected.value) : null;
  });
  const submit = document.querySelector("#quiz-submit");
  submit.disabled = true;
  try {
    const result = await api(`/api/quizzes/${encodeURIComponent(quiz.id)}/submit`, {
      method: "POST",
      body: JSON.stringify({ answers })
    });
    const message = result.promotedTo
      ? `Результат: ${result.points}/40. Ты получил звание «${result.promotedTo}»!`
      : `Результат: ${result.points}/40. Новых баллов: ${result.gained}.`;
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
    try {
      await api("/api/promotion", { method: "POST" });
      await loadDashboard();
      showToast("Запрос на повышение отправлен руководству.");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  try {
    const result = await api("/api/promotion", { method: "POST" });
    showToast(`Поздравляем! Новое звание: ${result.rank}. Баллы сброшены.`);
    await loadDashboard();
  } catch (error) {
    showToast(error.message);
  }
});

async function adminAction(id, action, data) {
  await api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ action, ...data }) });
  await renderMembers();
  await loadDashboard();
  showToast("Изменения сохранены");
}

async function renderMembers() {
  const container = document.querySelector("#member-list");
  const { ranks, users } = await api("/api/admin/users");
  const filter = document.querySelector("#member-search").value.trim().toLocaleLowerCase("ru");
  const filtered = users.filter((member) => member.username.toLocaleLowerCase("ru").includes(filter));
  if (!filtered.length) {
    container.innerHTML = `<div class="no-members">Участники не найдены.</div>`;
    return;
  }
  container.innerHTML = filtered.map((member) => {
    const warningDays = member.activeWarning
      ? Math.max(1, Math.ceil((member.warningUntil - Date.now()) / 86_400_000))
      : 0;
    return `
      <div class="member-row" data-member="${member.id}">
        <div class="member-identity"><strong>${escapeHtml(member.username)}${member.isAdmin ? " · админ" : ""}</strong><small>${escapeHtml(member.rank)} · ${member.points} баллов${member.activeWarning ? " · активный выговор" : ""}</small></div>
        <select class="member-rank" aria-label="Звание участника ${escapeHtml(member.username)}">${ranks.map((rank, index) => `<option value="${index}" ${index === member.rankIndex ? "selected" : ""}>${escapeHtml(rank)}</option>`).join("")}</select>
        <label title="Отметить сдачу стрельбы"><input class="member-shooting" type="checkbox" ${member.shootingPassed ? "checked" : ""}> Стрельба</label>
        <label title="Выговор в днях, 0 — снять"><input class="member-warning" type="number" min="0" max="365" value="${warningDays}" aria-label="Срок выговора"> дн.</label>
        <button class="save-member" type="button">Сохранить</button>
      </div>
      ${member.pendingPromotion && [7, 10].includes(member.rankIndex)
        ? `<button class="manual-promote" data-member-id="${member.id}" type="button">Утвердить повышение для ${escapeHtml(member.username)}</button>`
        : ""}`;
  }).join("");

  container.querySelectorAll(".member-row").forEach((row) => {
    row.querySelector(".save-member").addEventListener("click", async () => {
      const id = Number(row.dataset.member);
      const days = Number(row.querySelector(".member-warning").value);
      const rank = Number(row.querySelector(".member-rank").value);
      if (!Number.isInteger(days) || days < 0 || days > 365) return showToast("Срок выговора: от 0 до 365 дней");
      try {
        await adminAction(id, "update", {
          rank,
          shootingPassed: row.querySelector(".member-shooting").checked,
          warningDays: days
        });
      } catch (error) {
        showToast(error.message);
      }
    });
  });
  container.querySelectorAll(".manual-promote").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await adminAction(Number(button.dataset.memberId), "promote", {});
      } catch (error) {
        showToast(error.message);
      }
    });
  });
}

document.querySelector("#member-search").addEventListener("input", () => {
  renderMembers().catch((error) => showToast(error.message));
});

async function loadDashboard() {
  const data = await api("/api/me");
  currentUser = data.user;
  currentQuizzes = data.quizzes;
  if (data.user.mustChangePassword) {
    mode = "password-change";
    authScreen.classList.remove("hidden");
    dashboard.classList.add("hidden");
    logoutButton.classList.add("hidden");
    authTabs.classList.add("hidden");
    document.querySelector("#auth-username-field").classList.add("hidden");
    document.querySelector("#setup-key-field").classList.add("hidden");
    authForm.elements.username.required = false;
    authForm.elements.setupKey.required = false;
    document.querySelector("#current-password-field").classList.remove("hidden");
    authForm.elements.currentPassword.required = true;
    document.querySelector("#auth-password-label").textContent = "Новый постоянный пароль";
    authForm.elements.password.autocomplete = "new-password";
    authTitle.textContent = "Защити аккаунт";
    authKicker.textContent = "ТРЕБУЕТСЯ СМЕНА ПАРОЛЯ";
    authDescription.textContent = "Это временный пароль из README. Придумай новый пароль, прежде чем пользоваться правами администратора.";
    authSubmit.innerHTML = "Сохранить новый пароль <span>↗</span>";
    document.querySelector(".auth-note").classList.add("hidden");
    return;
  }
  authScreen.classList.add("hidden");
  dashboard.classList.remove("hidden");
  logoutButton.classList.remove("hidden");
  renderProgress(data.user, window.clanRanks);
  renderQuizzes(data.quizzes, data.user);
  const adminSection = document.querySelector("#admin-section");
  adminSection.classList.toggle("hidden", !data.user.isAdmin);
  if (data.user.isAdmin) await renderMembers();
}

async function initialise() {
  const status = await api("/api/status");
  if (status.setupNeeded) {
    setAuthMode("setup");
    authTabs.classList.add("hidden");
    document.querySelector("#setup-key-field").classList.remove("hidden");
    authForm.elements.setupKey.required = true;
    authForm.elements.username.value = "ClanBoss";
    authForm.elements.password.value = "ClanStart2026!";
    authForm.elements.password.autocomplete = "new-password";
    authKicker.textContent = "ПЕРВЫЙ ЗАПУСК";
    authTitle.textContent = "Создать штаб";
    authDescription.textContent = "Создай аккаунт администратора с начальными данными из README. После входа система попросит сразу сменить временный пароль.";
    authSubmit.innerHTML = "Создать администратора <span>↗</span>";
    authForm.addEventListener("submit", async (event) => {
      if (mode !== "setup") return;
      event.preventDefault();
      authMessage.textContent = "";
      authSubmit.disabled = true;
      try {
        await api("/api/setup", {
          method: "POST",
          body: JSON.stringify({
            username: authForm.elements.username.value.trim(),
            password: authForm.elements.password.value,
            setupKey: authForm.elements.setupKey.value
          })
        });
        authForm.reset();
        await loadDashboard();
      } catch (error) {
        authMessage.textContent = error.message;
      } finally {
        authSubmit.disabled = false;
      }
    });
  }

  try {
    await loadDashboard();
  } catch (error) {
    if (!status.setupNeeded) setAuthMode("login");
  }
}

window.clanRanks = ["Шпана", "Фраер", "Шестерка", "Боец", "Гопник", "Бык", "Торпеда", "Шнырь", "Блатной", "Бригадир", "Положенец", "Смотрящий"];
initialise().catch((error) => {
  authMessage.textContent = error.message;
});
