export {
  DC_HTML_VERSION,
  MAX_ARTIFACT_BYTES,
  DESIGN_TEMPLATES,
  isDesignTemplate,
  parseHeader,
  parseMetaBlock,
  writeMetaBlock,
  validateDcHtml,
  extractTokenRefs,
  countSlides,
} from "./dc-html.js";
export type { DesignTemplate, DcHtmlHeader, DcHtmlMetaBlock, DcHtmlValidation } from "./dc-html.js";
export { computeVdid, applyVdids, findByVdid } from "./vdid.js";
export type { VdidReport } from "./vdid.js";
export { listTemplates, readTemplateStarter } from "./templates.js";
export type { TemplateStarter } from "./templates.js";
export { loadDesignSystem, parseDesignTokens } from "./design-system.js";
export type { DesignSystem, DesignSystemSource } from "./design-system.js";
export { marpToDcHtml, dcHtmlToMarp } from "./marp.js";
export type { MarpConversion } from "./marp.js";
export { applyElementPatches } from "./patch.js";
export type { PatchResult } from "./patch.js";
export { dcHtmlToSlidesChunks, slidesToDcHtml } from "./gslides.js";
export type {
  GslidesExport,
  GslidesImport,
  MinimalPresentation,
  MinimalPage,
  MinimalPageElement,
  SlidesRequestChunk,
} from "./gslides.js";
export { staticRenderChecks, hidesSectionsByDefault } from "./render-checks.js";
