import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import type { DnsOptions } from '../types';

export type DnsProps = {
  readonly distribution: cloudfront.IDistribution;
  readonly options?: DnsOptions;
};

/**
 * Creates Route 53 A and AAAA alias records pointing to the CloudFront distribution.
 */
export class Dns extends Construct {
  public constructor(scope: Construct, id: string, props: DnsProps) {
    super(scope, id);

    if (!props.options) {
      return;
    }

    const { hostedZone, recordNames } = props.options;

    const target = route53.RecordTarget.fromAlias(
      new route53Targets.CloudFrontTarget(props.distribution),
    );

    const names = (() => {
      if (recordNames != null) {
        return recordNames;
      }

      return hostedZone.zoneName ? [hostedZone.zoneName] : [];
    })();

    for (let i = 0; i < names.length; i++) {
      const recordName = names[i];

      new route53.ARecord(this, `ARecord${i}`, {
        zone: hostedZone,
        recordName,
        target,
      });

      new route53.AaaaRecord(this, `AaaaRecord${i}`, {
        zone: hostedZone,
        recordName,
        target,
      });
    }
  }
}
