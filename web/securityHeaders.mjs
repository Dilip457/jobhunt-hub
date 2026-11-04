/**
 * Response headers for every route. Kept apart from next.config.mjs so a test
 * can read them.
 *
 * Next.js writes inline bootstrap scripts into its pre-rendered pages, so
 * script-src needs 'unsafe-inline' unless every page is rendered per request to
 * carry a nonce; these pages stay static. What this policy still does: no script
 * from another origin can load, nothing on the page can send data to another
 * origin (connect-src), no other site can frame it, and <base> and <form> cannot
 * be pointed elsewhere. The site renders no third-party HTML, so 'unsafe-inline'
 * has no injection path to exploit today.
 *
 * blob: and data: are for the 3D guide: GLTFLoader unpacks the textures embedded
 * in the GLB through them. 'unsafe-eval' and ws: are for `next dev` only.
 */
export function contentSecurityPolicy(isDev = false) {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' data: blob:${isDev ? " ws:" : ""}`,
    "worker-src 'self' blob:",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export function securityHeaders(isDev = false) {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(isDev) },
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    // Job links open other sites: they learn at most that the visit came from here.
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  ];
}
