/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_BUILD_COMMIT_HASH?: string;
  readonly VITE_BUILD_VERSION_TAG?: string;
  readonly VITE_DEPLOY_ENVIRONMENT?: string;
  readonly VITE_FARO_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
