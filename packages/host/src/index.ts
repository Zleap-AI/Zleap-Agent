export * from '@zleap/agent';

export { DEFAULT_DATABASE_URL, DEFAULT_WEB_PORT } from './constants.js';
export * from './config.js';
export * from './sessionPrefs.js';
export {
  bundledServeEnv,
  githubLatestReleaseApiUrl,
  githubRepoSlug,
  healthLivePath,
  healthLiveUrl,
  installManifestUrl,
  installScriptUrl,
  loadDistributionConfig,
  normalizeVersion,
  onboardingPath,
  onboardingUrl,
  releaseDownloadBaseUrl,
  resetDistributionConfigCache,
  appArchiveName,
  appDownloadUrl,
  postgresBundleArchiveName,
  postgresDownloadUrl,
  updaterManifestUrl,
  webBaseUrl,
  webPort,
  type DistributionConfig,
} from './distribution.js';
export { runDevGateway, runDevWeb, runDevWorker, type DevOptions } from './dev.js';
export { loadServeEnvFiles } from './dotenv.js';
export { buildServeEnv, nodeExecPath, webUrl } from './env.js';
export {
  appChecks,
  compareVersions,
  compareVersions as compareAppVersions,
  isAppComplete,
  readAppManifest,
  type AppManifest,
  type AppTarget,
} from './app-layout.js';
export { detectInstallMethod, readInstallState, writeInstallState, type InstallMethod, type InstallState } from './install-method.js';
export { installAppFromRelease, type InstallAppOptions, type InstallAppResult } from './install.js';
export { acquireRuntimeLock, readRuntimeLock, reclaimStaleRuntimeLock, type RuntimeLock, type RuntimeLockOptions } from './lock.js';
export { finishInstall, ensureLayoutDirs, openOnboardingUrl, runSetupFlow, type FinishInstallOptions } from './lifecycle.js';
export {
  appendDesktopLog,
  desktopLogPath,
  isBootstrapComplete,
  readBootstrapState,
  writeBootstrapState,
  type BootstrapState,
} from './bootstrap-state.js';
export {
  isBundledDesktopApp,
  runDesktopBootstrap,
  verifyDesktopApp,
  type BootstrapStep,
  type DesktopBootstrapOptions,
  type DesktopBootstrapResult,
} from './desktop-bootstrap.js';
export {
  fetchRuntimeReleaseManifest,
  ManifestSignatureError,
  runtimeArtifactFromManifest,
  runtimeVersionFromManifest,
  verifyReleaseManifestSignature,
  verifyReleaseManifestText,
  type FetchRuntimeReleaseManifestOptions,
  type RuntimeArtifact,
  type RuntimeReleaseManifest,
} from './release-manifest.js';
export {
  readLauncherState,
  readRuntimeState,
  writeLauncherState,
  writeRuntimeState,
  type LauncherState,
  type RuntimeState,
} from './runtime-state.js';
export { shouldStartGateway } from './gateway-policy.js';
export { seedAppFromBundle, type SeedAppResult } from './seed-app.js';
export {
  ensureRuntimeInstalled,
  type EnsureRuntimeInstalledOptions,
  type EnsureRuntimeInstalledResult,
  type EnsureRuntimeSource,
} from './setup-runtime.js';
export {
  allowDowngrade,
  allowSchemaDowngrade,
  assertNoActiveTaskRuns,
  assertRuntimeUpdateAllowed,
  type ActiveTaskPreflightOptions,
  type ActiveTaskPreflightResult,
  type RuntimeUpdatePolicy,
} from './update-preflight.js';
export { ensureAppUpToDate, fetchLatestManifest, type LatestManifest } from './app-update.js';
export {
  nodeToolsBin,
  nodeToolsPlatformRoot,
  postgresToolsBinDir,
  postgresToolsPlatformRoot,
  releasePlatformTag,
  resolveServeStatePath,
  zleapHome,
  zleapLayout,
  type ZleapLayout,
} from './layout.js';
export { runDevBuild, runDevBuildGateway, runMigrate, runWebProductionBuild } from './migrate.js';
export { ensurePostgres, probePostgres } from './postgres.js';
export {
  installPayload,
  type InstallPayloadOptions,
  type InstallPayloadResult,
  type PayloadInstallSource,
} from './payload.js';
export {
  ensurePostgresToolsInstalled,
  installPostgresBundleToBinDir,
  isPostgresToolsInstalled,
  resolvePostgresBundleSpec,
  type EnsurePostgresToolsOptions,
  type PostgresBundleSpec,
} from './postgres-bundle.js';
export {
  bundledAppRoot,
  isBundledInstall,
  resolveBundledNodeBin,
  resolveBundledPostgresBin,
  resolveBundledRoot,
  resolveRepoRoot,
  resolveRuntimeRoot,
  runtimeRoot,
  serveStatePath,
  appMetadataPath,
} from './paths.js';
export { resolvePnpm } from './pnpm.js';
export {
  buildRuntimeEnv,
  defaultServiceEntries,
  resolveNodeBin,
  resolvePostgresBin,
  resolveRuntime,
  resolveScriptFromEntry,
  resolveServiceEntries,
  type ResolvedRuntime,
} from './resolver.js';
export {
  healthCheck,
  readServeState,
  runServe,
  stopServe,
  type HealthReport,
  type ServeMode,
  type ServeOptions,
  type ServeServiceName,
  type ServeServiceState,
  type ServeStartedBy,
  type ServeState,
  type ServeStopPolicy,
  type StopServeOptions,
} from './supervisor.js';
export { installUserService, restartServe, startDetachedServe, waitForHealthLive } from './service/manager.js';
export {
  runRollback,
  runUpdate,
  appChecksumFileName,
  appChecksumUrl,
  appSha256Hex,
  type RollbackOptions,
  type UpdateOptions,
  type UpdateResult,
} from './update-engine.js';
export {
  downloadAppArchive,
  fetchLatestReleaseVersion,
  readPreviousAppMetadata,
  readAppMetadata,
  restorePreviousApp,
  swapApp,
  validateAppStaging,
  verifyArchiveChecksum,
  zleapInstallLayout,
  type AppMetadata,
  type UpgradeResult,
} from './upgrade.js';
