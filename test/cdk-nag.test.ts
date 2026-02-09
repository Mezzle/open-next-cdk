import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { OpenNextCdk } from '../src';

/**
 * Creates a temporary .open-next build output directory with the required
 * structure for the construct to synth successfully.
 */
type MockNagOptions = {
  withSeeder?: boolean;
};

function createMockOpenNextOutput(options?: MockNagOptions): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opennext-nag-test-'));

  const manifest: Record<string, unknown> = {
    version: '3',
    routes: [
      { regex: '^/_next/static/.*$', origin: 's3' },
      { regex: '^/_next/image$', origin: 'imageOptimizer' },
      { regex: '^.*$', origin: 'default' },
    ],
    origins: {
      s3: {
        type: 's3',
        copy: [
          { from: 'assets', to: '/', cached: false },
          {
            from: 'cache',
            to: '_cache',
            cached: true,
            versionedSubDir: '_next',
          },
        ],
      },
      default: {
        type: 'function',
        handler: 'index.handler',
        bundle: 'server-functions/default',
        streaming: true,
      },
      imageOptimizer: {
        type: 'function',
        handler: 'index.handler',
        bundle: 'image-optimization-function',
      },
    },
    behaviors: [
      { pattern: '_next/static/*', origin: 's3' },
      { pattern: '_next/image', origin: 'imageOptimizer' },
      { pattern: '*', origin: 'default' },
    ],
  };

  if (options?.withSeeder) {
    manifest.additionalProps = {
      initializationFunction: {
        handler: 'index.handler',
        bundle: '.open-next/dynamodb-provider',
      },
    };
  }

  fs.writeFileSync(
    path.join(tmpDir, 'open-next.output.json'),
    JSON.stringify(manifest, null, 2),
  );

  const dirs = [
    'server-functions/default',
    'image-optimization-function',
    'revalidation-function',
    'warmer-function',
    'assets',
    'cache',
  ];

  for (const dir of dirs) {
    fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, dir, 'index.mjs'),
      'export const handler = async () => ({ statusCode: 200 });',
    );
  }

  if (options?.withSeeder) {
    const seederDir = path.join(tmpDir, 'dynamodb-provider');
    fs.mkdirSync(seederDir, { recursive: true });
    fs.writeFileSync(
      path.join(seederDir, 'index.mjs'),
      'export const handler = async () => ({ statusCode: 200 });',
    );
    fs.writeFileSync(
      path.join(seederDir, 'dynamodb-cache.json'),
      JSON.stringify([]),
    );
  }

  return tmpDir;
}

/**
 * Collects cdk-nag errors from the synthesized stack metadata.
 */
function getNagErrors(stack: cdk.Stack): string[] {
  const assembly = stack.node.root as cdk.App;
  const synth = assembly.synth();
  const stackArtifact = synth.getStackByName(stack.stackName);
  const errors: string[] = [];
  for (const message of stackArtifact.messages) {
    if (message.level === 'error') {
      errors.push(message.entry.data as string);
    }
  }
  return errors;
}

describe('cdk-nag AwsSolutions compliance', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createMockOpenNextOutput();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('has zero cdk-nag errors (default config)', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'NagTestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });

    Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    applySuppressions(stack);

    const errors = getNagErrors(stack);
    if (errors.length > 0) {
      console.error('cdk-nag errors:', JSON.stringify(errors, null, 2));
    }
    expect(errors).toHaveLength(0);
  });

  it('has zero cdk-nag errors (CloudFront logs enabled)', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'NagTestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });

    Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
      cloudfrontLogs: { enabled: true },
    });

    applySuppressions(stack, { cloudfrontLogsEnabled: true });

    const errors = getNagErrors(stack);
    if (errors.length > 0) {
      console.error('cdk-nag errors:', JSON.stringify(errors, null, 2));
    }
    expect(errors).toHaveLength(0);
  });

  it('has zero cdk-nag errors (alarms enabled)', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'NagTestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });

    Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
      alarms: { enabled: true },
    });

    applySuppressions(stack);

    const errors = getNagErrors(stack);
    if (errors.length > 0) {
      console.error('cdk-nag errors:', JSON.stringify(errors, null, 2));
    }
    expect(errors).toHaveLength(0);
  });

  it('has zero cdk-nag errors (tag cache seeder enabled)', () => {
    const seederTmpDir = createMockOpenNextOutput({ withSeeder: true });

    try {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'NagTestStack', {
        env: { account: '123456789012', region: 'us-east-1' },
      });

      Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));

      new OpenNextCdk(stack, 'Test', {
        openNextPath: seederTmpDir,
      });

      applySuppressions(stack, { seederEnabled: true });

      const errors = getNagErrors(stack);
      if (errors.length > 0) {
        console.error('cdk-nag errors:', JSON.stringify(errors, null, 2));
      }
      expect(errors).toHaveLength(0);
    } finally {
      fs.rmSync(seederTmpDir, { recursive: true, force: true });
    }
  });
});

/**
 * Apply cdk-nag suppressions for intentional design decisions.
 * These are applied in the test (not source) because this is a library construct —
 * consumers running cdk-nag on their own stacks will see all findings.
 */
function applySuppressions(
  stack: cdk.Stack,
  options?: { cloudfrontLogsEnabled?: boolean; seederEnabled?: boolean },
) {
  const cloudfrontLogsEnabled = options?.cloudfrontLogsEnabled ?? false;
  const seederEnabled = options?.seederEnabled ?? false;
  // ─── Stack-level suppressions (apply to all resources) ───────────────
  NagSuppressions.addStackSuppressions(
    stack,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'CDK grant() attaches AWSLambdaBasicExecutionRole — standard CDK pattern',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'CDK grant() produces /* resource suffixes — scoped to specific buckets/tables',
      },
      {
        id: 'AwsSolutions-L1',
        reason:
          'nodejs20.x is current LTS for OpenNext; runtime override prop exists',
      },
    ],
    true,
  );

  // ─── Resource-level suppressions ─────────────────────────────────────

  // SQS DLQ doesn't need its own DLQ
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    '/NagTestStack/Test/Revalidation/DLQ/Resource',
    [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This IS the dead-letter queue — it does not need its own DLQ',
      },
    ],
  );

  // CloudFront geo restriction is deployment-specific
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    '/NagTestStack/Test/Distribution/Distribution/Resource',
    [
      {
        id: 'AwsSolutions-CFR1',
        reason:
          'Geo restriction is deployment-specific; geoRestrictionLocations prop exists',
      },
      {
        id: 'AwsSolutions-CFR3',
        reason:
          'CloudFront logging is optional and user-controlled via cloudfrontLogs prop',
      },
      {
        id: 'AwsSolutions-CFR4',
        reason:
          'Default CloudFront cert ignores minimumProtocolVersion; set correctly for custom certs',
      },
    ],
  );

  // CF log bucket IS the log destination — self-logging would cause loops
  if (cloudfrontLogsEnabled) {
    NagSuppressions.addResourceSuppressionsByPath(
      stack,
      '/NagTestStack/Test/CloudFrontLogs/LogBucket/Resource',
      [
        {
          id: 'AwsSolutions-S1',
          reason:
            'This IS the log destination bucket — self-logging creates infinite loops',
        },
      ],
      true,
    );
  }

  // Access log bucket IS the log destination for the assets bucket
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    '/NagTestStack/Test/AccessLogBucket/Resource',
    [
      {
        id: 'AwsSolutions-S1',
        reason:
          'This IS the access log bucket — self-logging creates infinite loops',
      },
    ],
    true,
  );

  // BucketDeployment creates an internal Lambda — CDK-managed, not controllable
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    '/NagTestStack/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/Resource',
    [
      {
        id: 'AwsSolutions-L1',
        reason:
          'CDK BucketDeployment internal Lambda — runtime not controllable',
      },
    ],
    true,
  );

  // cr.Provider creates an internal framework Lambda — CDK-managed, not controllable
  if (seederEnabled) {
    NagSuppressions.addResourceSuppressionsByPath(
      stack,
      '/NagTestStack/Test/TagCacheSeeder/Provider/framework-onEvent/Resource',
      [
        {
          id: 'AwsSolutions-L1',
          reason:
            'CDK cr.Provider internal framework Lambda — runtime not controllable',
        },
      ],
      true,
    );
  }
}
