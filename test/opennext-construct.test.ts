import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenNextCdk } from '../src';

type MockManifestOverrides = {
  additionalProps?: Record<string, unknown>;
  edgeFunctions?: Record<string, unknown>;
};

/**
 * Creates a temporary .open-next build output directory with the required
 * structure for the construct to synth successfully.
 */
function createMockOpenNextOutput(overrides?: MockManifestOverrides): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opennext-test-'));

  // Write manifest
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

  if (overrides?.additionalProps) {
    manifest.additionalProps = overrides.additionalProps;
  }
  if (overrides?.edgeFunctions) {
    manifest.edgeFunctions = overrides.edgeFunctions;
  }

  fs.writeFileSync(
    path.join(tmpDir, 'open-next.output.json'),
    JSON.stringify(manifest, null, 2),
  );

  // Create function bundle directories with dummy handler files
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

  // Create dynamodb-provider bundle if initializationFunction is present
  if (overrides?.additionalProps?.initializationFunction) {
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

describe('OpenNextCdk', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createMockOpenNextOutput();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a CloudFront distribution', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  it('creates the S3 assets bucket', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    // Assets bucket + auto-delete custom resource bucket (CDK internal)
    const buckets = template.findResources('AWS::S3::Bucket');
    expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(1);
  });

  it('creates server Lambda function with Function URL', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);

    // Should have Lambda functions (server, image-opt, revalidation + CDK helpers)
    const lambdas = template.findResources('AWS::Lambda::Function');
    expect(Object.keys(lambdas).length).toBeGreaterThanOrEqual(3);

    // Should have Function URLs (server + image-opt)
    template.resourceCountIs('AWS::Lambda::Url', 2);
  });

  it('creates SQS FIFO revalidation queue', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::SQS::Queue', {
      FifoQueue: true,
      ContentBasedDeduplication: true,
    });
  });

  it('creates DynamoDB tag cache table by default', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: Match.arrayWith([
        Match.objectLike({ AttributeName: 'tag', KeyType: 'HASH' }),
        Match.objectLike({ AttributeName: 'path', KeyType: 'RANGE' }),
      ]),
    });
  });

  it('does not create DynamoDB table when disabled', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
      tagCache: { disabled: true },
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::DynamoDB::Table', 0);
  });

  it('creates WAF by default', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
  });

  it('does not create WAF when disabled', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
      waf: { enabled: false },
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
  });

  it('creates CloudFront Function for host header rewrite', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CloudFront::Function', 1);
  });

  it('creates KMS key for SQS encryption', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::KMS::Key', 1);
  });

  it('creates cache policy with Next.js headers', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
          HeadersConfig: Match.objectLike({
            Headers: Match.arrayWith(['rsc', 'next-router-prefetch']),
          }),
        }),
      }),
    });
  });

  it('configures streaming mode when manifest indicates streaming', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Url', {
      InvokeMode: 'RESPONSE_STREAM',
    });
  });

  it('exposes the distribution URL', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    const construct = new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    expect(construct.url).toBeDefined();
    expect(construct.distribution).toBeDefined();
    expect(construct.bucket).toBeDefined();
    expect(construct.serverFunctions.has('default')).toBe(true);
    expect(construct.imageOptimizationFunction).toBeDefined();
    expect(construct.revalidationFunction).toBeDefined();
    expect(construct.revalidationQueue).toBeDefined();
    expect(construct.tagCacheTable).toBeDefined();
  });

  it('uses custom prefix', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
      prefix: 'myapp',
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('^myapp-'),
    });
  });

  it('creates CfnOutputs', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    const outputs = template.findOutputs('*');
    const outputKeys = Object.keys(outputs);
    // Should have at least 3 outputs: distribution domain, distribution id, bucket name
    expect(outputKeys.length).toBeGreaterThanOrEqual(3);
  });

  it('snapshot test', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'SnapshotStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
      waf: { enabled: false }, // Simplify snapshot
      tagCache: { disabled: true }, // Simplify snapshot
    });

    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});

describe('OpenNextCdk with split functions', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opennext-split-test-'));

    const manifest = {
      version: '3',
      routes: [],
      origins: {
        s3: {
          type: 's3',
          copy: [{ from: 'assets', to: '/', cached: false }],
        },
        default: {
          type: 'function',
          handler: 'index.handler',
          streaming: true,
        },
        imageOptimizer: {
          type: 'function',
          handler: 'index.handler',
        },
        api: {
          type: 'function',
          handler: 'index.handler',
          streaming: false,
        },
      },
      behaviors: [
        { pattern: '_next/static/*', origin: 's3' },
        { pattern: '_next/image', origin: 'imageOptimizer' },
        { pattern: 'api/*', origin: 'api' },
        { pattern: '*', origin: 'default' },
      ],
    };

    fs.writeFileSync(
      path.join(tmpDir, 'open-next.output.json'),
      JSON.stringify(manifest),
    );

    const dirs = [
      'server-functions/default',
      'server-functions/api',
      'image-optimization-function',
      'revalidation-function',
      'assets',
    ];

    for (const dir of dirs) {
      fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, dir, 'index.mjs'),
        'export const handler = async () => ({ statusCode: 200 });',
      );
    }
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates split function Lambdas', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    const construct = new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    expect(construct.serverFunctions.has('default')).toBe(true);
    expect(construct.serverFunctions.has('api')).toBe(true);
    expect(construct.serverFunctions.size).toBe(2);
  });

  it('creates Function URLs for split functions', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    // Should have 3 Function URLs: default server, api split, image-opt
    template.resourceCountIs('AWS::Lambda::Url', 3);
  });

  it('creates additional CloudFront behavior for split function origin', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    // The distribution should have additional behaviors for api/*, _next/static/*, _next/image
    const distributions = template.findResources(
      'AWS::CloudFront::Distribution',
    );
    const distKeys = Object.keys(distributions);
    expect(distKeys.length).toBe(1);
    const distConfig = distributions[distKeys[0]].Properties.DistributionConfig;
    const cacheBehaviors = distConfig.CacheBehaviors ?? [];
    // Should have behaviors for: _next/static/*, _next/image, api/*
    expect(cacheBehaviors.length).toBe(3);
    const patterns = cacheBehaviors.map((b: any) => b.PathPattern);
    expect(patterns).toContain('_next/static/*');
    expect(patterns).toContain('_next/image');
    expect(patterns).toContain('api/*');
  });

  it('split function api/* behavior uses AllowedMethods ALL', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    const distributions = template.findResources(
      'AWS::CloudFront::Distribution',
    );
    const distConfig =
      distributions[Object.keys(distributions)[0]].Properties
        .DistributionConfig;
    const apiBehavior = distConfig.CacheBehaviors.find(
      (b: any) => b.PathPattern === 'api/*',
    );
    expect(apiBehavior).toBeDefined();
    // ALL methods = 7 methods
    expect(apiBehavior.AllowedMethods).toHaveLength(7);
  });
});

describe('OpenNextCdk resource wiring', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createMockOpenNextOutput();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('server function has required environment variables', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'opennext-server',
      Environment: {
        Variables: Match.objectLike({
          CACHE_BUCKET_NAME: Match.anyValue(),
          CACHE_BUCKET_KEY_PREFIX: '_cache',
          REVALIDATION_QUEUE_URL: Match.anyValue(),
          CACHE_DYNAMO_TABLE: Match.anyValue(),
        }),
      },
    });
  });

  it('revalidation function has required environment variables', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'opennext-revalidation',
      Environment: {
        Variables: Match.objectLike({
          CACHE_BUCKET_NAME: Match.anyValue(),
          CACHE_BUCKET_KEY_PREFIX: '_cache',
          CACHE_DYNAMO_TABLE: Match.anyValue(),
        }),
      },
    });
  });

  it('image optimization function has bucket env var', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'opennext-image-optimization',
      Environment: {
        Variables: Match.objectLike({
          BUCKET_NAME: Match.anyValue(),
          BUCKET_KEY_PREFIX: '',
        }),
      },
    });
  });

  it('server function gets S3 read/write IAM policy', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    // Server function role should have S3 GetObject/PutObject/DeleteObject
    const policies = template.findResources('AWS::IAM::Policy');
    const policyValues = Object.values(policies);
    const s3ReadWritePolicy = policyValues.find((p: any) => {
      const statements = p.Properties.PolicyDocument?.Statement ?? [];
      return statements.some(
        (s: any) =>
          Array.isArray(s.Action) &&
          s.Action.includes('s3:GetObject*') &&
          s.Action.includes('s3:PutObject'),
      );
    });
    expect(s3ReadWritePolicy).toBeDefined();
  });

  it('image optimization function gets S3 read-only IAM policy', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    // Image opt role should have S3 GetObject but NOT PutObject
    const policies = template.findResources('AWS::IAM::Policy');
    const policyValues = Object.values(policies);
    // At least one policy should only have read actions
    const readOnlyPolicy = policyValues.find((p: any) => {
      const statements = p.Properties.PolicyDocument?.Statement ?? [];
      return statements.some(
        (s: any) =>
          Array.isArray(s.Action) &&
          s.Action.includes('s3:GetObject*') &&
          !s.Action.includes('s3:PutObject'),
      );
    });
    expect(readOnlyPolicy).toBeDefined();
  });

  it('revalidation queue has dead letter queue configured', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    // Main revalidation queue should have RedrivePolicy referencing the DLQ
    template.hasResourceProperties('AWS::SQS::Queue', {
      FifoQueue: true,
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    });
  });

  it('creates two SQS queues (main + DLQ)', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::SQS::Queue', 2);
  });

  it('DynamoDB table has GSI for path lookups', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'revalidate',
          KeySchema: Match.arrayWith([
            Match.objectLike({ AttributeName: 'path', KeyType: 'HASH' }),
            Match.objectLike({ AttributeName: 'tag', KeyType: 'RANGE' }),
          ]),
          Projection: { ProjectionType: 'ALL' },
        }),
      ]),
    });
  });

  it('DynamoDB table uses PAY_PER_REQUEST by default', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });
});

describe('OpenNextCdk WAF configuration', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createMockOpenNextOutput();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('WAF has 4 managed rule groups', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      DefaultAction: { Allow: {} },
      Rules: Match.arrayWith([
        Match.objectLike({
          Statement: {
            ManagedRuleGroupStatement: {
              Name: 'AWSManagedRulesCommonRuleSet',
              VendorName: 'AWS',
            },
          },
        }),
        Match.objectLike({
          Statement: {
            ManagedRuleGroupStatement: {
              Name: 'AWSManagedRulesKnownBadInputsRuleSet',
              VendorName: 'AWS',
            },
          },
        }),
        Match.objectLike({
          Statement: {
            ManagedRuleGroupStatement: {
              Name: 'AWSManagedRulesLinuxRuleSet',
              VendorName: 'AWS',
            },
          },
        }),
        Match.objectLike({
          Statement: {
            ManagedRuleGroupStatement: {
              Name: 'AWSManagedRulesUnixRuleSet',
              VendorName: 'AWS',
            },
          },
        }),
      ]),
    });
  });

  it('uses existing WAF ARN when provided', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
      waf: {
        existingWebAclArn:
          'arn:aws:wafv2:us-east-1:123456789012:global/webacl/my-acl/abc123',
      },
    });

    const template = Template.fromStack(stack);
    // Should not create a new WAF
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
    // Distribution should reference the existing ARN
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        WebACLId:
          'arn:aws:wafv2:us-east-1:123456789012:global/webacl/my-acl/abc123',
      }),
    });
  });
});

describe('OpenNextCdk CloudFront policies', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createMockOpenNextOutput();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates origin request policy with required headers', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::OriginRequestPolicy', {
      OriginRequestPolicyConfig: Match.objectLike({
        HeadersConfig: {
          HeaderBehavior: 'whitelist',
          Headers: Match.arrayWith(['x-forwarded-host']),
        },
        QueryStringsConfig: { QueryStringBehavior: 'all' },
        CookiesConfig: { CookieBehavior: 'all' },
      }),
    });
  });

  it('creates response headers policy with HSTS by default', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: Match.objectLike({
            Override: true,
            IncludeSubdomains: true,
            Preload: true,
          }),
        }),
      }),
    });
  });

  it('response headers policy includes all 4 security headers', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: Match.objectLike({
            Override: true,
          }),
          ContentTypeOptions: { Override: true },
          FrameOptions: {
            FrameOption: 'DENY',
            Override: true,
          },
          ReferrerPolicy: {
            ReferrerPolicy: 'strict-origin-when-cross-origin',
            Override: true,
          },
        }),
      }),
    });
  });

  it('cache policy includes all 5 Next.js headers', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
          HeadersConfig: {
            HeaderBehavior: 'whitelist',
            Headers: Match.arrayWith([
              'rsc',
              'next-router-prefetch',
              'next-router-state-tree',
              'x-prerender-revalidate',
              'next-url',
            ]),
          },
          QueryStringsConfig: { QueryStringBehavior: 'all' },
          CookiesConfig: { CookieBehavior: 'all' },
          EnableAcceptEncodingGzip: true,
          EnableAcceptEncodingBrotli: true,
        }),
      }),
    });
  });

  it('S3 static asset behavior uses GET/HEAD only', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    const distributions = template.findResources(
      'AWS::CloudFront::Distribution',
    );
    const distConfig =
      distributions[Object.keys(distributions)[0]].Properties
        .DistributionConfig;
    const staticBehavior = distConfig.CacheBehaviors.find(
      (b: any) => b.PathPattern === '_next/static/*',
    );
    expect(staticBehavior).toBeDefined();
    // GET + HEAD = 2 methods
    expect(staticBehavior.AllowedMethods).toHaveLength(2);
    expect(staticBehavior.AllowedMethods).toContain('GET');
    expect(staticBehavior.AllowedMethods).toContain('HEAD');
  });

  it('default behavior uses ALL HTTP methods', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    const distributions = template.findResources(
      'AWS::CloudFront::Distribution',
    );
    const distConfig =
      distributions[Object.keys(distributions)[0]].Properties
        .DistributionConfig;
    // Default behavior should allow all 7 HTTP methods
    expect(distConfig.DefaultCacheBehavior.AllowedMethods).toHaveLength(7);
  });

  it('distribution uses TLS 1.2 minimum when custom domain is configured', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });

    // TLS minimum protocol is only emitted when a certificate is provided
    const cert = new cdk.aws_certificatemanager.Certificate(stack, 'Cert', {
      domainName: 'test.example.com',
    });

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
      distribution: {
        domainNames: ['test.example.com'],
        certificate: cert,
      },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        ViewerCertificate: Match.objectLike({
          MinimumProtocolVersion: 'TLSv1.2_2021',
        }),
      }),
    });
  });

  it('distribution uses HTTP/2 and HTTP/3', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        HttpVersion: 'http2and3',
      }),
    });
  });
});

describe('OpenNextCdk Lambda overrides', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createMockOpenNextOutput();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies custom memory and timeout to server function', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
      serverFunction: {
        memorySize: 2048,
        timeout: 60,
      },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'opennext-server',
      MemorySize: 2048,
      Timeout: 60,
    });
  });

  it('applies custom memory to image optimization function', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
      imageOptimizationFunction: {
        memorySize: 1024,
      },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'opennext-image-optimization',
      MemorySize: 1024,
    });
  });

  it('applies custom environment variables to server function', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
      serverFunction: {
        environment: {
          DATABASE_URL: 'postgresql://localhost/mydb',
        },
      },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'opennext-server',
      Environment: {
        Variables: Match.objectLike({
          DATABASE_URL: 'postgresql://localhost/mydb',
        }),
      },
    });
  });

  it('uses arm64 architecture by default', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'opennext-server',
      Architectures: ['arm64'],
    });
  });

  it('can override to x86_64 architecture', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
      serverFunction: {
        architecture: 'x86_64',
      },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'opennext-server',
      Architectures: ['x86_64'],
    });
  });
});

describe('OpenNextCdk S3 bucket configuration', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createMockOpenNextOutput();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('bucket has SSL enforcement', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    // Check for bucket policy with SSL condition
    const policies = template.findResources('AWS::S3::BucketPolicy');
    const policyValues = Object.values(policies);
    const sslPolicy = policyValues.find((p: any) => {
      const statements = p.Properties.PolicyDocument?.Statement ?? [];
      return statements.some(
        (s: any) =>
          s.Condition?.Bool?.['aws:SecureTransport'] === 'false' &&
          s.Effect === 'Deny',
      );
    });
    expect(sslPolicy).toBeDefined();
  });

  it('bucket blocks public access', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('creates S3 OAC for CloudFront', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      }),
    });
  });
});

describe('OpenNextCdk tag cache seeder', () => {
  it('creates Custom Resource for tag cache seeding', () => {
    const tmpDir = createMockOpenNextOutput({
      additionalProps: {
        initializationFunction: {
          handler: 'index.handler',
          bundle: '.open-next/dynamodb-provider',
        },
      },
    });

    try {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'TestStack');

      const construct = new OpenNextCdk(stack, 'Test', {
        openNextPath: tmpDir,
      });

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
      expect(construct.tagCacheSeederFunction).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('seeder Lambda has CACHE_DYNAMO_TABLE env var', () => {
    const tmpDir = createMockOpenNextOutput({
      additionalProps: {
        initializationFunction: {
          handler: 'index.handler',
          bundle: '.open-next/dynamodb-provider',
        },
      },
    });

    try {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'TestStack');

      new OpenNextCdk(stack, 'Test', {
        openNextPath: tmpDir,
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'opennext-tag-cache-seeder',
        Environment: {
          Variables: Match.objectLike({
            CACHE_DYNAMO_TABLE: Match.anyValue(),
          }),
        },
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not create seeder when manifest has no initializationFunction', () => {
    const tmpDir = createMockOpenNextOutput();

    try {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'TestStack');

      const construct = new OpenNextCdk(stack, 'Test', {
        openNextPath: tmpDir,
      });

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::CloudFormation::CustomResource', 0);
      expect(construct.tagCacheSeederFunction).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not create seeder when tag cache is disabled via props', () => {
    const tmpDir = createMockOpenNextOutput({
      additionalProps: {
        initializationFunction: {
          handler: 'index.handler',
          bundle: '.open-next/dynamodb-provider',
        },
      },
    });

    try {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'TestStack');

      const construct = new OpenNextCdk(stack, 'Test', {
        openNextPath: tmpDir,
        tagCache: { disabled: true },
      });

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::CloudFormation::CustomResource', 0);
      template.resourceCountIs('AWS::DynamoDB::Table', 0);
      expect(construct.tagCacheSeederFunction).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('OpenNextCdk manifest flags', () => {
  it('respects disableTagCache manifest flag', () => {
    const tmpDir = createMockOpenNextOutput({
      additionalProps: {
        disableTagCache: true,
      },
    });

    try {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'TestStack');

      const construct = new OpenNextCdk(stack, 'Test', {
        openNextPath: tmpDir,
      });

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::DynamoDB::Table', 0);
      expect(construct.tagCacheTable).toBeUndefined();

      // Server function should not have CACHE_DYNAMO_TABLE
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'opennext-server',
        Environment: {
          Variables: Match.not(
            Match.objectLike({ CACHE_DYNAMO_TABLE: Match.anyValue() }),
          ),
        },
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('respects disableIncrementalCache manifest flag', () => {
    const tmpDir = createMockOpenNextOutput({
      additionalProps: {
        disableIncrementalCache: true,
      },
    });

    try {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'TestStack');

      new OpenNextCdk(stack, 'Test', {
        openNextPath: tmpDir,
      });

      const template = Template.fromStack(stack);

      // Server function should NOT have CACHE_BUCKET_NAME
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'opennext-server',
        Environment: {
          Variables: Match.not(
            Match.objectLike({ CACHE_BUCKET_NAME: Match.anyValue() }),
          ),
        },
      });

      // Server function should still have REVALIDATION_QUEUE_URL
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'opennext-server',
        Environment: {
          Variables: Match.objectLike({
            REVALIDATION_QUEUE_URL: Match.anyValue(),
          }),
        },
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('emits warning when edgeFunctions present', () => {
    const tmpDir = createMockOpenNextOutput({
      edgeFunctions: {
        middleware: {
          handler: 'index.handler',
          bundle: '.open-next/middleware',
        },
      },
    });

    try {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'TestStack');

      new OpenNextCdk(stack, 'Test', {
        openNextPath: tmpDir,
      });

      const annotations = Annotations.fromStack(stack);
      annotations.hasWarning(
        '/TestStack/Test',
        Match.stringLikeRegexp('Edge functions found in manifest'),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not emit warning when edgeFunctions is empty', () => {
    const tmpDir = createMockOpenNextOutput({
      edgeFunctions: {},
    });

    try {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'TestStack');

      new OpenNextCdk(stack, 'Test', {
        openNextPath: tmpDir,
      });

      const annotations = Annotations.fromStack(stack);
      annotations.hasNoWarning(
        '/TestStack/Test',
        Match.stringLikeRegexp('Edge functions'),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('OpenNextCdk CloudWatch alarms', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createMockOpenNextOutput();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not create alarms by default', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  });

  it('creates alarms when enabled', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
      alarms: { enabled: true },
    });

    const template = Template.fromStack(stack);
    // DLQ depth + server errors + revalidation errors + CloudFront 5xx = 4
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    expect(Object.keys(alarms).length).toBe(4);
  });

  it('alarm names use prefix', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
      prefix: 'myapp',
      alarms: { enabled: true },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('^myapp-'),
    });
  });
});

describe('OpenNextCdk with real OpenNext v3.9+ manifest', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opennext-real-test-'));

    // Manifest matching real OpenNext v3.9.15 output (no routes/version,
    // .open-next/ prefixed paths, originPath on s3 origin)
    const manifest = {
      edgeFunctions: {},
      origins: {
        s3: {
          type: 's3',
          originPath: '_assets',
          copy: [
            {
              from: '.open-next/assets',
              to: '_assets',
              cached: true,
              versionedSubDir: '_next',
            },
            { from: '.open-next/cache', to: '_cache', cached: false },
          ],
        },
        imageOptimizer: {
          type: 'function',
          handler: 'index.handler',
          bundle: '.open-next/image-optimization-function',
          streaming: false,
          imageLoader: 's3',
          wrapper: 'aws-lambda',
          converter: 'aws-apigw-v2',
        },
        default: {
          type: 'function',
          handler: 'index.handler',
          bundle: '.open-next/server-functions/default',
          streaming: false,
          wrapper: 'aws-lambda',
          converter: 'aws-apigw-v2',
          queue: 'sqs',
          incrementalCache: 's3',
          tagCache: 'dynamodb',
        },
      },
      behaviors: [
        { pattern: '_next/image*', origin: 'imageOptimizer' },
        { pattern: '_next/data/*', origin: 'default' },
        { pattern: '*', origin: 'default' },
        { pattern: 'BUILD_ID', origin: 's3' },
        { pattern: '_next/*', origin: 's3' },
        { pattern: 'favicon.ico', origin: 's3' },
        { pattern: 'robots.txt', origin: 's3' },
      ],
      additionalProps: {
        warmer: {
          handler: 'index.handler',
          bundle: '.open-next/warmer-function',
        },
        initializationFunction: {
          handler: 'index.handler',
          bundle: '.open-next/dynamodb-provider',
        },
        revalidationFunction: {
          handler: 'index.handler',
          bundle: '.open-next/revalidation-function',
        },
      },
    };

    fs.writeFileSync(
      path.join(tmpDir, 'open-next.output.json'),
      JSON.stringify(manifest),
    );

    // Create bundle directories
    const dirs = [
      'server-functions/default',
      'image-optimization-function',
      'revalidation-function',
      'warmer-function',
      'dynamodb-provider',
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
    fs.writeFileSync(
      path.join(tmpDir, 'dynamodb-provider', 'dynamodb-cache.json'),
      JSON.stringify([]),
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('synthesizes successfully with real manifest format', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    const construct = new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    expect(construct.distribution).toBeDefined();
    expect(construct.serverFunctions.has('default')).toBe(true);
    expect(construct.tagCacheSeederFunction).toBeDefined();
  });

  it('S3 origin has origin path from manifest', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    const distributions = template.findResources(
      'AWS::CloudFront::Distribution',
    );
    const distConfig =
      distributions[Object.keys(distributions)[0]].Properties
        .DistributionConfig;

    // Find the S3 origin — it should have OriginPath set
    const origins = distConfig.Origins ?? [];
    const s3Origin = origins.find(
      (o: any) => o.S3OriginConfig || o.OriginAccessControlId,
    );
    expect(s3Origin).toBeDefined();
    expect(s3Origin.OriginPath).toBe('/_assets');
  });

  it('image optimization function has correct BUCKET_KEY_PREFIX', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'opennext-image-optimization',
      Environment: {
        Variables: Match.objectLike({
          BUCKET_KEY_PREFIX: '_assets',
        }),
      },
    });
  });

  it('creates CloudFront behaviors for static assets', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    const distributions = template.findResources(
      'AWS::CloudFront::Distribution',
    );
    const distConfig =
      distributions[Object.keys(distributions)[0]].Properties
        .DistributionConfig;
    const cacheBehaviors = distConfig.CacheBehaviors ?? [];
    const patterns = cacheBehaviors.map((b: any) => b.PathPattern);

    expect(patterns).toContain('_next/*');
    expect(patterns).toContain('_next/image*');
    expect(patterns).toContain('favicon.ico');
    expect(patterns).toContain('robots.txt');
    expect(patterns).toContain('BUILD_ID');
  });

  it('uses BUFFERED invoke mode when streaming is false', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    // The server function URL should be BUFFERED since streaming: false
    template.hasResourceProperties('AWS::Lambda::Url', {
      InvokeMode: 'BUFFERED',
    });
  });
});

describe('OpenNextCdk reservedConcurrentExecutions', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createMockOpenNextOutput();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets ReservedConcurrentExecutions on server function', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
      serverFunction: {
        reservedConcurrentExecutions: 100,
      },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'opennext-server',
      ReservedConcurrentExecutions: 100,
    });
  });

  it('does not set ReservedConcurrentExecutions by default', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new OpenNextCdk(stack, 'Test', {
      openNextPath: tmpDir,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'opennext-server',
      ReservedConcurrentExecutions: Match.absent(),
    });
  });
});
