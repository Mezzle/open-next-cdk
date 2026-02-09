import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import {
  DEFAULT_LAMBDA_ARCHITECTURE,
  DEFAULT_LAMBDA_RUNTIME,
  DEFAULT_LOG_RETENTION_DAYS,
  DEFAULT_REVALIDATION_MEMORY_SIZE,
  DEFAULT_REVALIDATION_TIMEOUT_SECONDS,
} from '../constants';
import { getRevalidationBundlePath } from '../manifest-reader';
import type { RevalidationQueueOptions } from '../types';
import { resourceName } from '../utils';

export type RevalidationProps = {
  readonly prefix: string;
  readonly openNextPath: string;
  readonly bucket: s3.IBucket;
  readonly tagCacheTable?: dynamodb.ITable;
  readonly options?: RevalidationQueueOptions;
};

/**
 * Creates the SQS FIFO queue for ISR revalidation and a Lambda consumer
 * that processes revalidation messages.
 */
export class Revalidation extends Construct {
  public readonly queue: sqs.IQueue;
  public readonly dlq: sqs.IQueue;
  public readonly function: lambda.IFunction;

  public constructor(scope: Construct, id: string, props: RevalidationProps) {
    super(scope, id);

    // KMS key for SQS encryption
    const encryptionKey =
      props.options?.encryptionKey ??
      new kms.Key(this, 'QueueKey', {
        description: `${resourceName(props.prefix, 'revalidation')} SQS encryption key`,
        enableKeyRotation: true,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

    // Dead letter queue
    const dlq = new sqs.Queue(this, 'DLQ', {
      queueName: `${resourceName(props.prefix, 'revalidation-dlq')}.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      encryptionMasterKey: encryptionKey,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.dlq = dlq;

    // SQS FIFO queue
    this.queue = new sqs.Queue(this, 'Queue', {
      queueName: `${resourceName(props.prefix, 'revalidation')}.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      encryptionMasterKey: encryptionKey,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(1),
      visibilityTimeout: cdk.Duration.seconds(
        (props.options?.functionOptions?.timeout ??
          DEFAULT_REVALIDATION_TIMEOUT_SECONDS) * 6,
      ),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    // Revalidation consumer Lambda
    const fnOpts = props.options?.functionOptions;
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
      functionName: resourceName(props.prefix, 'revalidation'),
      runtime,
      architecture,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        getRevalidationBundlePath(props.openNextPath),
      ),
      memorySize: fnOpts?.memorySize ?? DEFAULT_REVALIDATION_MEMORY_SIZE,
      timeout: cdk.Duration.seconds(
        fnOpts?.timeout ?? DEFAULT_REVALIDATION_TIMEOUT_SECONDS,
      ),
      environment: {
        CACHE_BUCKET_NAME: props.bucket.bucketName,
        CACHE_BUCKET_KEY_PREFIX: '_cache',
        CACHE_BUCKET_REGION: cdk.Stack.of(this).region,
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
    });

    // Grant permissions
    props.bucket.grantReadWrite(fn);
    if (props.tagCacheTable) {
      props.tagCacheTable.grantReadWriteData(fn);
      fn.addEnvironment('CACHE_DYNAMO_TABLE', props.tagCacheTable.tableName);
    }

    // SQS event source mapping
    fn.addEventSource(
      new lambdaEventSources.SqsEventSource(this.queue, {
        batchSize: 5,
        reportBatchItemFailures: true,
      }),
    );

    this.function = fn;
  }
}
