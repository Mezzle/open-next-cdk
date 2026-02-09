import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import {
  DEFAULT_IMAGE_OPTIMIZATION_MEMORY_SIZE,
  DEFAULT_IMAGE_OPTIMIZATION_TIMEOUT_SECONDS,
  DEFAULT_LAMBDA_ARCHITECTURE,
  DEFAULT_LAMBDA_RUNTIME,
  DEFAULT_LOG_RETENTION_DAYS,
} from '../constants';
import { getImageOptBundlePath } from '../manifest-reader';
import type { LambdaFunctionOptions } from '../types';
import { resourceName } from '../utils';

export type ImageOptimizationProps = {
  readonly prefix: string;
  readonly openNextPath: string;
  readonly bucket: s3.IBucket;
  readonly functionOptions?: LambdaFunctionOptions;
  /**
   * S3 key prefix where assets are stored. Used as BUCKET_KEY_PREFIX env var.
   * Defaults to '' for backwards compatibility with older OpenNext manifests.
   */
  readonly assetKeyPrefix?: string;
};

/**
 * Creates the image optimization Lambda function with a Function URL.
 * Uses arm64 architecture and 512MB memory by default for cost-effective
 * image processing.
 */
export class ImageOptimization extends Construct {
  public readonly function: lambda.IFunction;
  public readonly functionUrl: lambda.FunctionUrl;

  public constructor(
    scope: Construct,
    id: string,
    props: ImageOptimizationProps,
  ) {
    super(scope, id);

    const fnOpts = props.functionOptions;

    if (fnOpts?.existingFunction) {
      this.function = fnOpts.existingFunction;
      this.functionUrl = (this.function as lambda.Function).addFunctionUrl({
        authType: lambda.FunctionUrlAuthType.NONE,
      });
      return;
    }

    const architecture =
      (fnOpts?.architecture ?? DEFAULT_LAMBDA_ARCHITECTURE) === 'x86_64'
        ? lambda.Architecture.X86_64
        : lambda.Architecture.ARM_64;
    const runtime =
      (fnOpts?.runtime ?? DEFAULT_LAMBDA_RUNTIME) === 'nodejs22.x'
        ? lambda.Runtime.NODEJS_22_X
        : lambda.Runtime.NODEJS_20_X;

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: fnOpts?.logRetention ?? DEFAULT_LOG_RETENTION_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'Function', {
      functionName: resourceName(props.prefix, 'image-optimization'),
      runtime,
      architecture,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(getImageOptBundlePath(props.openNextPath)),
      memorySize: fnOpts?.memorySize ?? DEFAULT_IMAGE_OPTIMIZATION_MEMORY_SIZE,
      timeout: cdk.Duration.seconds(
        fnOpts?.timeout ?? DEFAULT_IMAGE_OPTIMIZATION_TIMEOUT_SECONDS,
      ),
      environment: {
        BUCKET_NAME: props.bucket.bucketName,
        BUCKET_KEY_PREFIX: props.assetKeyPrefix ?? '',
        ...fnOpts?.environment,
      },
      logGroup,
      tracing:
        fnOpts?.enableTracing === false
          ? lambda.Tracing.DISABLED
          : lambda.Tracing.ACTIVE,
      ...(fnOpts?.reservedConcurrentExecutions != null
        ? { reservedConcurrentExecutions: fnOpts.reservedConcurrentExecutions }
        : {}),
      ...(fnOpts?.vpc ? { vpc: fnOpts.vpc } : {}),
      ...(fnOpts?.vpcSubnets ? { vpcSubnets: fnOpts.vpcSubnets } : {}),
    });

    // Image optimization only needs read access to the S3 bucket
    props.bucket.grantRead(fn);

    this.functionUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    this.function = fn;
  }
}
