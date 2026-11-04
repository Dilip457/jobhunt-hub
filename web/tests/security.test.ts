import test from "node:test";
import assert from "node:assert/strict";
import { checkRefreshKey, clientIp } from "../lib/refreshAuth";
import { jobHref, safeHttpUrl, withSafeLinks } from "../lib/utils";
import { contentSecurityPolicy, securityHeaders } from "../securityHeaders.mjs";

test("safeHttpUrl accepts only absolute http(s) links without hidden credentials", () => {
  for (const good of ["https://www.naukri.com/job/1?x=a%20b", "http://example.com/a", "  https://example.com  "]) {
    assert.ok(safeHttpUrl(good), good);
  }
  for (const bad of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "//evil.example/x",
    "/relative",
    "https://www.naukri.com@evil.example/",
    "https://user:pw@example.com/",
    "https://exa mple.com/",
    "",
    null,
    undefined,
    42,
    { toString: () => "https://example.com" },
  ]) {
    assert.equal(safeHttpUrl(bad), null, String(bad));
  }
});

test("jobHref falls back to the listing link when the apply link is unsafe", () => {
  assert.equal(jobHref({ url: "https://a.test/", apply_url: "https://b.test/" }), "https://b.test/");
  assert.equal(jobHref({ url: "https://a.test/", apply_url: "javascript:alert(1)" }), "https://a.test/");
  assert.equal(jobHref({ url: "javascript:alert(1)" }), undefined);
});

test("withSafeLinks drops jobs with an unsafe listing link and strips an unsafe apply link", () => {
  const safe = { id: "1", url: "https://a.test/" };
  const badApply = { id: "2", url: "https://a.test/2", apply_url: "data:text/html,x" };
  const badUrl = { id: "3", url: "javascript:alert(1)" };
  const kept = withSafeLinks([safe, badApply, badUrl]);
  assert.deepEqual(kept.map((job) => job.id), ["1", "2"]);
  assert.equal(kept[0], safe);
  assert.equal("apply_url" in kept[1], false);
  assert.equal(badApply.apply_url, "data:text/html,x"); // the input is not mutated
});

test("checkRefreshKey accepts only the exact password, at any length", () => {
  const env = { REFRESH_TOKEN: "correct horse", NODE_ENV: "production" };
  assert.equal(checkRefreshKey("correct horse", env), "ok");
  for (const wrong of ["correct hors", "correct horse ", "", "x".repeat(5000), null, undefined]) {
    assert.equal(checkRefreshKey(wrong, env), "invalid");
  }
});

test("clientIp puts one IPv6 /64 in one lockout bucket", () => {
  const bucket = (ip: string) => clientIp(new Headers({ "x-real-ip": ip }));
  assert.equal(bucket("2001:db8:1:2:aaaa::1"), bucket("2001:db8:1:2:bbbb:cccc:dddd:eeee"));
  assert.equal(bucket("2001:db8:1:2::1"), bucket("2001:0DB8:0001:0002::ffff"));
  assert.notEqual(bucket("2001:db8:1:2::1"), bucket("2001:db8:1:3::1"));
  assert.equal(bucket("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(bucket("203.0.113.9"), "203.0.113.9");
});

test("the production headers block framing, foreign scripts and outbound requests", () => {
  const policy = contentSecurityPolicy(false);
  for (const rule of [
    "default-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ]) {
    assert.ok(policy.includes(rule), rule);
  }
  const directive = (name: string) => policy.split("; ").find((part) => part.startsWith(`${name} `)) ?? "";
  assert.ok(!directive("script-src").includes("http"));
  assert.ok(!directive("script-src").includes("unsafe-eval"));
  assert.ok(!directive("connect-src").includes("http"));
  assert.ok(!policy.includes("*"));

  const names = securityHeaders(false).map((header) => header.key);
  for (const name of [
    "Content-Security-Policy",
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
  ]) {
    assert.ok(names.includes(name), name);
  }
});
