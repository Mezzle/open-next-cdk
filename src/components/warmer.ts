import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import {
  DEFAULT_LAMBDA_ARCHITECTURE,
  DEFAULT_LAMBDA_RUNTIME,
  DEFAULT_LOG_RETENTION_DAYS,
  DEFAULT_WARMER_CONCURRENCY,
  DEFAULT_WARMER_MEMORY_SIZE,
  DEFAULT_WARMER_SCHEDULE,
  DEFAULT_WARMER_TIMEOUT_SECONDS,
} from '../constants';
import { getWarmerBundlePath } from '../manifest-reader';
import type { WarmerOptions } from '../types';
import { resourceName } from '../utils';

export type WarmerProps = {
  readonly prefix: string;
  readonly openNextPath: string;
  readonly serverFunctions: Map<string, lambda.IFunction>;
  readonly options?: WarmerOptions;
};

/**
 * Creates a warmer Lambda function triggered by EventBridge on a schedule
 * to keep server Lambda functions warm and reduce cold starts.
 */
export class Warmer extends Construct {
  public readonly function?: lambda.IFunction;

  public constructor(scope: Construct, id: string, props: WarmerProps) {
    super(scope, id);

    if (!props.options?.enabled) {
      return;
    }

    const fnOpts = props.options.functionOptions;

    const architecture =
      (fnOpts?.architecture ?? DEFAULT_LAMBDA_ARCHITECTURE) === 'x86_64'
        ? lambda.Architecture.X86_64
        : lambda.Architecture.ARM_64;

    const runtime =
      (fnOpts?.runtime ?? DEFAULT_LAMBDA_RUNTIME) === 'nodejs22.x'
        ? lambda.Runtime.NODEJS_22_X
        : lambda.Runtime.NODEJS_20_X;

    const concurrency = props.options.concurrency ?? DEFAULT_WARMER_CONCURRENCY;

    // Build function name map for the warmer
    const functionNameMap: Record<string, string> = {};

    props.serverFunctions.forEach((fn, key) => {
      functionNameMap[key] = fn.functionName;
    });

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: fnOpts?.logRetention ?? DEFAULT_LOG_RETENTION_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'Function', {
      functionName: resourceName(props.prefix, 'warmer'),
      runtime,
      architecture,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(getWarmerBundlePath(props.openNextPath)),
      memorySize: fnOpts?.memorySize ?? DEFAULT_WARMER_MEMORY_SIZE,
      timeout: cdk.Duration.seconds(
        fnOpts?.timeout ?? DEFAULT_WARMER_TIMEOUT_SECONDS,
      ),
      environment: {
        FUNCTION_NAME: JSON.stringify(functionNameMap),
        CONCURRENCY: String(concurrency),
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

    // Grant invoke on all server functions
    for (const serverFn of props.serverFunctions.values()) {
      serverFn.grantInvoke(fn);
    }

    // EventBridge scheduled rule
    const schedule = props.options.schedule ?? DEFAULT_WARMER_SCHEDULE;

    const rule = new events.Rule(this, 'ScheduleRule', {
      ruleName: resourceName(props.prefix, 'warmer-schedule'),
      schedule: events.Schedule.expression(schedule),
    });

    rule.addTarget(new eventsTargets.LambdaFunction(fn));

    this.function = fn;
  }
}
