import type * as cdk from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as route53 from 'aws-cdk-lib/aws-route53';
import type * as s3 from 'aws-cdk-lib/aws-s3';

// ─── OpenNext Manifest Types (open-next.output.json) ───────────────────────

/**
 * Represents the full open-next.output.json manifest produced by
 * `npx @opennextjs/aws build`.
 */
export type OpenNextManifest = {
  readonly version?: string;
  readonly routes?: OpenNextRoute[];
  readonly origins: Record<string, OpenNextOrigin>;
  readonly behaviors: OpenNextBehavior[];
  readonly additionalProps?: OpenNextAdditionalProps;
  readonly edgeFunctions?: Record<string, OpenNextEdgeFunction>;
};

/**
 * Typed representation of the `additionalProps` section of the OpenNext manifest.
 */
export type OpenNextAdditionalProps = {
  readonly disableTagCache?: boolean;
  readonly disableIncrementalCache?: boolean;
  readonly initializationFunction?: OpenNextBaseFunction;
  readonly warmer?: OpenNextBaseFunction;
  readonly revalidationFunction?: OpenNextBaseFunction;
};

/**
 * A function entry in the OpenNext manifest (handler + bundle path).
 */
export type OpenNextBaseFunction = {
  readonly handler: string;
  readonly bundle: string;
};

/**
 * An edge function entry in the OpenNext manifest.
 */
export type OpenNextEdgeFunction = {
  readonly handler: string;
  readonly bundle: string;
  readonly pathResolver?: string;
};

export type OpenNextRoute = {
  readonly regex: string;
  readonly origin: string;
};

export type OpenNextOrigin = {
  readonly type: string;
  readonly copy?: OpenNextCopyEntry[];
  readonly handler?: string;
  readonly bundle?: string;
  readonly streaming?: boolean;
  readonly wrapper?: string;
  readonly converter?: string;
  /**
   * S3 origin path prefix. When set, CloudFront prepends this path to all
   * requests routed to the S3 origin. Produced by OpenNext v3.x builds.
   * @example '_assets'
   */
  readonly originPath?: string;
};

export type OpenNextCopyEntry = {
  readonly from: string;
  readonly to: string;
  readonly cached: boolean;
  readonly versionedSubDir?: string;
};

export type OpenNextBehavior = {
  readonly pattern: string;
  readonly origin?: string;
  readonly edgeFunction?: string;
};

// ─── Construct Props ─────────────────────────────────────────────────────────

/**
 * Options for overriding Lambda function defaults.
 * JSII-compatible: no enums, no arrow functions, no generics in public API.
 */
export type LambdaFunctionOptions = {
  /**
   * Memory size in MB.
   */
  readonly memorySize?: number;

  /**
   * Timeout in seconds.
   */
  readonly timeout?: number;

  /**
   * Lambda architecture. Use 'arm64' or 'x86_64'.
   * @default 'arm64'
   */
  readonly architecture?: string;

  /**
   * Additional environment variables to inject.
   */
  readonly environment?: Record<string, string>;

  /**
   * Lambda runtime.
   * @default 'nodejs20.x'
   */
  readonly runtime?: string;

  /**
   * Existing Lambda function to use instead of creating one.
   * When provided, most other options are ignored.
   */
  readonly existingFunction?: lambda.IFunction;

  /**
   * Log retention in days.
   * @default 30
   */
  readonly logRetention?: number;

  /**
   * Enable AWS X-Ray active tracing.
   * @default true
   */
  readonly enableTracing?: boolean;

  /**
   * Reserved concurrent executions for this function.
   */
  readonly reservedConcurrentExecutions?: number;

  /**
   * VPC security groups, subnets — passed through to Lambda.
   */
  readonly vpc?: cdk.aws_ec2.IVpc;
  readonly vpcSubnets?: cdk.aws_ec2.SubnetSelection;
};

export type DistributionOptions = {
  /**
   * Custom domain names for the CloudFront distribution.
   */
  readonly domainNames?: string[];

  /**
   * ACM certificate for the custom domain names.
   * Required if domainNames is provided.
   */
  readonly certificate?: acm.ICertificate;

  /**
   * CloudFront price class.
   * @default 'PriceClass_100'
   */
  readonly priceClass?: string;

  /**
   * Enable CORS headers in response headers policy.
   * @default false
   */
  readonly cors?: boolean;

  /**
   * Access-Control-Allow-Origins for CORS.
   * Only used when cors is true.
   */
  readonly corsAllowOrigins?: string[];

  /**
   * Enable HSTS via response headers policy.
   * @default true
   */
  readonly hsts?: boolean;

  /**
   * HSTS max-age in seconds.
   * @default 63072000 (2 years)
   */
  readonly hstsMaxAge?: number;

  /**
   * Custom cache policy overrides for the server behavior.
   */
  readonly cachePolicyOptions?: CachePolicyOptions;

  /**
   * Additional CloudFront behaviors to add beyond the manifest-driven ones.
   */
  readonly additionalBehaviors?: Record<string, cloudfront.BehaviorOptions>;

  /**
   * Existing CloudFront distribution to use instead of creating one.
   */
  readonly existingDistribution?: cloudfront.IDistribution;

  /**
   * Geographic restrictions (allowlist).
   */
  readonly geoRestrictionLocations?: string[];
};

export type CachePolicyOptions = {
  /**
   * Default TTL in seconds.
   * @default 0
   */
  readonly defaultTtl?: number;

  /**
   * Maximum TTL in seconds.
   * @default 31536000 (1 year)
   */
  readonly maxTtl?: number;

  /**
   * Minimum TTL in seconds.
   * @default 0
   */
  readonly minTtl?: number;

  /**
   * Additional headers to include in the cache key.
   */
  readonly additionalHeaders?: string[];
};

export type WafOptions = {
  /**
   * Whether to create a WAF web ACL.
   * @default true
   */
  readonly enabled?: boolean;

  /**
   * ARN of an existing WAFv2 web ACL to associate with the CloudFront distribution.
   * When provided, no new web ACL is created.
   * Must be in us-east-1 for CloudFront.
   */
  readonly existingWebAclArn?: string;

  /**
   * Additional WAF rules beyond the 4 default managed rule groups.
   */
  readonly additionalRules?: cdk.aws_wafv2.CfnWebACL.RuleProperty[];
};

export type DnsOptions = {
  /**
   * Route 53 hosted zone for DNS records.
   */
  readonly hostedZone: route53.IHostedZone;

  /**
   * Record names to create (e.g., ['example.com', 'www.example.com']).
   * Defaults to the distribution's domain names.
   */
  readonly recordNames?: string[];

  /**
   * Whether to evaluate target health for alias records.
   * @default false
   */
  readonly evaluateTargetHealth?: boolean;
};

export type WarmerOptions = {
  /**
   * Whether to enable the warmer.
   * @default false
   */
  readonly enabled?: boolean;

  /**
   * EventBridge schedule expression.
   * @default 'rate(5 minutes)'
   */
  readonly schedule?: string;

  /**
   * Number of concurrent invocations per function.
   * @default 1
   */
  readonly concurrency?: number;

  /**
   * Lambda function overrides for the warmer function.
   */
  readonly functionOptions?: LambdaFunctionOptions;
};

export type CloudFrontLogsOptions = {
  /**
   * Whether to enable CloudFront logs.
   * @default false
   */
  readonly enabled?: boolean;

  /**
   * Existing S3 bucket for CloudFront logs.
   */
  readonly logBucket?: s3.IBucket;

  /**
   * CloudWatch log group retention in days.
   * @default 30
   */
  readonly logRetention?: number;

  /**
   * Lambda function overrides for the log forwarder function.
   */
  readonly functionOptions?: LambdaFunctionOptions;
};

export type RevalidationQueueOptions = {
  /**
   * KMS key for SQS encryption. If not provided, a new key is created.
   */
  readonly encryptionKey?: kms.IKey;

  /**
   * Lambda function overrides for the revalidation consumer function.
   */
  readonly functionOptions?: LambdaFunctionOptions;
};

export type InitializationFunctionOptions = {
  /**
   * Lambda function overrides for the tag cache seeder function.
   */
  readonly functionOptions?: LambdaFunctionOptions;
};

export type TagCacheOptions = {
  /**
   * Whether to disable the tag cache table.
   * @default false
   */
  readonly disabled?: boolean;

  /**
   * Existing DynamoDB table to use.
   */
  readonly existingTable?: dynamodb.ITable;

  /**
   * DynamoDB billing mode.
   * Use 'PAY_PER_REQUEST' or 'PROVISIONED'.
   * @default 'PAY_PER_REQUEST'
   */
  readonly billingMode?: string;
};

export type AlarmOptions = {
  /**
   * Enable CloudWatch alarms.
   * @default false
   */
  readonly enabled?: boolean;

  /**
   * SNS topic ARN for alarm notifications.
   */
  readonly snsTopicArn?: string;

  /**
   * DLQ message threshold.
   * @default 1
   */
  readonly dlqMessageThreshold?: number;

  /**
   * Lambda error threshold (count per 5min).
   * @default 5
   */
  readonly lambdaErrorThreshold?: number;

  /**
   * CloudFront 5xx error rate threshold (%).
   * @default 5
   */
  readonly cloudfront5xxThreshold?: number;
};

// ─── Top-Level Props ─────────────────────────────────────────────────────────

/**
 * Props for the OpenNextCdk L3 construct.
 */
export type OpenNextCdkProps = {
  /**
   * Path to the `.open-next` build output directory.
   * Must contain `open-next.output.json`.
   */
  readonly openNextPath: string;

  /**
   * Prefix for resource naming.
   * @default 'opennext'
   */
  readonly prefix?: string;

  /**
   * Lambda overrides for the server function(s).
   */
  readonly serverFunction?: LambdaFunctionOptions;

  /**
   * Lambda overrides for the image optimization function.
   */
  readonly imageOptimizationFunction?: LambdaFunctionOptions;

  /**
   * Per-split-function Lambda overrides keyed by function name from the manifest.
   */
  readonly splitFunctions?: Record<string, LambdaFunctionOptions>;

  /**
   * CloudFront distribution options.
   */
  readonly distribution?: DistributionOptions;

  /**
   * WAF options.
   */
  readonly waf?: WafOptions;

  /**
   * DNS options.
   */
  readonly dns?: DnsOptions;

  /**
   * Warmer options.
   */
  readonly warmer?: WarmerOptions;

  /**
   * CloudFront logs pipeline options.
   */
  readonly cloudfrontLogs?: CloudFrontLogsOptions;

  /**
   * Revalidation queue options.
   */
  readonly revalidation?: RevalidationQueueOptions;

  /**
   * Tag cache (DynamoDB) options.
   */
  readonly tagCache?: TagCacheOptions;

  /**
   * Initialization function (tag cache seeder) options.
   * When the manifest includes an initializationFunction, a Custom Resource
   * is created to seed the DynamoDB tag cache on each deploy.
   */
  readonly initializationFunction?: InitializationFunctionOptions;

  /**
   * CloudWatch alarm options.
   */
  readonly alarms?: AlarmOptions;

  /**
   * Existing S3 bucket for assets. If not provided, a new one is created.
   */
  readonly assetsBucket?: s3.IBucket;

  /**
   * Removal policy for the assets bucket.
   * @default DESTROY
   */
  readonly assetsRemovalPolicy?: cdk.RemovalPolicy;
};
