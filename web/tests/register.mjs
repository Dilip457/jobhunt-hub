// Lets `node --test` load the lib/ modules as they are written for the
// bundler: Node strips the TypeScript types itself, and this hook resolves
// extensionless relative imports ("./ttlCache") to their .ts file.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
