import test from "node:test";
import assert from "node:assert/strict";
import { availableQuizzes, canRequestManualPromotion, getPromotion, getQuizPoints, QUIZZES, RANKS } from "./domain.mjs";

test("new members start with no tests; each assigned rank opens another test", () => {
  assert.equal(availableQuizzes(0).length, 0);
  assert.equal(availableQuizzes(1).length, 1);
  assert.equal(availableQuizzes(5).length, 5);
  assert.equal(availableQuizzes(10).length, 10);
  assert.equal(availableQuizzes(11).length, 11);
});

test("promotion thresholds match the clan rank ladder", () => {
  assert.deepEqual(RANKS.map((rank) => rank.nextPoints), [15, 40, 75, 110, 100, 165, 200, 235, 300, 400, null, null]);
  assert.equal(getPromotion(1, 39).eligible, false);
  assert.equal(getPromotion(1, 40).eligible, true);
});

test("shooting sign-off and an active warning gate promotion", () => {
  assert.equal(getPromotion(2, 75, { shootingPassed: false }).eligible, false);
  assert.equal(getPromotion(2, 75, { shootingPassed: true }).eligible, true);
  assert.equal(getPromotion(2, 75, { shootingPassed: true, activeWarning: true }).eligible, false);
});

test("manual leadership promotions are never automatic", () => {
  assert.equal(getPromotion(0, 100).eligible, false);
  assert.equal(getPromotion(7, 235).eligible, false);
  assert.equal(getPromotion(10, 1000).eligible, false);
  assert.equal(canRequestManualPromotion(7, 234), false);
  assert.equal(canRequestManualPromotion(7, 235), true);
  assert.equal(canRequestManualPromotion(7, 235, { activeWarning: true }), false);
  assert.equal(canRequestManualPromotion(10, 0), true);
});

test("brigadier promotion also requires the knowledge exam", () => {
  assert.equal(availableQuizzes(9).some((quiz) => quiz.id === "leadership"), true);
  assert.equal(getPromotion(9, 400).eligible, false);
  assert.equal(getPromotion(9, 400, { knowledgePassed: true }).eligible, true);
});

test("each rank test has its own illustrated set of questions", () => {
  assert.equal(new Set(QUIZZES.map((quiz) => quiz.image)).size, QUIZZES.length);
  assert.equal(new Set(QUIZZES.map((quiz) => quiz.questions.map((item) => item.prompt).join("|"))).size, QUIZZES.length);
  assert.equal(QUIZZES.every((quiz) => quiz.imageAlt && quiz.questions.length === 4), true);
  assert.equal(QUIZZES.every((quiz) => quiz.questions.some((item) => item.answer !== 0)), true);
  assert.equal(QUIZZES.every((quiz) => new Set(quiz.questions.map((item) => item.answer)).size > 1), true);
});

test("quiz scoring awards ten points per correct answer", () => {
  const quiz = QUIZZES[0];
  assert.equal(getQuizPoints(quiz, quiz.questions.map((item) => item.answer)), 40);
  assert.equal(getQuizPoints(quiz, quiz.questions.map((item) => (item.answer + 1) % 3)), 0);
});
