import * as cdk from 'aws-cdk-lib';
import type {
  CachePolicy,
  IOrigin,
  OriginRequestPolicy,
  ResponseHeadersPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import type { HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudfrontOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { HOST_HEADER_REWRITE_CODE } from '../cloudfront-functions/host-header-rewrite';
import {
  DEFAULT_CACHE_DEFAULT_TTL_SECONDS,
  DEFAULT_CACHE_MAX_TTL_SECONDS,
  DEFAULT_CACHE_MIN_TTL_SECONDS,
  DEFAULT_HSTS_MAX_AGE,
  DEFAULT_PRICE_CLASS,
  NEXT_CACHE_KEY_HEADERS,
} from '../constants';
import type { DistributionOptions, OpenNextManifest } from '../types';
import { resourceName } from '../utils';

export type DistributionComponentProps = {
  readonly prefix: string;
  readonly manifest: OpenNextManifest;
  readonly bucket: s3.IBucket;
  readonly serverFunctionUrls: Map<string, lambda.FunctionUrl>;
  readonly imageOptimizationFunctionUrl: lambda.FunctionUrl;
  readonly options?: DistributionOptions;
  readonly webAclArn?: string;
  readonly cloudfrontLogBucket?: s3.IBucket;
  /**
   * S3 origin path prefix from the manifest. When set, CloudFront prepends
   * this path to all requests routed to the S3 origin.
   */
  readonly s3OriginPath?: string;
};

/**
 * Creates the CloudFront distribution with manifest-driven cache behaviors.
 * Sets up:
 * - S3 origin with OAC for static assets
 * - Lambda URL origins for server + image optimization functions
 * - Custom cache policy with Next.js-specific headers
 * - CloudFront Function for Host → x-forwarded-host rewrite
 * - Response headers policy (CORS, HSTS)
 */
export class DistributionComponent extends Construct {
  public readonly distribution: cloudfront.Distribution;

  public constructor(
    scope: Construct,
    id: string,
    props: DistributionComponentProps,
  ) {
    super(scope, id);

    const opts = props.options ?? {};

    // ─── CloudFront Function for host header rewrite ───────────────────
    const cfFunction = this.createCloudFrontFunction(props);

    // ─── Cache Policy (Next.js-specific headers in cache key) ──────────
    const cachePolicy = this.createCachePolicy(opts, props);

    // ─── Origin Request Policy ─────────────────────────────────────────
    const originRequestPolicy = this.createOriginRequestPolicy(props);

    // ─── Response Headers Policy ───────────────────────────────────────
    const responseHeadersPolicy = this.createResponseHeadersPolicy(props, opts);

    // ─── S3 Origin with OAC ────────────────────────────────────────────
    const s3Origin = this.createS3Origin(props);

    // ─── Lambda URL Origins ────────────────────────────────────────────
    const serverOrigins = this.createServerOrigins(props);
    const defaultServerOrigin = serverOrigins.get('default');

    if (!defaultServerOrigin) {
      throw new Error(
        'Missing default server origin — this should never happen',
      );
    }

    const imageOptOrigin = this.createImageOptimOrigin(props);

    // ─── Build behaviors from manifest ─────────────────────────────────
    const serverBehaviorOptions = this.createServerBehaviorOptions(
      defaultServerOrigin,
      cachePolicy,
      originRequestPolicy,
      responseHeadersPolicy,
      cfFunction,
    );

    const additionalBehaviors = this.createAdditionalBehaviors(
      props,
      s3Origin,
      imageOptOrigin,
      cachePolicy,
      originRequestPolicy,
      cfFunction,
      serverOrigins,
      responseHeadersPolicy,
    );

    // Merge in user-provided additional behaviors
    if (opts.additionalBehaviors) {
      Object.assign(additionalBehaviors, opts.additionalBehaviors);
    }

    // ─── Price Class ───────────────────────────────────────────────────
    const priceClassMap: Record<string, cloudfront.PriceClass> = {
      PriceClass_100: cloudfront.PriceClass.PRICE_CLASS_100,
      PriceClass_200: cloudfront.PriceClass.PRICE_CLASS_200,
      PriceClass_All: cloudfront.PriceClass.PRICE_CLASS_ALL,
    };
    const priceClass =
      priceClassMap[opts.priceClass ?? DEFAULT_PRICE_CLASS] ??
      cloudfront.PriceClass.PRICE_CLASS_100;

    // ─── Geo restriction ───────────────────────────────────────────────
    const geoRestriction = opts.geoRestrictionLocations
      ? cloudfront.GeoRestriction.allowlist(...opts.geoRestrictionLocations)
      : undefined;

    // ─── Create Distribution ───────────────────────────────────────────
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: resourceName(props.prefix, 'distribution'),
      defaultBehavior: serverBehaviorOptions,
      additionalBehaviors,
      domainNames: opts.domainNames,
      certificate: opts.certificate,
      priceClass,
      webAclId: props.webAclArn,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      geoRestriction,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      ...(props.cloudfrontLogBucket
        ? {
            enableLogging: true,
            logBucket: props.cloudfrontLogBucket,
            logFilePrefix: 'cloudfront/',
          }
        : {}),
    });
  }

  private createAdditionalBehaviors(
    props: DistributionComponentProps,
    s3Origin: IOrigin,
    imageOptOrigin: HttpOrigin,
    cachePolicy: CachePolicy,
    originRequestPolicy: OriginRequestPolicy,
    cfFunction: cloudfront.Function,
    serverOrigins: Map<string, HttpOrigin>,
    responseHeadersPolicy: ResponseHeadersPolicy,
  ) {
    // Additional behaviors from manifest
    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {};

    for (const behavior of props.manifest.behaviors) {
      if (behavior.pattern === '*' || behavior.pattern === '/*') {
        // Default behavior — handled separately
        continue;
      }

      const originName = behavior.origin;

      if (originName === 's3') {
        // Static asset behavior
        additionalBehaviors[behavior.pattern] = {
          origin: s3Origin,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
        };
      } else if (originName === 'imageOptimizer') {
        // Image optimization behavior
        additionalBehaviors[behavior.pattern] = {
          origin: imageOptOrigin,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          cachePolicy,
          originRequestPolicy,
          compress: true,
          functionAssociations: [
            {
              function: cfFunction,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        };
      } else if (originName) {
        const splitOrigin = serverOrigins.get(originName);
        if (!splitOrigin) {
          continue;
        }
        // Split function behavior
        additionalBehaviors[behavior.pattern] = {
          origin: splitOrigin,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          cachePolicy,
          originRequestPolicy,
          responseHeadersPolicy,
          compress: true,
          functionAssociations: [
            {
              function: cfFunction,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        };
      }
    }
    return additionalBehaviors;
  }

  private createServerBehaviorOptions(
    defaultServerOrigin: HttpOrigin,
    cachePolicy: CachePolicy,
    originRequestPolicy: OriginRequestPolicy,
    responseHeadersPolicy: ResponseHeadersPolicy,
    cfFunction: cloudfront.Function,
  ) {
    const serverBehaviorOptions: cloudfront.BehaviorOptions = {
      origin: defaultServerOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
      cachePolicy,
      originRequestPolicy,
      responseHeadersPolicy,
      compress: true,
      functionAssociations: [
        {
          function: cfFunction,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        },
      ],
    };
    return serverBehaviorOptions;
  }

  private createImageOptimOrigin(props: DistributionComponentProps) {
    const imageOptDomain = cdk.Fn.select(
      2,
      cdk.Fn.split('/', props.imageOptimizationFunctionUrl.url),
    );

    return new cloudfrontOrigins.HttpOrigin(imageOptDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });
  }

  private createServerOrigins(props: DistributionComponentProps) {
    const serverOrigins = new Map<string, cloudfrontOrigins.HttpOrigin>();

    props.serverFunctionUrls.forEach((fnUrl, key) => {
      const domain = cdk.Fn.select(2, cdk.Fn.split('/', fnUrl.url));

      serverOrigins.set(
        key,
        new cloudfrontOrigins.HttpOrigin(domain, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
      );
    });

    return serverOrigins;
  }

  private createS3Origin(props: DistributionComponentProps) {
    return cloudfrontOrigins.S3BucketOrigin.withOriginAccessControl(
      props.bucket,
      props.s3OriginPath
        ? { originPath: `/${props.s3OriginPath}` }
        : undefined,
    );
  }

  private createResponseHeadersPolicy(
    props: DistributionComponentProps,
    opts: DistributionOptions,
  ) {
    const responseHeadersPolicyProps: cloudfront.ResponseHeadersPolicyProps = {
      responseHeadersPolicyName: resourceName(props.prefix, 'response-headers'),
      ...(opts.hsts !== false
        ? {
            securityHeadersBehavior: {
              strictTransportSecurity: {
                override: true,
                accessControlMaxAge: cdk.Duration.seconds(
                  opts.hstsMaxAge ?? DEFAULT_HSTS_MAX_AGE,
                ),
                includeSubdomains: true,
                preload: true,
              },
              contentTypeOptions: { override: true },
              frameOptions: {
                frameOption: cloudfront.HeadersFrameOption.DENY,
                override: true,
              },
              referrerPolicy: {
                referrerPolicy:
                  cloudfront.HeadersReferrerPolicy
                    .STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
                override: true,
              },
            },
          }
        : {}),
      ...(opts.cors
        ? {
            corsBehavior: {
              accessControlAllowOrigins: opts.corsAllowOrigins ?? ['*'],
              accessControlAllowHeaders: ['*'],
              accessControlAllowMethods: ['ALL'],
              accessControlAllowCredentials: false,
              originOverride: true,
            },
          }
        : {}),
    };

    return new cloudfront.ResponseHeadersPolicy(
      this,
      'ResponseHeadersPolicy',
      responseHeadersPolicyProps,
    );
  }

  private createCachePolicy(
    opts: DistributionOptions,
    props: DistributionComponentProps,
  ) {
    const cachePolicyOpts = opts.cachePolicyOptions ?? {};
    const additionalHeaders = cachePolicyOpts.additionalHeaders ?? [];

    return new cloudfront.CachePolicy(this, 'ServerCachePolicy', {
      cachePolicyName: resourceName(props.prefix, 'server-cache'),
      defaultTtl: cdk.Duration.seconds(
        cachePolicyOpts.defaultTtl ?? DEFAULT_CACHE_DEFAULT_TTL_SECONDS,
      ),
      maxTtl: cdk.Duration.seconds(
        cachePolicyOpts.maxTtl ?? DEFAULT_CACHE_MAX_TTL_SECONDS,
      ),
      minTtl: cdk.Duration.seconds(
        cachePolicyOpts.minTtl ?? DEFAULT_CACHE_MIN_TTL_SECONDS,
      ),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
        ...NEXT_CACHE_KEY_HEADERS,
        ...additionalHeaders,
      ),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.all(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
  }

  private createCloudFrontFunction(props: DistributionComponentProps) {
    return new cloudfront.Function(this, 'HostHeaderRewrite', {
      functionName: resourceName(props.prefix, 'host-rewrite'),
      code: cloudfront.FunctionCode.fromInline(HOST_HEADER_REWRITE_CODE),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });
  }

  private createOriginRequestPolicy(props: DistributionComponentProps) {
    return new cloudfront.OriginRequestPolicy(
      this,
      'ServerOriginRequestPolicy',
      {
        originRequestPolicyName: resourceName(
          props.prefix,
          'server-origin-request',
        ),
        headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
          'x-forwarded-host',
          'accept',
          'accept-language',
        ),
        queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
        cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
      },
    );
  }
}
