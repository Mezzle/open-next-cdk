import * as cdk from 'aws-cdk-lib';
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import type { AlarmOptions } from '../types';
import { resourceName } from '../utils';

export type AlarmsProps = {
  readonly prefix: string;
  readonly options?: AlarmOptions;
  readonly revalidationDlq: sqs.IQueue;
  readonly serverFunctions: Map<string, lambda.IFunction>;
  readonly revalidationFunction: lambda.IFunction;
  readonly distribution: cloudfront.IDistribution;
};

/**
 * Creates CloudWatch alarms for operational visibility:
 * - DLQ depth alarm for revalidation failures
 * - Lambda error alarms for server and revalidation functions
 * - CloudFront 5xx error rate alarm
 */
export class Alarms extends Construct {
  public constructor(scope: Construct, id: string, props: AlarmsProps) {
    super(scope, id);

    if (!props.options?.enabled) {
      return;
    }

    const opts = props.options;
    const snsAction = opts.snsTopicArn
      ? new cloudwatchActions.SnsAction(
          sns.Topic.fromTopicArn(this, 'AlarmTopic', opts.snsTopicArn),
        )
      : undefined;

    // ─── DLQ Depth Alarm ──────────────────────────────────────────────
    const dlqAlarm = new cloudwatch.Alarm(this, 'DlqDepthAlarm', {
      alarmName: resourceName(props.prefix, 'revalidation-dlq-depth'),
      alarmDescription:
        'Revalidation DLQ has messages — revalidation failures detected',
      metric: props.revalidationDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.seconds(300),
      }),
      threshold: opts.dlqMessageThreshold ?? 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    if (snsAction) {
      dlqAlarm.addAlarmAction(snsAction);
    }

    // ─── Server Lambda Error Alarms ───────────────────────────────────
    for (const [key, fn] of props.serverFunctions) {
      const suffix = key === 'default' ? 'server' : key;

      const alarm = new cloudwatch.Alarm(this, `ServerErrorAlarm-${suffix}`, {
        alarmName: resourceName(props.prefix, `${suffix}-errors`),
        alarmDescription: `Lambda errors on ${suffix} function`,
        metric: fn.metricErrors({
          period: cdk.Duration.seconds(300),
        }),
        threshold: opts.lambdaErrorThreshold ?? 5,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

      if (snsAction) {
        alarm.addAlarmAction(snsAction);
      }
    }

    // ─── Revalidation Lambda Error Alarm ──────────────────────────────
    const revalAlarm = new cloudwatch.Alarm(this, 'RevalidationErrorAlarm', {
      alarmName: resourceName(props.prefix, 'revalidation-errors'),
      alarmDescription: 'Lambda errors on revalidation function',
      metric: props.revalidationFunction.metricErrors({
        period: cdk.Duration.seconds(300),
      }),
      threshold: opts.lambdaErrorThreshold ?? 5,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    if (snsAction) {
      revalAlarm.addAlarmAction(snsAction);
    }

    // ─── CloudFront 5xx Error Rate Alarm ──────────────────────────────
    const cf5xxAlarm = new cloudwatch.Alarm(this, 'CloudFront5xxAlarm', {
      alarmName: resourceName(props.prefix, 'cloudfront-5xx-rate'),
      alarmDescription: 'CloudFront 5xx error rate exceeds threshold',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/CloudFront',
        metricName: '5xxErrorRate',
        dimensionsMap: {
          DistributionId: props.distribution.distributionId,
          Region: 'Global',
        },
        period: cdk.Duration.seconds(300),
        statistic: 'Average',
      }),
      threshold: opts.cloudfront5xxThreshold ?? 5,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    if (snsAction) {
      cf5xxAlarm.addAlarmAction(snsAction);
    }
  }
}
