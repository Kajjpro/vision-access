import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Model training/export assets — Python scripts and multi-hundred-MB
    // checkpoints (model/mobileclip_blt.ts is a 572 MB TorchScript archive,
    // not source; ESLint crashes trying to read it as text). Not app code.
    "model/**",
    // Build-time caches and raw API samples, never app source.
    ".cache/**",
    "probe-output/**",
    // Vendored third-party runtimes, regenerated/copied verbatim by
    // scripts/setup-tesseract.mjs and onnxruntime-web — not app source.
    "public/tesseract/**",
    "public/wasm/**",
  ]),
  {
    // eslint-plugin-react-hooks 7's Compiler-readiness rules (refs,
    // immutability, set-state-in-effect) flag the "latest ref" pattern —
    // writing `ref.current = value` during render so callbacks/effects read
    // a fresh value without re-subscribing. lib/ui/useGestureNav.ts and
    // useVoiceJourney.ts use it deliberately (see their inline comments) to
    // avoid rebuilding touch handlers or recognizers mid-gesture. This app
    // does not use the React Compiler, so the pattern is safe; downgrade to
    // warnings rather than rewriting tested, reasoned-through hook code.
    rules: {
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
