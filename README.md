# open-next-cdk

An AWS CDK L3 construct for deploying Next.js applications built with [OpenNext v3](https://opennext.js.org/) to AWS using a serverless architecture.

## Architecture

This construct creates a fully serverless deployment of your Next.js application:

```
                        ┌──────────────┐
                        │   Route 53   │ (optional)
                        └──────┬───────┘
                               │
                        ┌──────▼───────┐
                   ┌────│  CloudFront   │────┐
                   │    │  + WAF (opt)  │    │
                   │    └──────┬───────┘    │
                   │           │            │
            ┌──────▼──┐  ┌────▼────┐  ┌────▼─────────┐
            │   S3    │  │ Server  │  │    Image      │
            │ Assets  │  │ Lambda  │  │ Optimization  │
            │  (OAC)  │  │  (URL)  │  │ Lambda (URL)  │
            └─────────┘  └────┬────┘  └──────────────┘
                              │
                    ┌─────────┼──────────┐
                    │         │          │
              ┌─────▼──┐ ┌───▼────┐ ┌───▼──────┐
              │  SQS   │ │   S3   │ │ DynamoDB  │
              │ (ISR)  │ │ Cache  │ │ Tag Cache │
              └────────┘ └────────┘ └───────────┘
```

### Resources Created

| Component | AWS Resources | Default |
|---|---|---|
| **Assets** | S3 bucket, BucketDeployment(s), OAC | Always |
| **Server Function(s)** | Lambda + Function URL, IAM role, CW log group | Always |
| **Image Optimization** | Lambda + Function URL, IAM role, CW log group | Always |
| **Revalidation** | SQS FIFO queue (KMS encrypted), Lambda, event source mapping | Always |
| **Tag Cache** | DynamoDB table with GSI | On (disable with `tagCache.disabled`) |
| **Distribution** | CloudFront, cache/origin-request/response-headers policies, CF Function | Always |
| **WAF** | WAFv2 WebACL with 4 managed rule groups | On (disable with `waf.enabled: false`) |
| **DNS** | Route 53 A + AAAA alias records | Off (enable with `dns` prop) |
| **Warmer** | Lambda + EventBridge scheduled rule | Off (enable with `warmer.enabled`) |
| **CF Logs** | S3 log bucket, forwarder Lambda, CW log group | Off (enable with `cloudfrontLogs.enabled`) |

## Prerequisites

- AWS CDK v2 (>= 2.100.0)
- Node.js 20+
- Your Next.js app built with OpenNext v3:

```bash
npx @opennextjs/aws build
```

## Installation

```bash
npm install open-next-cdk
```

## Quick Start

```typescript
import * as cdk from 'aws-cdk-lib';
import { OpenNextCdk } from 'open-next-cdk';
import * as path from 'path';

const app = new cdk.App();
const stack = new cdk.Stack(app, 'MyNextApp');

new OpenNextCdk(stack, 'NextApp', {
  openNextPath: path.join(__dirname, '..', '.open-next'),
});
```

## Usage Examples

### Custom Domain with ACM Certificate

```typescript
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';

const hostedZone = route53.HostedZone.fromLookup(stack, 'Zone', {
  domainName: 'example.com',
});

const certificate = new acm.Certificate(stack, 'Cert', {
  domainName: 'app.example.com',
  validation: acm.CertificateValidation.fromDns(hostedZone),
});

new OpenNextCdk(stack, 'NextApp', {
  openNextPath: path.join(__dirname, '..', '.open-next'),
  distribution: {
    domainNames: ['app.example.com'],
    certificate,
  },
  dns: {
    hostedZone,
    recordNames: ['app.example.com'],
  },
});
```

### Lambda Overrides

```typescript
new OpenNextCdk(stack, 'NextApp', {
  openNextPath: path.join(__dirname, '..', '.open-next'),
  serverFunction: {
    memorySize: 2048,
    timeout: 60,
    environment: {
      DATABASE_URL: 'postgresql://...',
    },
  },
  imageOptimizationFunction: {
    memorySize: 1024,
  },
});
```

### Split Functions

When OpenNext produces split functions (multiple server origins), you can override each one:

```typescript
new OpenNextCdk(stack, 'NextApp', {
  openNextPath: path.join(__dirname, '..', '.open-next'),
  splitFunctions: {
    'api': {
      memorySize: 2048,
      timeout: 30,
    },
  },
});
```

### Enable Warmer

```typescript
new OpenNextCdk(stack, 'NextApp', {
  openNextPath: path.join(__dirname, '..', '.open-next'),
  warmer: {
    enabled: true,
    schedule: 'rate(5 minutes)',
    concurrency: 2,
  },
});
```

### Disable WAF / Tag Cache

```typescript
new OpenNextCdk(stack, 'NextApp', {
  openNextPath: path.join(__dirname, '..', '.open-next'),
  waf: { enabled: false },
  tagCache: { disabled: true },
});
```

### Cross-Region WAF

WAF for CloudFront must be in `us-east-1`. If your stack is in another region, create the WAF separately and pass the ARN:

```typescript
new OpenNextCdk(stack, 'NextApp', {
  openNextPath: path.join(__dirname, '..', '.open-next'),
  waf: {
    existingWebAclArn: 'arn:aws:wafv2:us-east-1:123456789:global/webacl/my-acl/...',
  },
});
```

### CloudFront Logging

```typescript
new OpenNextCdk(stack, 'NextApp', {
  openNextPath: path.join(__dirname, '..', '.open-next'),
  cloudfrontLogs: {
    enabled: true,
    logRetention: 14,
  },
});
```

## API Reference

### `OpenNextCdk`

**Props** (`OpenNextCdkProps`):

| Prop | Type | Required | Default | Description |
|---|---|---|---|---|
| `openNextPath` | `string` | Yes | — | Path to `.open-next` build output |
| `prefix` | `string` | No | `'opennext'` | Prefix for resource naming |
| `serverFunction` | `LambdaFunctionOptions` | No | — | Server Lambda overrides |
| `imageOptimizationFunction` | `LambdaFunctionOptions` | No | — | Image optimization Lambda overrides |
| `splitFunctions` | `Record<string, LambdaFunctionOptions>` | No | — | Per-split-function overrides |
| `distribution` | `DistributionOptions` | No | — | CloudFront distribution options |
| `waf` | `WafOptions` | No | `{ enabled: true }` | WAF options |
| `dns` | `DnsOptions` | No | — | Route 53 DNS options |
| `warmer` | `WarmerOptions` | No | `{ enabled: false }` | Warmer options |
| `cloudfrontLogs` | `CloudFrontLogsOptions` | No | `{ enabled: false }` | CloudFront logs options |
| `revalidation` | `RevalidationQueueOptions` | No | — | Revalidation queue options |
| `tagCache` | `TagCacheOptions` | No | — | DynamoDB tag cache options |
| `assetsBucket` | `s3.IBucket` | No | — | Existing S3 bucket |
| `assetsRemovalPolicy` | `RemovalPolicy` | No | `DESTROY` | Removal policy for assets bucket |

**Exposed Properties**:

| Property | Type | Description |
|---|---|---|
| `bucket` | `s3.IBucket` | The S3 assets bucket |
| `distribution` | `cloudfront.IDistribution` | The CloudFront distribution |
| `serverFunctions` | `Map<string, lambda.IFunction>` | Server Lambdas, keyed by origin name |
| `imageOptimizationFunction` | `lambda.IFunction` | The image optimization Lambda |
| `revalidationFunction` | `lambda.IFunction` | The revalidation consumer Lambda |
| `revalidationQueue` | `sqs.IQueue` | The SQS FIFO revalidation queue |
| `tagCacheTable` | `dynamodb.ITable \| undefined` | The DynamoDB tag cache table |
| `warmerFunction` | `lambda.IFunction \| undefined` | The warmer Lambda |
| `url` | `string` | The CloudFront distribution URL |

### `LambdaFunctionOptions`

| Prop | Type | Default | Description |
|---|---|---|---|
| `memorySize` | `number` | Varies | Memory size in MB |
| `timeout` | `number` | Varies | Timeout in seconds |
| `architecture` | `string` | `'arm64'` | `'arm64'` or `'x86_64'` |
| `environment` | `Record<string, string>` | — | Additional env vars |
| `runtime` | `string` | `'nodejs20.x'` | Lambda runtime |
| `existingFunction` | `lambda.IFunction` | — | Use an existing Lambda |
| `logRetention` | `number` | `30` | Log retention in days |

### `DistributionOptions`

| Prop | Type | Default | Description |
|---|---|---|---|
| `domainNames` | `string[]` | — | Custom domain names |
| `certificate` | `acm.ICertificate` | — | ACM certificate |
| `priceClass` | `string` | `'PriceClass_100'` | CloudFront price class |
| `cors` | `boolean` | `false` | Enable CORS headers |
| `corsAllowOrigins` | `string[]` | `['*']` | CORS allow origins |
| `hsts` | `boolean` | `true` | Enable HSTS |
| `hstsMaxAge` | `number` | `63072000` | HSTS max-age (2 years) |
| `cachePolicyOptions` | `CachePolicyOptions` | — | Cache policy overrides |
| `additionalBehaviors` | `Record<string, BehaviorOptions>` | — | Extra CF behaviors |
| `geoRestrictionLocations` | `string[]` | — | Geo restriction allowlist |

## How It Works

1. **Build**: Run `npx @opennextjs/aws build` to produce the `.open-next` directory
2. **Manifest**: The construct reads `open-next.output.json` at CDK synth time
3. **Origins**: Each origin in the manifest becomes a Lambda function with a Function URL
4. **Behaviors**: CloudFront behaviors are created from the manifest's behavior list
5. **Wiring**: Environment variables and IAM permissions are automatically configured

### Environment Variables (auto-injected)

Server functions receive:
- `CACHE_BUCKET_NAME` / `CACHE_BUCKET_KEY_PREFIX` / `CACHE_BUCKET_REGION`
- `REVALIDATION_QUEUE_URL` / `REVALIDATION_QUEUE_REGION`
- `CACHE_DYNAMO_TABLE` (when tag cache is enabled)
- `OPEN_NEXT_ORIGIN` (JSON map of split function URLs)

### CloudFront Cache Policy

The custom cache policy includes Next.js-specific headers in the cache key:
- `rsc`
- `next-router-prefetch`
- `next-router-state-tree`
- `x-prerender-revalidate`
- `next-url`

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
