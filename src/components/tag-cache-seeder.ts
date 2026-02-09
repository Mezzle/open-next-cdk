import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import {
  DEFAULT_LAMBDA_ARCHITECTURE,
  DEFAULT_LAMBDA_RUNTIME,
  DEFAULT_LOG_RETENTION_DAYS,
  DEFAULT_SEEDER_MEMORY_SIZE,
  DEFAULT_SEEDER_TIMEOUT_SECONDS,
} from '../constants';
import { getDynamoDbProviderBundlePath } from '../manifest-reader';
import type { LambdaFunctionOptions } from '../types';
import { resourceName } from '../utils';

export type TagCacheSeederProps = {
  readonly prefix: string;
  readonly openNextPath: string;
  readonly tagCacheTable: dynamodb.ITable;
  readonly functionOptions?: LambdaFunctionOptions;
};

/**
 * Creates a Custom Resource that seeds the DynamoDB tag cache table on each deploy.
 *
 * The OpenNext build produces a `dynamodb-provider` bundle containing a
 * `dynamodb-cache.json` file with pre-computed tag/path mappings. This component
 * deploys a Lambda that reads that JSON and batch-writes items into the tag cache
 * table, ensuring ISR tag-based revalidation works from the first request.
 */
export class TagCacheSeeder extends Construct {
  public readonly function: lambda.IFunction;

  public constructor(scope: Construct, id: string, props: TagCacheSeederProps) {
    super(scope, id);

    const fnOpts = props.functionOptions;
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
      functionName: resourceName(props.prefix, 'tag-cache-seeder'),
      runtime,
      architecture,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        getDynamoDbProviderBundlePath(props.openNextPath),
      ),
      memorySize: fnOpts?.memorySize ?? DEFAULT_SEEDER_MEMORY_SIZE,
      timeout: cdk.Duration.seconds(
        fnOpts?.timeout ?? DEFAULT_SEEDER_TIMEOUT_SECONDS,
      ),
      environment: {
        CACHE_DYNAMO_TABLE: props.tagCacheTable.tableName,
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

    props.tagCacheTable.grantReadWriteData(fn);

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: fn,
    });

    new cdk.CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      // Change properties on every deploy to trigger the seeder
      properties: {
        deployTimestamp: Date.now().toString(),
      },
    });

    this.function = fn;
  }
}
