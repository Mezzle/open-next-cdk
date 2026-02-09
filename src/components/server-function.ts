import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import {
  DEFAULT_LAMBDA_ARCHITECTURE,
  DEFAULT_LAMBDA_RUNTIME,
  DEFAULT_LOG_RETENTION_DAYS,
  DEFAULT_SERVER_MEMORY_SIZE,
  DEFAULT_SERVER_TIMEOUT_SECONDS,
} from '../constants';
import { getFunctionBundlePath } from '../manifest-reader';
import type { LambdaFunctionOptions, OpenNextOrigin } from '../types';
import { resourceName } from '../utils';

export type ServerFunctionProps = {
  readonly prefix: string;
  readonly openNextPath: string;
  readonly originKey: string;
  readonly origin: OpenNextOrigin;
  readonly bucket: s3.IBucket;
  readonly revalidationQueue: sqs.IQueue;
  readonly tagCacheTable?: dynamodb.ITable;
  readonly functionOptions?: LambdaFunctionOptions;
  readonly disableIncrementalCache?: boolean;
};

/**
 * Creates a server Lambda function with a Function URL.
 * Supports both the default server function and split functions from the manifest.
 */
export class ServerFunction extends Construct {
  public readonly function: lambda.IFunction;
  public readonly functionUrl: lambda.FunctionUrl;

  public constructor(scope: Construct, id: string, props: ServerFunctionProps) {
    super(scope, id);

    const fnOpts = props.functionOptions;

    if (fnOpts?.existingFunction) {
      this.function = fnOpts.existingFunction;
      // Still create Function URL for existing functions
      this.functionUrl = (this.function as lambda.Function).addFunctionUrl({
        authType: lambda.FunctionUrlAuthType.NONE,
        invokeMode: props.origin.streaming
          ? lambda.InvokeMode.RESPONSE_STREAM
          : lambda.InvokeMode.BUFFERED,
      });

      return;
    }

    const architecture = this.getArchitecture(fnOpts?.architecture);

    const runtime = this.getRuntime(fnOpts?.runtime);

    const suffix = props.originKey === 'default' ? 'server' : props.originKey;

    const bundlePath =
      props.originKey === 'default'
        ? getFunctionBundlePath(props.openNextPath, 'default')
        : getFunctionBundlePath(props.openNextPath, props.originKey);

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: fnOpts?.logRetention ?? DEFAULT_LOG_RETENTION_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'Function', {
      functionName: resourceName(props.prefix, suffix),
      runtime,
      architecture,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(bundlePath),
      memorySize: fnOpts?.memorySize ?? DEFAULT_SERVER_MEMORY_SIZE,
      timeout: cdk.Duration.seconds(
        fnOpts?.timeout ?? DEFAULT_SERVER_TIMEOUT_SECONDS,
      ),
      environment: {
        ...(props.disableIncrementalCache
          ? {}
          : {
              CACHE_BUCKET_NAME: props.bucket.bucketName,
              CACHE_BUCKET_KEY_PREFIX: '_cache',
              CACHE_BUCKET_REGION: cdk.Stack.of(this).region,
            }),
        REVALIDATION_QUEUE_URL: props.revalidationQueue.queueUrl,
        REVALIDATION_QUEUE_REGION: cdk.Stack.of(this).region,
        ...(props.tagCacheTable
          ? { CACHE_DYNAMO_TABLE: props.tagCacheTable.tableName }
          : {}),
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

    // Grant permissions
    if (!props.disableIncrementalCache) {
      props.bucket.grantReadWrite(fn);
    }
    props.revalidationQueue.grantSendMessages(fn);

    if (props.tagCacheTable) {
      props.tagCacheTable.grantReadWriteData(fn);
    }

    // Function URL with no auth — CloudFront + WAF provide the security layer
    this.functionUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: props.origin.streaming
        ? lambda.InvokeMode.RESPONSE_STREAM
        : lambda.InvokeMode.BUFFERED,
    });

    this.function = fn;
  }

  private getRuntime(runtime?: string | undefined) {
    return (runtime ?? DEFAULT_LAMBDA_RUNTIME) === 'nodejs22.x'
      ? lambda.Runtime.NODEJS_22_X
      : lambda.Runtime.NODEJS_20_X;
  }

  private getArchitecture(architecture: string | undefined) {
    return (architecture ?? DEFAULT_LAMBDA_ARCHITECTURE) === 'x86_64'
      ? lambda.Architecture.X86_64
      : lambda.Architecture.ARM_64;
  }
}
