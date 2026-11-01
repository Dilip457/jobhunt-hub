import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkRefreshAttempt,
  clientIp,
  createAttemptLimiter,
  LOCKOUT_MS,
  UNKNOWN_CLIENT,
} from "../lib/refreshAuth";
import {
  passwordError,
  TOO_MANY_ATTEMPTS_CODE,
  tooManyAttemptsMessage,
  WRONG_PASSWORD_MESSAGE,
} from "../lib/refreshPrompt";

const env = { REFRESH_TOKEN: "s3cret", NODE_ENV: "production" };

function setup() {
  let time = 0;
  const limiter = createAttemptLimiter({ now: () => time });
  return {
    limiter,
    advance: (ms: number) => (time += ms),
    attempt: (key: string | null, ip = "1.1.1.1") => checkRefreshAttempt(key, ip, limiter, env),
  };
}

function failTimes(attempt: (key: string, ip?: string) => unknown, times: number, ip?: string) {
  for (let i = 0; i < times; i += 1) attempt("wrong", ip);
}

describe("wrong-password lockout", () => {
  it("locks an IP after 5 wrong passwords and refuses even the right one", () => {
    const { attempt } = setup();
    failTimes(attempt, 4);
    assert.deepEqual(attempt("s3cret"), { access: "ok" }, "4 failures are not enough to lock");

    failTimes(attempt, 5);
    assert.deepEqual(attempt("s3cret"), { access: "locked", minutesLeft: 15 });
    assert.deepEqual(attempt("wrong"), { access: "locked", minutesLeft: 15 });
    assert.deepEqual(attempt("s3cret", "2.2.2.2"), { access: "ok" }, "other IPs are not locked");
  });

  it("unlocks after 15 minutes and reports the minutes left meanwhile", () => {
    const { attempt, advance } = setup();
    failTimes(attempt, 5);
    advance(LOCKOUT_MS - 60_001);
    assert.deepEqual(attempt("s3cret"), { access: "locked", minutesLeft: 2 });
    advance(60_001);
    assert.deepEqual(attempt("s3cret"), { access: "ok" });
  });

  it("only counts failures inside the 15-minute window", () => {
    const { attempt, advance } = setup();
    failTimes(attempt, 4);
    advance(15 * 60_000);
    failTimes(attempt, 4);
    assert.deepEqual(attempt("s3cret"), { access: "ok" });
  });

  it("clears an IP's failures after the right password", () => {
    const { attempt, limiter } = setup();
    failTimes(attempt, 4);
    assert.deepEqual(attempt("s3cret"), { access: "ok" });
    assert.equal(limiter.size(), 0);
    failTimes(attempt, 4);
    assert.deepEqual(attempt("s3cret"), { access: "ok" }, "the count started again from zero");
  });

  it("does not count a request that sent no password", () => {
    const { attempt } = setup();
    for (let i = 0; i < 10; i += 1) assert.deepEqual(attempt(null), { access: "invalid" });
    assert.deepEqual(attempt("s3cret"), { access: "ok" });
  });

  it("locks everyone after more than 30 failures across all IPs", () => {
    const { attempt, advance } = setup();
    // 31 failures from 31 IPs: none of them reaches the per-IP limit.
    for (let i = 0; i < 30; i += 1) attempt("wrong", `10.0.0.${i}`);
    assert.deepEqual(attempt("s3cret", "9.9.9.9"), { access: "ok" }, "30 failures do not lock");
    attempt("wrong", "10.0.1.0");
    assert.deepEqual(attempt("s3cret", "9.9.9.9"), { access: "locked", minutesLeft: 15 });
    advance(LOCKOUT_MS);
    assert.deepEqual(attempt("s3cret", "9.9.9.9"), { access: "ok" });
  });

  it("leaves local development (open) and a missing token (disabled) alone", () => {
    const { limiter } = setup();
    const open = { NODE_ENV: "development" };
    for (let i = 0; i < 40; i += 1) {
      assert.deepEqual(checkRefreshAttempt("anything", "1.1.1.1", limiter, open), { access: "ok" });
    }
    const disabled = { NODE_ENV: "production" };
    assert.deepEqual(checkRefreshAttempt("anything", "1.1.1.1", limiter, disabled), { access: "disabled" });
    assert.equal(limiter.size(), 0, "nothing was recorded");
  });

  it("forgets expired entries and caps how many IPs it tracks", () => {
    let time = 0;
    const limiter = createAttemptLimiter({ now: () => time, maxClients: 3, globalMaxFailures: 1000 });
    for (let i = 0; i < 3; i += 1) limiter.recordFailure(`ip-${i}`);
    assert.equal(limiter.size(), 3);
    limiter.recordFailure("ip-3");
    assert.equal(limiter.size(), 3, "the least recently seen IP was dropped");

    time += 15 * 60_000;
    limiter.recordFailure("ip-4");
    assert.equal(limiter.size(), 1, "entries with no recent failures and no lock are pruned");

    for (let i = 0; i < 5; i += 1) limiter.recordFailure("locked");
    time += 15 * 60_000 - 1;
    limiter.recordFailure("other");
    assert.ok(limiter.lockedFor("locked") > 0, "a locked IP is kept until its lock ends");
  });
});

describe("clientIp", () => {
  const headers = (values: Record<string, string>) => new Headers(values);

  it("prefers Vercel's own header, then x-real-ip, then the first x-forwarded-for entry", () => {
    assert.equal(
      clientIp(headers({ "x-vercel-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2", "x-forwarded-for": "3.3.3.3" })),
      "1.1.1.1",
    );
    assert.equal(clientIp(headers({ "x-real-ip": "2.2.2.2", "x-forwarded-for": "3.3.3.3" })), "2.2.2.2");
    assert.equal(clientIp(headers({ "x-forwarded-for": " 3.3.3.3 , 10.0.0.1" })), "3.3.3.3");
  });

  it("falls back to one shared bucket without an IP", () => {
    assert.equal(clientIp(headers({})), UNKNOWN_CLIENT);
    assert.equal(clientIp(headers({ "x-forwarded-for": " , " })), UNKNOWN_CLIENT);
  });
});

describe("password dialog messages", () => {
  it("shows wrong password and lockout inline, and leaves other responses to the page", () => {
    assert.equal(passwordError(401, {}, true), WRONG_PASSWORD_MESSAGE);
    assert.equal(passwordError(401, {}, false), "Enter the password.");
    assert.equal(
      passwordError(429, { code: TOO_MANY_ATTEMPTS_CODE, minutesLeft: 12 }, true),
      "Too many wrong attempts. Try again in 12 minutes.",
    );
    assert.equal(passwordError(429, { error: "Recently refreshed." }, true), null, "cooldown is not a password error");
    assert.equal(passwordError(503, { code: "refresh_disabled" }, true), null);
    assert.equal(passwordError(202, {}, true), null);
  });

  it("words the minutes left", () => {
    assert.equal(tooManyAttemptsMessage(1), "Too many wrong attempts. Try again in 1 minute.");
    assert.equal(tooManyAttemptsMessage(0.2), "Too many wrong attempts. Try again in 1 minute.");
    assert.equal(tooManyAttemptsMessage(15), "Too many wrong attempts. Try again in 15 minutes.");
  });
});
