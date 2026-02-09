import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OpenNextManifest } from './types';

const validateManifest = (
  manifest: OpenNextManifest,
  manifestPath: string,
): void => {
  if (!manifest.origins || typeof manifest.origins !== 'object') {
    throw new Error(
      `Invalid OpenNext manifest at ${manifestPath}: missing or invalid "origins" field.`,
    );
  }

  if (!manifest.behaviors || !Array.isArray(manifest.behaviors)) {
    throw new Error(
      `Invalid OpenNext manifest at ${manifestPath}: missing or invalid "behaviors" field.`,
    );
  }

  if (!manifest.origins.default) {
    throw new Error(
      `Invalid OpenNext manifest at ${manifestPath}: missing "default" origin.`,
    );
  }
};

/**
 * Read and validate the open-next.output.json manifest at CDK synth time.
 * Uses synchronous file reads since CDK synthesis is synchronous.
 */
export const readManifest = (openNextPath: string): OpenNextManifest => {
  const manifestPath = path.join(openNextPath, 'open-next.output.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `OpenNext manifest not found at ${manifestPath}. ` +
        'Run `npx @opennextjs/aws build` before `cdk synth`.',
    );
  }

  const raw = fs.readFileSync(manifestPath, 'utf-8');
  let manifest: OpenNextManifest;

  try {
    manifest = JSON.parse(raw) as OpenNextManifest;
  } catch (err) {
    throw new Error(
      `Failed to parse OpenNext manifest at ${manifestPath}: ${(err as Error).message}`,
    );
  }

  validateManifest(manifest, manifestPath);

  return manifest;
};

/**
 * Get the list of split function origin keys from the manifest.
 * These are origin keys that are NOT 'default', 's3', or 'imageOptimizer'.
 */
export const getSplitFunctionOrigins = (
  manifest: OpenNextManifest,
): string[] => {
  const reserved = new Set(['default', 's3', 'imageOptimizer']);
  return Object.keys(manifest.origins).filter((key) => !reserved.has(key));
};

/**
 * Get the path to a function's bundle directory.
 */
export const getFunctionBundlePath = (
  openNextPath: string,
  origin: string,
): string => path.join(openNextPath, 'server-functions', origin);

/**
 * Get the path to the image optimization function bundle.
 */
export const getImageOptBundlePath = (openNextPath: string): string =>
  path.join(openNextPath, 'image-optimization-function');

/**
 * Get the path to the revalidation function bundle.
 */
export const getRevalidationBundlePath = (openNextPath: string): string =>
  path.join(openNextPath, 'revalidation-function');

/**
 * Get the path to the warmer function bundle.
 */
export const getWarmerBundlePath = (openNextPath: string): string =>
  path.join(openNextPath, 'warmer-function');

/**
 * Get the path to the DynamoDB provider (tag cache seeder) bundle.
 */
export const getDynamoDbProviderBundlePath = (openNextPath: string): string =>
  path.join(openNextPath, 'dynamodb-provider');

/**
 * Check whether the manifest declares an initialization function
 * (used for DynamoDB tag cache seeding).
 */
export const hasInitializationFunction = (
  manifest: OpenNextManifest,
): boolean => manifest.additionalProps?.initializationFunction != null;

/**
 * Strip the `.open-next/` prefix from a bundle/copy path if present.
 * OpenNext v3.9+ produces paths relative to the project root (e.g.
 * `.open-next/assets`), while older versions use paths relative to the
 * `.open-next` directory (e.g. `assets`). This normalizes both to be
 * relative to `.open-next`.
 */
const normalizeBundlePath = (p: string): string => {
  if (p.startsWith('.open-next/')) {
    return p.slice('.open-next/'.length);
  }
  return p;
};

/**
 * Get the S3 assets paths from the manifest.
 * Returns all copy entries from the 's3' origin, with `from` paths
 * normalized to be relative to the `.open-next` directory.
 *
 * OpenNext v3.9+ produces `from` paths like `.open-next/assets` (relative
 * to the project root). Earlier versions use `assets` (already relative to
 * `.open-next`). This function strips the `.open-next/` prefix when present
 * so callers can always `path.join(openNextPath, entry.from)`.
 */
export const getAssetCopyEntries = (
  manifest: OpenNextManifest,
): Array<{
  from: string;
  to: string;
  cached: boolean;
  versionedSubDir?: string;
}> => {
  const s3Origin = manifest.origins.s3;

  if (!s3Origin || !s3Origin.copy) {
    return [];
  }

  return s3Origin.copy.map((entry) => ({
    ...entry,
    from: normalizeBundlePath(entry.from),
  }));
};

/**
 * Get the S3 origin path from the manifest.
 * When present, CloudFront prepends this path to requests routed to the S3 origin.
 * Returns undefined if not set (backwards compatibility with older manifests).
 */
export const getS3OriginPath = (
  manifest: OpenNextManifest,
): string | undefined => manifest.origins.s3?.originPath;
