import * as cdk from 'aws-cdk-lib';
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import {
  Alarms,
  AssetDeployment,
  CloudFrontLogs,
  DistributionComponent,
  Dns,
  ImageOptimization,
  Revalidation,
  ServerFunction,
  TagCacheSeeder,
  TagCacheTable,
  Waf,
  Warmer,
} from './components';
import { DEFAULT_PREFIX } from './constants';
import {
  getSplitFunctionOrigins,
  getS3OriginPath,
  hasInitializationFunction,
  readManifest,
} from './manifest-reader';
import type { OpenNextCdkProps } from './types';
import { originKeyToSuffix } from './utils';

/**
 * OpenNextCdk — L3 CDK construct that deploys a Next.js application built
 * with OpenNext v3 to AWS using a serverless architecture.
 *
 * Architecture: CloudFront → Lambda Function URLs + S3, with SQS-based ISR
 * revalidation, DynamoDB tag cache, and optional WAF/DNS/warmer/logging.
 *
 * Usage:
 * ```ts
 * new OpenNextCdk(stack, 'MyApp', {
 *   openNextPath: path.join(__dirname, '..', '.open-next'),
 * });
 * ```
 */
export class OpenNextCdk extends Construct {
  /**
   * The S3 bucket holding static assets.
   */
  public readonly bucket: s3.IBucket;

  /**
   * The CloudFront distribution.
   */
  public readonly distribution: cloudfront.IDistribution;

  /**
   * Server Lambda functions, keyed by origin name ('default' for the main server).
   */
  public readonly serverFunctions: Map<string, lambda.IFunction>;

  /**
   * The image optimization Lambda function.
   */
  public readonly imageOptimizationFunction: lambda.IFunction;

  /**
   * The revalidation consumer Lambda function.
   */
  public readonly revalidationFunction: lambda.IFunction;

  /**
   * The SQS FIFO revalidation queue.
   */
  public readonly revalidationQueue: sqs.IQueue;

  /**
   * The DynamoDB tag cache table (v3 feature). Undefined if disabled.
   */
  public readonly tagCacheTable?: dynamodb.ITable;

  /**
   * The warmer Lambda function. Undefined if warmer is disabled.
   */
  public readonly warmerFunction?: lambda.IFunction;

  /**
   * The tag cache seeder Lambda function. Undefined if no initializationFunction
   * is declared in the manifest or if the tag cache is disabled.
   */
  public readonly tagCacheSeederFunction?: lambda.IFunction;

  /**
   * The URL of the CloudFront distribution.
   */
  public readonly url: string;

  public constructor(scope: Construct, id: string, props: OpenNextCdkProps) {
    super(scope, id);

    const prefix = props.prefix ?? DEFAULT_PREFIX;
    const manifest = readManifest(props.openNextPath);
    const s3OriginPath = getS3OriginPath(manifest);

    // ─── 1. Tag Cache (DynamoDB) ─────────────────────────────────────
    const disableTagCache =
      props.tagCache?.disabled === true ||
      manifest.additionalProps?.disableTagCache === true;

    const tagCache = new TagCacheTable(this, 'TagCache', {
      prefix,
      options: disableTagCache
        ? { ...props.tagCache, disabled: true }
        : props.tagCache,
    });
    this.tagCacheTable = tagCache.table;

    // ─── 2. WAF ──────────────────────────────────────────────────────
    const waf = new Waf(this, 'Waf', {
      prefix,
      options: props.waf,
    });

    // ─── 3. Assets Bucket + Revalidation (SQS + Lambda) ────────────────
    // The bucket is created first because both revalidation and server
    // functions need references to it for env vars and IAM grants.
    this.bucket = this.createAssetsBucket(props);

    const revalidation = new Revalidation(this, 'Revalidation', {
      prefix,
      openNextPath: props.openNextPath,
      bucket: this.bucket,
      tagCacheTable: this.tagCacheTable,
      options: props.revalidation,
    });
    this.revalidationFunction = revalidation.function;
    this.revalidationQueue = revalidation.queue;

    // ─── 3b. Tag Cache Seeder ────────────────────────────────────────
    if (this.tagCacheTable && hasInitializationFunction(manifest)) {
      const seeder = new TagCacheSeeder(this, 'TagCacheSeeder', {
        prefix,
        openNextPath: props.openNextPath,
        tagCacheTable: this.tagCacheTable,
        functionOptions: props.initializationFunction?.functionOptions,
      });
      this.tagCacheSeederFunction = seeder.function;
    }

    // ─── 3c. Edge Functions Warning ──────────────────────────────────
    if (
      manifest.edgeFunctions &&
      Object.keys(manifest.edgeFunctions).length > 0
    ) {
      cdk.Annotations.of(this).addWarningV2(
        '@open-next-cdk/edge-functions-unsupported',
        'Edge functions found in manifest but not yet supported. ' +
          'Behaviors referencing edge functions will be skipped.',
      );
    }

    // ─── 4. Server Functions ─────────────────────────────────────────
    const disableIncrementalCache =
      manifest.additionalProps?.disableIncrementalCache === true;

    this.serverFunctions = new Map<string, lambda.IFunction>();
    const serverFunctionUrls = new Map<string, lambda.FunctionUrl>();

    // Default server function
    const defaultOrigin = manifest.origins.default;
    const defaultServer = new ServerFunction(this, 'ServerFunction', {
      prefix,
      openNextPath: props.openNextPath,
      originKey: 'default',
      origin: defaultOrigin,
      bucket: this.bucket,
      revalidationQueue: this.revalidationQueue,
      tagCacheTable: this.tagCacheTable,
      functionOptions: props.serverFunction,
      disableIncrementalCache,
    });
    this.serverFunctions.set('default', defaultServer.function);
    serverFunctionUrls.set('default', defaultServer.functionUrl);

    // Split functions
    const splitOriginKeys = getSplitFunctionOrigins(manifest);
    for (const originKey of splitOriginKeys) {
      const origin = manifest.origins[originKey];
      if (origin.type !== 'function') {
        continue;
      }

      const suffix = originKeyToSuffix(originKey);
      const splitFnOpts = props.splitFunctions?.[originKey];

      const splitServer = new ServerFunction(this, `ServerFunction-${suffix}`, {
        prefix,
        openNextPath: props.openNextPath,
        originKey,
        origin,
        bucket: this.bucket,
        revalidationQueue: this.revalidationQueue,
        tagCacheTable: this.tagCacheTable,
        functionOptions: splitFnOpts,
        disableIncrementalCache,
      });
      this.serverFunctions.set(originKey, splitServer.function);
      serverFunctionUrls.set(originKey, splitServer.functionUrl);
    }

    // Inject OPEN_NEXT_ORIGIN env var into default server function
    // with URLs of split functions
    if (splitOriginKeys.length > 0) {
      const originMap: Record<string, { url: string }> = {};
      serverFunctionUrls.forEach((fnUrl, key) => {
        if (key !== 'default') {
          originMap[key] = { url: fnUrl.url };
        }
      });
      (defaultServer.function as lambda.Function).addEnvironment(
        'OPEN_NEXT_ORIGIN',
        cdk.Lazy.string({ produce: () => JSON.stringify(originMap) }),
      );
    }

    // ─── 5. Image Optimization ───────────────────────────────────────
    const imageOpt = new ImageOptimization(this, 'ImageOptimization', {
      prefix,
      openNextPath: props.openNextPath,
      bucket: this.bucket,
      functionOptions: props.imageOptimizationFunction,
      assetKeyPrefix: s3OriginPath,
    });
    this.imageOptimizationFunction = imageOpt.function;

    // ─── 6. CloudFront Logs (must be created before Distribution) ─────
    const cloudfrontLogs = new CloudFrontLogs(this, 'CloudFrontLogs', {
      prefix,
      options: props.cloudfrontLogs,
    });

    // ─── 7. CloudFront Distribution ──────────────────────────────────
    const distributionComponent = new DistributionComponent(
      this,
      'Distribution',
      {
        prefix,
        manifest,
        bucket: this.bucket,
        serverFunctionUrls,
        imageOptimizationFunctionUrl: imageOpt.functionUrl,
        options: props.distribution,
        webAclArn: waf.webAclArn,
        cloudfrontLogBucket: cloudfrontLogs.logBucket,
        s3OriginPath,
      },
    );
    this.distribution = distributionComponent.distribution;
    this.url = `https://${this.distribution.distributionDomainName}`;

    // ─── 8. S3 Asset Deployment ──────────────────────────────────────
    // Deploy assets after distribution is created so cache invalidation works
    new AssetDeployment(this, 'Assets', {
      openNextPath: props.openNextPath,
      manifest,
      bucket: this.bucket,
      distribution: this.distribution,
    });

    // ─── 9. CloudWatch Alarms ─────────────────────────────────────────
    new Alarms(this, 'Alarms', {
      prefix,
      options: props.alarms,
      revalidationDlq: revalidation.dlq,
      serverFunctions: this.serverFunctions,
      revalidationFunction: this.revalidationFunction,
      distribution: this.distribution,
    });

    // ─── 10. DNS ─────────────────────────────────────────────────────
    if (props.dns) {
      new Dns(this, 'Dns', {
        distribution: this.distribution,
        options: props.dns,
      });
    }

    // ─── 11. Warmer ──────────────────────────────────────────────────
    const warmer = new Warmer(this, 'Warmer', {
      prefix,
      openNextPath: props.openNextPath,
      serverFunctions: this.serverFunctions,
      options: props.warmer,
    });
    this.warmerFunction = warmer.function;

    // ─── Outputs ─────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront distribution domain name',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID',
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      description: 'S3 assets bucket name',
    });
  }

  private createAssetsBucket(props: OpenNextCdkProps): s3.IBucket {
    if (props.assetsBucket) {
      return props.assetsBucket;
    }

    const accessLogBucket = new s3.Bucket(this, 'AccessLogBucket', {
      bucketName: cdk.PhysicalName.GENERATE_IF_NEEDED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(90),
        },
      ],
    });

    return new s3.Bucket(this, 'AssetsBucket', {
      bucketName: cdk.PhysicalName.GENERATE_IF_NEEDED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: props.assetsRemovalPolicy ?? cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects:
        (props.assetsRemovalPolicy ?? cdk.RemovalPolicy.DESTROY) ===
        cdk.RemovalPolicy.DESTROY,
      serverAccessLogsBucket: accessLogBucket,
      serverAccessLogsPrefix: 'assets-bucket/',
    });
  }
}
