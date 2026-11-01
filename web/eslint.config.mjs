import { defineConfig, globalIgnores } from "eslint/config";
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

// eslint-config-next 16 ships flat configs, so they are imported directly;
// the FlatCompat shim it used to need cannot load them.
export default defineConfig([
  globalIgnores([".next/**", "node_modules/**", "next-env.d.ts"]),
  ...coreWebVitals,
  ...typescript,
  {
    // React Compiler rules that eslint-config-next 16 turns on. This app does
    // not use the compiler, and the flagged effects are deliberate after-mount
    // work (hydration guard, reading saved settings, syncing the URL), so they
    // are kept visible as warnings rather than failing CI. Revisit before
    // enabling the compiler.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
    },
  },
]);
