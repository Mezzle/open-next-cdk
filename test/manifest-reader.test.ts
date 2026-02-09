import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getAssetCopyEntries,
  getDynamoDbProviderBundlePath,
  getS3OriginPath,
  getSplitFunctionOrigins,
  hasInitializationFunction,
  readManifest,
} from '../src/manifest-reader';

describe('manifest-reader', () => {
  const fixtureDir = path.resolve('test/fixtures');

  describe('readManifest', () => {
    it('reads a valid manifest', () => {
      // Create a temp directory with the fixture
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opennext-test-'));
      fs.copyFileSync(
        path.join(fixtureDir, 'basic-output.json'),
        path.join(tmpDir, 'open-next.output.json'),
      );

      const manifest = readManifest(tmpDir);
      expect(manifest.version).toBe('3');
      expect(manifest.origins).toBeDefined();
      expect(manifest.origins.default).toBeDefined();
      expect(manifest.behaviors).toBeInstanceOf(Array);
      expect(manifest.behaviors.length).toBe(3);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('throws when manifest file does not exist', () => {
      expect(() => readManifest('/nonexistent/path')).toThrow(
        /OpenNext manifest not found/,
      );
    });

    it('throws when manifest JSON is invalid', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opennext-test-'));
      fs.writeFileSync(path.join(tmpDir, 'open-next.output.json'), 'not json');

      expect(() => readManifest(tmpDir)).toThrow(/Failed to parse/);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('throws when manifest is missing default origin', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opennext-test-'));
      const badManifest = {
        version: '3',
        routes: [],
        origins: { s3: { type: 's3' } },
        behaviors: [],
      };
      fs.writeFileSync(
        path.join(tmpDir, 'open-next.output.json'),
        JSON.stringify(badManifest),
      );

      expect(() => readManifest(tmpDir)).toThrow(/missing "default" origin/);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('throws when manifest is missing origins', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opennext-test-'));
      const badManifest = {
        version: '3',
        routes: [],
        behaviors: [],
      };
      fs.writeFileSync(
        path.join(tmpDir, 'open-next.output.json'),
        JSON.stringify(badManifest),
      );

      expect(() => readManifest(tmpDir)).toThrow(
        /missing or invalid "origins"/,
      );

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('getSplitFunctionOrigins', () => {
    it('returns empty array when no split functions', () => {
      const manifest = {
        version: '3',
        routes: [],
        origins: {
          default: { type: 'function' },
          s3: { type: 's3' },
          imageOptimizer: { type: 'function' },
        },
        behaviors: [],
      };
      expect(getSplitFunctionOrigins(manifest)).toEqual([]);
    });

    it('returns split function keys', () => {
      const manifest = {
        version: '3',
        routes: [],
        origins: {
          default: { type: 'function' },
          s3: { type: 's3' },
          imageOptimizer: { type: 'function' },
          'api/trpc': { type: 'function' },
          'api/auth': { type: 'function' },
        },
        behaviors: [],
      };
      const splits = getSplitFunctionOrigins(manifest);
      expect(splits).toContain('api/trpc');
      expect(splits).toContain('api/auth');
      expect(splits).toHaveLength(2);
    });
  });

  describe('getAssetCopyEntries', () => {
    it('returns copy entries from s3 origin', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opennext-test-'));
      fs.copyFileSync(
        path.join(fixtureDir, 'basic-output.json'),
        path.join(tmpDir, 'open-next.output.json'),
      );

      const manifest = readManifest(tmpDir);
      const entries = getAssetCopyEntries(manifest);
      expect(entries).toHaveLength(2);
      expect(entries[0].from).toBe('assets');
      expect(entries[1].from).toBe('cache');
      expect(entries[1].cached).toBe(true);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns empty array when no s3 origin', () => {
      const manifest = {
        version: '3',
        routes: [],
        origins: { default: { type: 'function' } },
        behaviors: [],
      };
      expect(getAssetCopyEntries(manifest)).toEqual([]);
    });

    it('normalizes .open-next/ prefix in from paths', () => {
      const manifest = {
        origins: {
          default: { type: 'function' },
          s3: {
            type: 's3',
            originPath: '_assets',
            copy: [
              { from: '.open-next/assets', to: '_assets', cached: true, versionedSubDir: '_next' },
              { from: '.open-next/cache', to: '_cache', cached: false },
            ],
          },
        },
        behaviors: [],
      };
      const entries = getAssetCopyEntries(manifest);
      expect(entries).toHaveLength(2);
      expect(entries[0].from).toBe('assets');
      expect(entries[1].from).toBe('cache');
    });

    it('leaves paths without .open-next/ prefix unchanged', () => {
      const manifest = {
        origins: {
          default: { type: 'function' },
          s3: {
            type: 's3',
            copy: [
              { from: 'assets', to: '/', cached: false },
            ],
          },
        },
        behaviors: [],
      };
      const entries = getAssetCopyEntries(manifest);
      expect(entries[0].from).toBe('assets');
    });
  });

  describe('getS3OriginPath', () => {
    it('returns originPath when present', () => {
      const manifest = {
        origins: {
          default: { type: 'function' },
          s3: { type: 's3', originPath: '_assets', copy: [] },
        },
        behaviors: [],
      };
      expect(getS3OriginPath(manifest)).toBe('_assets');
    });

    it('returns undefined when no originPath', () => {
      const manifest = {
        origins: {
          default: { type: 'function' },
          s3: { type: 's3', copy: [] },
        },
        behaviors: [],
      };
      expect(getS3OriginPath(manifest)).toBeUndefined();
    });

    it('returns undefined when no s3 origin', () => {
      const manifest = {
        origins: { default: { type: 'function' } },
        behaviors: [],
      };
      expect(getS3OriginPath(manifest)).toBeUndefined();
    });
  });

  describe('readManifest with real OpenNext v3.9+ format', () => {
    it('reads manifest without routes and version fields', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opennext-test-'));
      const manifest = {
        edgeFunctions: {},
        origins: {
          s3: {
            type: 's3',
            originPath: '_assets',
            copy: [
              { from: '.open-next/assets', to: '_assets', cached: true, versionedSubDir: '_next' },
              { from: '.open-next/cache', to: '_cache', cached: false },
            ],
          },
          imageOptimizer: {
            type: 'function',
            handler: 'index.handler',
            bundle: '.open-next/image-optimization-function',
            streaming: false,
          },
          default: {
            type: 'function',
            handler: 'index.handler',
            bundle: '.open-next/server-functions/default',
            streaming: false,
          },
        },
        behaviors: [
          { pattern: '_next/image*', origin: 'imageOptimizer' },
          { pattern: '*', origin: 'default' },
          { pattern: '_next/*', origin: 's3' },
        ],
        additionalProps: {
          warmer: { handler: 'index.handler', bundle: '.open-next/warmer-function' },
          initializationFunction: { handler: 'index.handler', bundle: '.open-next/dynamodb-provider' },
          revalidationFunction: { handler: 'index.handler', bundle: '.open-next/revalidation-function' },
        },
      };
      fs.writeFileSync(
        path.join(tmpDir, 'open-next.output.json'),
        JSON.stringify(manifest),
      );

      const result = readManifest(tmpDir);
      expect(result.version).toBeUndefined();
      expect(result.routes).toBeUndefined();
      expect(result.origins.default).toBeDefined();
      expect(result.behaviors).toHaveLength(3);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('getDynamoDbProviderBundlePath', () => {
    it('returns correct path', () => {
      expect(getDynamoDbProviderBundlePath('/my/app/.open-next')).toBe(
        path.join('/my/app/.open-next', 'dynamodb-provider'),
      );
    });
  });

  describe('hasInitializationFunction', () => {
    it('returns true when initializationFunction is present', () => {
      const manifest = {
        version: '3',
        routes: [],
        origins: { default: { type: 'function' } },
        behaviors: [],
        additionalProps: {
          initializationFunction: {
            handler: 'index.handler',
            bundle: '.open-next/dynamodb-provider',
          },
        },
      };
      expect(hasInitializationFunction(manifest)).toBe(true);
    });

    it('returns false when additionalProps is missing', () => {
      const manifest = {
        version: '3',
        routes: [],
        origins: { default: { type: 'function' } },
        behaviors: [],
      };
      expect(hasInitializationFunction(manifest)).toBe(false);
    });

    it('returns false when initializationFunction is missing', () => {
      const manifest = {
        version: '3',
        routes: [],
        origins: { default: { type: 'function' } },
        behaviors: [],
        additionalProps: {},
      };
      expect(hasInitializationFunction(manifest)).toBe(false);
    });
  });
});
