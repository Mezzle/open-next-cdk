import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import {
  DEFAULT_LAMBDA_ARCHITECTURE,
  DEFAULT_LAMBDA_RUNTIME,
  DEFAULT_LOG_FORWARDER_MEMORY_SIZE,
  DEFAULT_LOG_FORWARDER_TIMEOUT_SECONDS,
  DEFAULT_LOG_RETENTION_DAYS,
} from '../constants';
import type { CloudFrontLogsOptions } from '../types';
import { resourceName } from '../utils';

export type CloudFrontLogsProps = {
  readonly prefix: string;
  readonly options?: CloudFrontLogsOptions;
};

/**
 * Creates the CloudFront access logs pipeline:
 * - S3 bucket for CloudFront standard logs
 * - Log forwarder Lambda that reads log files and writes to CloudWatch Logs
 * - CloudWatch Log Group for querying
 */
export class CloudFrontLogs extends Construct {
  public readonly logBucket?: s3.IBucket;
  public readonly forwarderFunction?: lambda.IFunction;

  public constructor(scope: Construct, id: string, props: CloudFrontLogsProps) {
    super(scope, id);

    if (!props.options?.enabled) {
      return;
    }

    const fnOpts = props.options.functionOptions;
    const logRetention =
      props.options.logRetention ?? DEFAULT_LOG_RETENTION_DAYS;

    // Log bucket
    this.logBucket = this.getLogBucket(props);

    // CloudWatch Log Group for forwarded logs
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/cloudfront/${resourceName(props.prefix, 'access-logs')}`,
      retention: logRetention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Log forwarder Lambda — reads S3 log files, writes to CloudWatch
    const architecture =
      (fnOpts?.architecture ?? DEFAULT_LAMBDA_ARCHITECTURE) === 'x86_64'
        ? lambda.Architecture.X86_64
        : lambda.Architecture.ARM_64;

    const runtime =
      (fnOpts?.runtime ?? DEFAULT_LAMBDA_RUNTIME) === 'nodejs22.x'
        ? lambda.Runtime.NODEJS_22_X
        : lambda.Runtime.NODEJS_20_X;

    // Separate log group for the forwarder Lambda's own runtime logs
    const forwarderLogGroup = new logs.LogGroup(this, 'ForwarderLogGroup', {
      retention: logRetention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.forwarderFunction = new lambda.Function(this, 'ForwarderFunction', {
      functionName: resourceName(props.prefix, 'cf-log-forwarder'),
      runtime,
      architecture,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { CloudWatchLogsClient, PutLogEventsCommand, CreateLogStreamCommand } = require('@aws-sdk/client-cloudwatch-logs');
const zlib = require('zlib');

const s3 = new S3Client({});
const cwl = new CloudWatchLogsClient({});

exports.handler = async (event) => {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\\+/g, ' '));
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const raw = await Body.transformToByteArray();
    const data = key.endsWith('.gz') ? zlib.gunzipSync(raw).toString() : Buffer.from(raw).toString();
    const lines = data.split('\\n').filter(l => l && !l.startsWith('#'));
    if (!lines.length) return;
    const streamName = new Date().toISOString().split('T')[0];
    try { await cwl.send(new CreateLogStreamCommand({ logGroupName: process.env.LOG_GROUP_NAME, logStreamName: streamName })); } catch (e) {}
    await cwl.send(new PutLogEventsCommand({
      logGroupName: process.env.LOG_GROUP_NAME,
      logStreamName: streamName,
      logEvents: lines.map(l => ({ timestamp: Date.now(), message: l })),
    }));
  }
};
`),
      memorySize: fnOpts?.memorySize ?? DEFAULT_LOG_FORWARDER_MEMORY_SIZE,
      timeout: cdk.Duration.seconds(
        fnOpts?.timeout ?? DEFAULT_LOG_FORWARDER_TIMEOUT_SECONDS,
      ),
      environment: {
        LOG_GROUP_NAME: logGroup.logGroupName,
        ...fnOpts?.environment,
      },
      logGroup: forwarderLogGroup,
      tracing:
        fnOpts?.enableTracing === false
          ? lambda.Tracing.DISABLED
          : lambda.Tracing.ACTIVE,
      ...(fnOpts?.reservedConcurrentExecutions != null
        ? { reservedConcurrentExecutions: fnOpts.reservedConcurrentExecutions }
        : {}),
    });

    // Grant permissions
    this.logBucket.grantRead(this.forwarderFunction);
    logGroup.grantWrite(this.forwarderFunction);

    // S3 event notification → Lambda
    this.forwarderFunction.addEventSource(
      new lambdaEventSources.S3EventSource(this.logBucket as s3.Bucket, {
        events: [s3.EventType.OBJECT_CREATED],
      }),
    );
  }

  private getLogBucket(props: CloudFrontLogsProps) {
    if (props.options?.logBucket) {
      return props.options.logBucket;
    }

    return new s3.Bucket(this, 'LogBucket', {
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
  }
}
